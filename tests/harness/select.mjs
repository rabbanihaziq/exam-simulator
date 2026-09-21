#!/usr/bin/env node
/* Selection test for multi-column / many-choice items.
 *
 *   node tests/harness/select.mjs "<questions.pdf>" "<answers.pdf>" <item>[,<item>…]
 *
 * Serves the repo the way run.mjs does, loads the REAL exam page
 * (docs/index.html), parses the two PDFs with window.parseExam and boots the
 * exam UI. For each item under test it then clicks — with Chrome's own mouse,
 * not a synthesised event — the centre of every choice's radio in turn, and
 * asserts the exam recorded the letter whose radio was clicked.
 *
 * Every item is tested twice, once per rendering path:
 *   text   the reflowed HTML choices (.copt)
 *   image  the positioned overlay rows, by clearing it.content — what any item
 *          whose page doesn't extract cleanly falls back to. The overlay divs
 *          are visual only (pointer-events: none); the app hit-tests the click
 *          against each choice's normalised `row` rect, so this is the test
 *          that a two-column row doesn't reach across its neighbour.
 *
 * It also checks the pure geometry of the `row` rects: every row has positive
 * area, no row contains another choice's radio centre, and rows sharing a
 * column don't overlap.
 *
 * Exits non-zero and prints every failure.
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.HARNESS_PORT || 8767);

const [qPdf, aPdf, itemArg] = process.argv.slice(2);
if (!qPdf || !aPdf || !itemArg) {
  console.error('usage: node select.mjs "<q.pdf>" "<a.pdf>" <item>[,<item>…]');
  process.exit(2);
}
const wanted = itemArg.split(",").map((s) => parseInt(s, 10));

const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".css":"text/css", ".json":"application/json", ".pdf":"application/pdf",
  ".png":"image/png", ".wasm":"application/wasm" };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  if (url === "/pdfs/q.pdf" || url === "/pdfs/a.pdf") {
    const f = url.endsWith("q.pdf") ? qPdf : aPdf;
    res.writeHead(200, { "content-type": "application/pdf",
                         "content-length": fs.statSync(f).size });
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

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  // an image-only PDF is OCR'd in the page; that one evaluate() call runs for
  // minutes and the 180s default protocol timeout would kill the run
  protocolTimeout: 0,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--window-size=1800,1300"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1250, deviceScaleFactor: 1 });
const logs = [];
page.on("console", (m) => logs.push(m.type() + ": " + m.text()));
page.on("pageerror", (e) => logs.push("pageerror: " + e.message));

await page.goto(`http://127.0.0.1:${PORT}/docs/index.html`, { waitUntil: "load" });
await page.waitForFunction("window.pdfjsLib && window.parseExam && window.boot",
                           { timeout: 60000 });

const sid = "seltest" + Date.now();
const parsed = await page.evaluate(async (sid, wanted) => {
  const bytes = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
  // keepPageImages so an item that parsed as text still has a page render to
  // fall back to when this test forces it into image mode
  const data = await window.parseExam(await bytes("/pdfs/q.pdf"),
                                      await bytes("/pdfs/a.pdf"), () => {},
                                      { keepPageImages: true });
  data.minutes = 0;
  data.sid = sid;
  window.__data = data;
  document.getElementById("landing").style.display = "none";
  document.getElementById("app").style.display = "flex";
  window.boot(data);
  return wanted.map((num) => {
    const idx = data.items.findIndex((it) => it.item === num);
    return { item: num, idx,
             letters: idx < 0 ? [] : data.items[idx].choices.map((c) => c.letter),
             hasImage: idx >= 0 && !!data.qURLs[idx] };
  });
}, sid, wanted);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const note = (s) => { fails.push(s); console.log("   " + s); };

/* ---- geometry of the normalised choice rows (what image mode hit-tests) -- */
const geom = await page.evaluate((wanted) => {
  const out = [];
  for (const num of wanted) {
    const it = window.__data.items.find((i) => i.item === num);
    if (!it) continue;
    const bad = [];
    it.choices.forEach((c) => {
      if (c.row[2] <= c.row[0] || c.row[3] <= c.row[1]) {
        bad.push(`${c.letter}: row has no area [${c.row.join(", ")}]`);
      }
    });
    it.choices.forEach((a) => {
      it.choices.forEach((b) => {
        if (a === b) return;
        if (b.radio[0] >= a.row[0] && b.radio[0] <= a.row[2] &&
            b.radio[1] >= a.row[1] && b.radio[1] <= a.row[3]) {
          bad.push(`${a.letter}'s row contains ${b.letter}'s radio centre`);
        }
      });
    });
    // rows in one column (same left edge) must not overlap vertically
    it.choices.forEach((a, i) => it.choices.slice(i + 1).forEach((b) => {
      if (Math.abs(a.row[0] - b.row[0]) > 0.02) return;
      if (Math.min(a.row[3], b.row[3]) - Math.max(a.row[1], b.row[1]) > 1e-4) {
        bad.push(`${a.letter} and ${b.letter} share a column and overlap`);
      }
    }));
    out.push({ item: num, n: it.choices.length, bad });
  }
  return out;
}, wanted);

