#!/usr/bin/env node
/* Check-screen and safety-net test.
 *
 *   node tests/harness/checkscreen.mjs
 *
 * Drives the REAL page (docs/index.html) the way a user does: the PDFs are
 * handed to the two file inputs (File objects through a DataTransfer, then a
 * change event), "Start exam" is clicked, and everything after that is real
 * clicks with Chrome's own mouse. Scenarios:
 *
 *   clean   a form that parses cleanly: the check screen is one line, 50
 *           items, 50 keyed; the letter row answers and stays in sync with
 *           the clickable choices.
 *   dup     the clean form with page 6 made to claim item 5 (parseExam is
 *           wrapped in the page): numbers are reassigned by page order and
 *           only item 6 flags.
 *   broken  a form whose key isn't read: all 50 items flag as unkeyed; a key
 *           fix and a "removed" fix survive a reload of the page; the letter
 *           row records answers; review-mode key entry rescores live; the
 *           export uses the fixed keys, leaves the removed item out of the
 *           score and lists the fixes.
 *   prose   a prose key (made by tools/make_key_pdf.py) whose item 40 says
 *           "REMOVED QUESTION": item 40 flags as removed. Image-only, so the
 *           questions are OCR'd in the page (~150 s cold; use
 *           HARNESS_PROFILE to keep the OCR cache between runs). Skipped
 *           when PROSE_KEY is not set or missing.
 *
 * Inputs (environment):
 *   FORMS_DIR       folder holding "2 Surgery/" and "1 Internal Medicine/"
 *   PROSE_KEY       the key generated from "2 Surgery/2A.pdf"
 *   CS_OUT          where screenshots go (default: $TMPDIR/checkscreen)
 *   HARNESS_PORT    default 8791
 *   HARNESS_PROFILE a Chrome profile dir to reuse (keeps the OCR cache)
 *   ONLY            comma list of scenarios to run
 *
 * The PDFs are read from where they are; nothing is copied into the repo.
 * Exits non-zero on any failure.
 */

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.HARNESS_PORT || 8791);
const FORMS = process.env.FORMS_DIR ||
  path.join(os.homedir(), "Downloads/drive-download-20261002T233637Z-1-001");
const OUT = process.env.CS_OUT || path.join(os.tmpdir(), "checkscreen");
const ONLY = (process.env.ONLY || "clean,dup,broken,prose").split(",");
fs.mkdirSync(OUT, { recursive: true });

const PDFS = {
  s3q: path.join(FORMS, "2 Surgery/3 Q.pdf"),
  s3a: path.join(FORMS, "2 Surgery/3A.pdf"),
  m6q: path.join(FORMS, "1 Internal Medicine/6 Q.pdf"),
  m6a: path.join(FORMS, "1 Internal Medicine/6A.pdf"),
  s2q: path.join(FORMS, "2 Surgery/2 Q.pdf"),
  s2a: process.env.PROSE_KEY || "",
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".pdf": "application/pdf",
  ".png": "image/png", ".wasm": "application/wasm" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const m = url.match(/^\/pdfs\/(\w+)\.pdf$/);
  if (m && PDFS[m[1]] && fs.existsSync(PDFS[m[1]])) {
    const f = PDFS[m[1]];
    res.writeHead(200, { "content-type": "application/pdf", "content-length": fs.statSync(f).size });
    return fs.createReadStream(f).pipe(res);
  }
  const file = path.join(REPO, url);
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("no");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const launch = {
  executablePath: CHROME, headless: true,
  protocolTimeout: 0,   // in-page OCR of an image-only PDF runs for minutes
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1500,1100"],
};
if (process.env.HARNESS_PROFILE) launch.userDataDir = process.env.HARNESS_PROFILE;
const browser = await puppeteer.launch(launch);
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(m.type() + ": " + m.text()));
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
function check(ok, what, got) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}` + (ok || got === undefined ? "" : `  (got ${JSON.stringify(got)})`));
  if (!ok) fails++;
}

async function openPage(clearStorage) {
  await page.goto(`http://127.0.0.1:${PORT}/docs/index.html`, { waitUntil: "load" });
  await page.waitForFunction("window.pdfjsLib && window.parseExam && window.boot", { timeout: 60000 });
  if (clearStorage) await page.evaluate(() => localStorage.clear());
}

/* Hand the PDFs to the file inputs the way a drop does, then click Start. */
async function loadPdfs(q, a) {
  await page.evaluate(async (q, a) => {
    const put = async (id, url, name) => {
      const blob = await (await fetch(url)).blob();
      const dt = new DataTransfer();
      dt.items.add(new File([blob], name, { type: "application/pdf" }));
      const input = document.getElementById(id);
      input.files = dt.files;
      input.dispatchEvent(new Event("change"));
    };
    await put("file-q", `/pdfs/${q}.pdf`, "questions.pdf");
    if (a) await put("file-a", `/pdfs/${a}.pdf`, "answers.pdf");
  }, q, a);
  const t0 = Date.now();
  await page.click("#go");
  await page.waitForFunction(() => {
    const w = document.getElementById("checkWrap");
    return (w && w.style.display !== "none" && document.getElementById("checkCard").children.length) ||
      document.getElementById("err").style.display === "block";
  }, { timeout: 0, polling: 250 });
  const err = await page.$eval("#err", (e) => e.style.display === "block" ? e.textContent : "");
  if (err) throw new Error("load failed: " + err);
  return (Date.now() - t0) / 1000;
}

const stats = () => page.evaluate(() => ({
  count: DATA.count,
  keyed: DATA.items.filter((i) => i.answer_available).length,
  renumbered: DATA.renumbered,
  sid: DATA.sid,
  summary: (document.getElementById("ckSum") || {}).textContent || "",
  rows: [...document.querySelectorAll("#checkCard .ck-row")].map((r) => ({
    item: +r.querySelector(".ck-num").textContent.replace(/\D/g, ""),
    cls: r.classList.contains("need") ? "need" : r.classList.contains("fixed") ? "fixed" : "ok",
    msg: r.querySelector(".ck-msg").textContent,
  })),
  compact: document.getElementById("checkCard").classList.contains("ck-compact"),
}));

// a check-screen row by item number, plus an optional XPath tail inside it
const rowSel = (item, tail) =>
  `::-p-xpath(//div[contains(@class,"ck-row")][.//b[@class="ck-num" and text()="Item ${item}"]]${tail || ""})`;

async function startExam() {
  await page.click("#checkCard .ck-start");
  await page.waitForFunction(() => document.getElementById("app").style.display === "flex");
}
async function gotoItem(n) {   // by sidebar, like a user
  await page.click(`#sblist .sbrow:nth-child(${n})`);
  await sleep(150);
}
const answers = () => page.evaluate(() => (JSON.parse(localStorage.getItem("sa_exam_" + DATA.sid)) || {}).answers || {});

/* ======================================================================= */
if (ONLY.includes("clean")) {
  console.log("\n== clean: Surgery 3 ==");
  await openPage(true);
  const secs = await loadPdfs("s3q", "s3a");
  const s = await stats();
  console.log(`  parsed + checked in ${secs.toFixed(1)} s; summary: "${s.summary}"`);
  check(s.count === 50, "50 items", s.count);
  check(s.keyed === 50, "50 keyed", s.keyed);
  const need = s.compact ? 0 : s.rows.filter((r) => r.cls === "need").length;
  check(need <= 2, "zero or near-zero flags", s.rows.filter((r) => r.cls === "need"));
  check(s.compact === (need === 0), "no flags means the one-line confirmation");
  await page.screenshot({ path: path.join(OUT, "check_clean.png") });

  await startExam();
  await gotoItem(1);
  await page.click('#letterRow .lr-btn[data-letter="B"]');
  let a = await answers();
  check(a[1] === "B", "letter row B records item 1 = B", a[1]);
  check(await page.$eval('#qhtml .copt[data-letter="B"]', (e) => e.classList.contains("sel")),
        "the B choice shows selected after the letter button");
  await page.click('#qhtml .copt[data-letter="C"] .cradio');
  a = await answers();
  check(a[1] === "C", "clicking choice C records C", a[1]);
  check(await page.$eval('#letterRow .lr-btn[data-letter="C"]', (e) => e.classList.contains("sel")) &&
        !(await page.$eval('#letterRow .lr-btn[data-letter="B"]', (e) => e.classList.contains("sel"))),
        "letter row follows the clicked choice");
  // image mode: the letter row is there too
  await page.evaluate(() => { DATA.items[1].content = null; showItem(1); });
  await page.waitForFunction(() => document.querySelectorAll("#overlay .choice").length > 0, { timeout: 10000 });
  await page.click('#letterRow .lr-btn[data-letter="D"]');
  a = await answers();
  check(a[2] === "D", "image-mode item: letter row D records item 2 = D", a[2]);
  check(await page.$eval('#overlay .choice[data-letter="D"]', (e) => e.classList.contains("sel")),
        "image-mode overlay row D shows selected");
  await page.screenshot({ path: path.join(OUT, "letterrow_image_mode.png") });
}