console.log("— row geometry —");
for (const g of geom) {
  console.log(`item ${g.item}: ${g.n} choices — ${g.bad.length ? "FAIL" : "PASS"}`);
  g.bad.forEach(note);
}

/* ---- real clicks, both rendering paths ---------------------------------- */
console.log("\n— clicks —");
for (const p of parsed) {
  if (p.idx < 0) { note(`item ${p.item}: not found`); continue; }
  for (const mode of ["text", "image"]) {
    if (mode === "image" && !p.hasImage) {
      console.log(`item ${p.item} [image]: skipped — no page render`);
      continue;
    }
    await page.evaluate((idx, mode) => {
      const it = window.__data.items[idx];
      if (it.__saved === undefined) it.__saved = it.content;
      it.content = mode === "text" ? it.__saved : null;
      window.showItem(idx);
    }, p.idx, mode);
    // image mode lays the overlay out on the page render's load event
    const sel = mode === "text" ? "#qhtml .copt" : "#overlay .choice";
    try {
      await page.waitForFunction((sel, n) => {
        const els = document.querySelectorAll(sel);
        if (els.length !== n) return false;
        const r = els[0].getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      }, { timeout: 10000, polling: 100 }, sel, p.letters.length);
    } catch (e) {
      note(`item ${p.item} [${mode}]: ${p.letters.length} choice rows never laid out`);
      continue;
    }
    const order = await page.evaluate((sel) =>
      [...document.querySelectorAll(sel)].map((e) => e.dataset.letter), sel);

    const expected = p.letters.map((_, i) => String.fromCharCode(65 + i));
    const ordered = order.join("") === expected.join("");
    const before = fails.length;
    if (!ordered) note(`item ${p.item} [${mode}]: DOM order ${order.join(" ")}` +
                       ` is not ${expected.join(" ")}`);

    for (const L of p.letters) {
      const pt = await page.evaluate((idx, mode, L) => {
        const root = mode === "text" ? "#qhtml .copt" : "#overlay .choice";
        const el = [...document.querySelectorAll(root)]
          .find((e) => e.dataset.letter === L);
        if (!el) return { err: "no element" };
        // a long choice list runs off the bottom of the viewport
        el.scrollIntoView({ block: "center" });
        if (mode === "text") {
          const rad = el.querySelector(".cradio");
          if (!rad) return { err: "no radio" };
          const b = rad.getBoundingClientRect();
          if (b.width <= 0 || b.height <= 0) {
            return { err: `radio is ${b.width.toFixed(1)}x${b.height.toFixed(1)}` };
          }
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        // image mode: the overlay's .radio div is only painted for the chosen
        // answer (the page render already shows the circles), so aim at the
        // radio centre the parser recorded, which is what the app hit-tests
        const c = window.__data.items[idx].choices.find((c) => c.letter === L);
        const r = document.getElementById("overlay").getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return { err: "overlay has no size" };
        return { x: r.left + c.radio[0] * r.width,
                 y: r.top + c.radio[1] * r.height };
      }, p.idx, mode, L);
      if (pt.err) { note(`item ${p.item} [${mode}] ${L}: ${pt.err}`); continue; }
      await sleep(40);
      await page.mouse.click(pt.x, pt.y);
      await sleep(40);
      const got = await page.evaluate((sid, num) => {
        try {
          return (JSON.parse(localStorage.getItem("sa_exam_" + sid)) || {}).answers[num];
        } catch (e) { return "<unreadable state>"; }
      }, sid, p.item);
      if (got !== L) {
        note(`item ${p.item} [${mode}]: clicked ${L}'s radio, exam recorded ${got}`);
      }
    }
    console.log(`item ${p.item} [${mode}]: ${p.letters.length} choices, ` +
                `DOM order ${order.join(" ")} — ` +
                (fails.length === before ? "PASS" : "FAIL"));
  }
}

for (const l of logs) if (/pageerror/i.test(l)) console.log("console " + l);
await browser.close();
server.close();
console.log(fails.length ? `\n${fails.length} failure(s)` : "\nall selection cases pass");
process.exit(fails.length ? 1 : 0);