/* ======================================================================= */
if (ONLY.includes("dup")) {
  // No form at hand repeats an item number, so make one: wrap parseExam so
  // the 6th page comes back claiming to be item 5, then go through the UI.
  console.log("\n== dup: Surgery 3 with page 6 read as item 5 ==");
  await openPage(true);
  await page.evaluate(() => {
    const orig = window.parseExam;
    window.parseExam = async (...args) => {
      const d = await orig(...args);
      d.items[5].item = 5;
      return d;
    };
  });
  await loadPdfs("s3q", "s3a");
  const s = await stats();
  const nums = await page.evaluate(() => DATA.items.map((i) => i.item));
  console.log(`  summary: "${s.summary}"`);
  check(s.renumbered === true, "renumbered by page order");
  check(nums.join(",") === Array.from({ length: 50 }, (_, i) => i + 1).join(","),
        "items numbered 1..50, no repeats", nums);
  const r6 = s.rows.find((r) => r.item === 6);
  check(s.rows.length === 1 && r6 && r6.cls === "need" && /also read as item 5/.test(r6.msg),
        "only item 6 flags, as a repeated number", s.rows);
  await page.screenshot({ path: path.join(OUT, "check_dup.png") });
}

/* ======================================================================= */
if (ONLY.includes("broken")) {
  console.log("\n== broken: Internal Medicine 6 (key not read) ==");
  await openPage(true);
  await loadPdfs("m6q", "m6a");
  let s = await stats();
  console.log(`  summary: "${s.summary}"`);
  check(s.count === 50, "50 items", s.count);
  check(s.keyed === 0, "0 keyed", s.keyed);
  check(s.rows.filter((r) => r.cls === "need").length === 50, "all 50 flag",
        s.rows.filter((r) => r.cls === "need").length);
  check(s.rows.every((r) => r.cls !== "need" || /No correct-answer letter/.test(r.msg) ||
        /\+\d+ more/.test(r.msg)), "flags say the key letter is missing");
  check(/^0 of 50 look good, 50 need a look/.test(s.summary), "summary line", s.summary);
  await page.screenshot({ path: path.join(OUT, "check_broken.png") });

  // fix: item 1 key C, item 2 removed
  await page.click(rowSel(1, '//div[@data-ck="toggle"]'));
  await page.click(rowSel(1, '//button[@data-key="C"]'));
  await page.click(rowSel(2, '//div[@data-ck="toggle"]'));
  await page.click(rowSel(2, '//input[@data-fix="removed"]'));
  s = await stats();
  check(/^2 of 50 look good, 48 need a look/.test(s.summary), "summary after two fixes", s.summary);
  await page.screenshot({ path: path.join(OUT, "check_broken_fixed.png") });
  const sid = s.sid;
  const saved = await page.evaluate((sid) => JSON.parse(localStorage.getItem("sa_fix_" + sid)), sid);
  check(saved && saved.items[1].key === "C" && saved.items[2].removed === true,
        "fixes saved under sa_fix_<fingerprint>", saved);

  // reload, load the same PDFs again: the fixes come back by themselves
  await openPage(false);
  await loadPdfs("m6q", "m6a");
  s = await stats();
  console.log(`  after reload: "${s.summary}"`);
  check(s.sid === sid, "same fingerprint after reload");
  check(/^2 of 50 look good, 48 need a look/.test(s.summary), "summary after reload", s.summary);
  const r1 = s.rows.find((r) => r.item === 1), r2 = s.rows.find((r) => r.item === 2);
  check(r1 && r1.cls === "fixed" && /key set to C/.test(r1.msg), "item 1 shows as fixed (key C)", r1);
  check(r2 && r2.cls === "fixed" && /removed/.test(r2.msg), "item 2 shows as fixed (removed)", r2);
  await page.screenshot({ path: path.join(OUT, "check_broken_reloaded.png") });

  await startExam();
  for (const [n, L] of [[1, "C"], [2, "B"], [3, "A"], [4, "D"]]) {
    await gotoItem(n);
    await page.click(`#letterRow .lr-btn[data-letter="${L}"]`);
  }
  const a = await answers();
  check(a[1] === "C" && a[2] === "B" && a[3] === "A" && a[4] === "D",
        "letter row recorded 1C 2B 3A 4D", a);
  const banner = await page.$eval("#unavail", (e) => e.style.display !== "none" ? e.textContent : "");
  check(/No answer-key letter/.test(banner), "unkeyed item shows the no-key banner", banner);

  await page.click("#endBtn");
  await page.waitForSelector("#endModal.open");
  await page.click("#confirmEnd");
  await page.waitForFunction(() => document.getElementById("reviewbar").style.display === "flex");
  const score = () => page.evaluate(() => [document.getElementById("scoreBig").textContent,
                                            document.getElementById("scoreSub").textContent]);
  let sc = await score();
  console.log(`  score at End Block: ${sc[0]} | ${sc[1]}`);
  check(sc[0] === "100%" && /^1 \/ 1 correct/.test(sc[1]) && /1 removed/.test(sc[1]),
        "scored out of 1 (item 2 removed, 48 unkeyed)", sc);

  // review: item 3 has no key; enter it from the page
  await gotoItem(3);
  const strip = await page.$eval("#resultstrip", (e) => e.textContent);
  check(/Correct answer per the page\?/.test(strip), "review asks 'Correct answer per the page?'", strip);
  await page.click('#resultstrip .kp-btn[data-key="A"]');
  await sleep(150);
  sc = await score();
  check(/^2 \/ 2 correct/.test(sc[1]) && sc[0] === "100%", "key A on item 3 rescores to 2/2", sc);
  await gotoItem(4);
  await page.click('#resultstrip .kp-btn[data-key="B"]');
  await sleep(150);
  sc = await score();
  check(/^2 \/ 3 correct/.test(sc[1]) && sc[0] === "67%", "key B on item 4 (answered D) rescores to 2/3", sc);
  check(/Incorrect/.test(await page.$eval("#resultstrip", (e) => e.textContent)),
        "item 4 now reviews as incorrect");
  await page.screenshot({ path: path.join(OUT, "review_key_entry.png") });

  // export
  await page.click("#exportBtn");
  await page.waitForFunction(() => {
    const v = document.getElementById("exportText").value;
    return v && !/^Building/.test(v);
  }, { timeout: 60000 });
  const md = await page.$eval("#exportText", (e) => e.value);
  const js = await page.evaluate(() => EXPORT.json);
  check(/Score \*\*2\/3 \(67%\)\*\*/.test(md), "export score 2/3 (67%)", md.split("\n")[1]);
  check(/\| 2 \| B \| — \| ⊘ Removed \|/.test(md), "export: item 2 removed");
  check(/\| 3 \| A \| A \| ✓ Correct \|/.test(md) && /\| 1 \| C \| C \| ✓ Correct \|/.test(md),
        "export: fixed keys used for items 1 and 3");
  check(/## Fixes applied/.test(md) && /- Item 1: key set to C/.test(md) &&
        /- Item 2: marked removed, not scored/.test(md) && /- Item 3: key set to A/.test(md) &&
        /- Item 4: key set to B/.test(md), "export lists the applied fixes");
  check(js.score.correct === 2 && js.score.scored === 3 && js.counts.removed === 1 &&
        js.fixes.length === 4, "export JSON score + fixes", { score: js.score, counts: js.counts, fixes: js.fixes.length });
  await page.click('#exportModal [data-close]');
}

/* ======================================================================= */
if (ONLY.includes("prose")) {
  console.log("\n== prose key: Surgery 2 (image-only questions, REMOVED item 40) ==");
  if (!PDFS.s2a || !fs.existsSync(PDFS.s2a)) {
    console.log("  SKIP  PROSE_KEY not set or missing (make it with tools/make_key_pdf.py)");
  } else {
    await openPage(true);
    const secs = await loadPdfs("s2q", "s2a");
    const s = await stats();
    console.log(`  parsed + checked in ${secs.toFixed(1)} s; summary: "${s.summary}"`);
    console.log(`  items ${s.count}, keyed ${s.keyed}, flagged: ` +
      s.rows.filter((r) => r.cls === "need").map((r) => r.item).join(","));
    const r40 = s.rows.find((r) => r.item === 40);
    check(r40 && r40.cls === "need" && /marks this question as removed/.test(r40.msg),
          "item 40 flags as removed", r40);
    await page.click(rowSel(40, '//div[@data-ck="toggle"]'));
    await sleep(300);
    const el = await page.$(rowSel(40));
    if (el) await el.screenshot({ path: path.join(OUT, "check_prose_item40.png") });
    await page.screenshot({ path: path.join(OUT, "check_prose.png") });
  }
}

for (const l of logs) if (/pageerror|^error: (?!Failed to load resource)/i.test(l)) console.log("console " + l);
await browser.close();
server.close();
console.log(`\nscreenshots: ${OUT}`);
console.log(fails ? `\n${fails} failure(s)` : "\nall checks pass");
process.exit(fails ? 1 : 0);
