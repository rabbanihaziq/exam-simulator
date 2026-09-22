#!/usr/bin/env node
/* Headless-Chrome harness for docs/parser.js.
 *
 *   node tests/harness/run.mjs "<questions.pdf>" "<answers.pdf>" <outdir>
 *
 * It serves the repo over http://127.0.0.1:8765 (pdf.js will not load as a
 * module from file://), opens a page that boots pdf.js and parser.js exactly
 * the way docs/index.html does, calls window.parseExam on the two PDFs, and
 * writes the parse out in a form that can be diffed and eyeballed:
 *
 *   items.json            every item's key, pages, mode, stem/choice text and
 *                         figure geometry (including each crop's pixel rect)
 *   item<N>_fig<k>.png    every figure crop the parser produced
 *   item<N>.png           side-by-side preview: the original page render on
 *                         the left, the text-mode HTML render on the right
 *   summary.txt           counts, per-item one-liners and the parse time
 *   progress.txt          every onProgress label the parse emitted
 *
 * Nothing here writes into docs/; the test page is synthesised by the server.
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.HARNESS_PORT || 8765);

// The answer key is optional (some forms are shared without one): pass "-"
// in its place, or leave it out and give the output directory second.
const argv = process.argv.slice(2);
let [qPdf, aPdf, outDir] = argv;
if (argv.length === 2) { outDir = aPdf; aPdf = null; }
if (aPdf === "-") aPdf = null;
if (!qPdf || !outDir) {
  console.error('usage: node run.mjs "<q.pdf>" ["<a.pdf>"|-] <outdir>');
  process.exit(2);
}

/* ------------------------------------------------------------------ */
/* the page under test: docs/index.html's module bootstrap, minus the  */
/* exam UI, plus a minimal copy of exam.js's renderQuestionHtml so a   */
/* preview shows what the app would actually draw.                     */
/* ------------------------------------------------------------------ */
const TEST_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>parser harness</title>
<style>
  body { margin:0; background:#fff; font-family:Arial,Helvetica,sans-serif; }
  .pv { display:flex; gap:12px; background:#fff; padding:10px;
        align-items:flex-start; width:1834px; }
  .pv > div { width:900px; flex:none; border:1px solid #d7dee6; background:#fff; }
  .pv .cap { font:600 12px/1.6 Arial; background:#eef2f7; color:#31435a;
             padding:2px 8px; border-bottom:1px solid #d7dee6; }
  .pv img.page { display:block; width:900px; height:auto; }
  /* --- copied from docs/exam.css so the right pane matches the app --- */
  .qhtml { padding:20px 24px 28px; font-family:Arial,Helvetica,sans-serif;
           font-size:15.5px; line-height:1.55; color:#1a2430; }
  .qpara { margin:0 0 14px; }
  .qfig { display:block; margin:6px 0 16px; max-width:100%; height:auto;
          border-radius:4px; }
  .qfig.fr { float:right; margin:0 0 14px 20px; }
  .copts { clear:both; margin-top:10px; display:flex; flex-direction:column; gap:2px; }
  .copt { display:flex; align-items:flex-start; gap:10px; padding:7px 10px;
          border-radius:6px; }
  .cradio { width:17px; height:17px; border:2px solid #556372; border-radius:50%;
            flex:none; margin-top:1px; background:#fff; }
  .clab { font-weight:600; flex:none; min-width:24px; }
  .w.i { font-style:italic; }
  .w.b { font-weight:700; }
  .imgmode { padding:20px 24px; color:#8b0000; font:600 14px Arial; }
</style>
<div id="preview"></div>
<script type="module">
  import * as pdfjsLib from "./pdfjs/pdf.min.mjs";
  pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdfjs/pdf.worker.min.mjs";
  window.pdfjsLib = pdfjsLib;
  window.__pdfjsReady = true;
</script>
<script src="parser.js"></script>
<script>
/* --- minimal copy of exam.js's render path (no highlighting/selection) --- */
function escHtml(s) {
  return s.replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
}
function renderRuns(runs) {
  return runs.map((r) => {
    let t = escHtml(r.text);
    if (r.sup) t = "<sup>" + t + "</sup>";
    else if (r.sub) t = "<sub>" + t + "</sub>";
    const cls = ["w"];
    if (r.i) cls.push("i");
    if (r.b) cls.push("b");
    return '<span class="' + cls.join(" ") + '">' + t + " </span>";
  }).join("");
}
window.__renderItemHtml = function (content) {
  if (!content) return '<div class="imgmode">image mode &mdash; no text content</div>';
  let html = "";
  content.blocks.forEach((b) => {
    if (b.t === "p") html += '<p class="qpara">' + renderRuns(b.runs) + "</p>";
    else if (b.fr) html += '<img class="qfig fr" src="' + b.url +
      '" style="width:' + (b.wf * 100).toFixed(2) + '%">';
    else html += '<img class="qfig" src="' + b.url + '" style="width:' +
      (b.wf * 100).toFixed(2) + "%;margin-left:" + (b.x0f * 100).toFixed(2) + '%">';
  });
  html += '<div class="copts">' + content.choices.map((c) =>
    '<div class="copt"><span class="cradio"></span><span class="clab">' +
    c.letter + ')</span><span class="ctext">' + renderRuns(c.runs) +
    "</span></div>").join("") + "</div>";
  return html;
};
window.__runsText = function (runs) {
  return (runs || []).map((r) => r.text).join(" ").replace(/\\s+/g, " ").trim();
};
window.__blobToDataURL = function (url) {
  return fetch(url).then((r) => r.blob()).then((b) => new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(b);
  }));
};
</script>
`;

/* ------------------------------------------------------------------ */
/* static server                                                       */
/* ------------------------------------------------------------------ */
const MIME = { ".html":"text/html", ".js":"text/javascript", ".mjs":"text/javascript",
  ".css":"text/css", ".json":"application/json", ".pdf":"application/pdf",
  ".png":"image/png", ".wasm":"application/wasm" };

function startServer() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/docs/__harness.html") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(TEST_PAGE);
    }
    if (url === "/pdfs/q.pdf" || (url === "/pdfs/a.pdf" && aPdf)) {
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
  return new Promise((r) => server.listen(PORT, "127.0.0.1", () => r(server)));
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */
const out = path.resolve(outDir);
await fsp.mkdir(out, { recursive: true });
const server = await startServer();
// HARNESS_PROFILE reuses a Chrome profile between runs, so the second run of
// an image-only PDF is served from the parser's IndexedDB OCR cache
const reuseProfile = process.env.HARNESS_PROFILE || null;
const userDataDir = reuseProfile ||
  await fsp.mkdtemp(path.join(process.env.TMPDIR || "/tmp", "harness-chrome-"));
if (reuseProfile) await fsp.mkdir(reuseProfile, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "shell" in puppeteer ? true : true,
  // an image-only PDF is OCR'd in the page; that one evaluate() call runs for
  // minutes and the 180s default protocol timeout would kill the run
  protocolTimeout: 0,
  userDataDir,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--allow-file-access-from-files",
         "--js-flags=--max-old-space-size=8192", "--window-size=2000,1400"],
});

const page = await browser.newPage();
await page.setViewport({ width: 1900, height: 1200, deviceScaleFactor: 1 });
const consoleLines = [];
page.on("console", (m) => consoleLines.push(m.type() + ": " + m.text()));
page.on("pageerror", (e) => consoleLines.push("pageerror: " + e.message));

await page.goto(`http://127.0.0.1:${PORT}/docs/__harness.html`, { waitUntil: "load" });
await page.waitForFunction("window.__pdfjsReady && window.parseExam", { timeout: 30000 });

console.log(`parsing\n  Q ${qPdf}\n  A ${aPdf || "(none — unscored)"}`);
const t0 = Date.now();
const summary = await page.evaluate(async (hasAnswers) => {
  const prog = [];
  const onProgress = (label, frac) => { prog.push([label, frac]); };
  const t = performance.now();
  const qb = new Uint8Array(await (await fetch("/pdfs/q.pdf")).arrayBuffer());
  const ab = hasAnswers
    ? new Uint8Array(await (await fetch("/pdfs/a.pdf")).arrayBuffer()) : null;
  const fetchMs = performance.now() - t;
  const t1 = performance.now();
  window.DATA = await window.parseExam(qb, ab, onProgress, { keepPageImages: true });
  const parseMs = performance.now() - t1;
  return { count: window.DATA.count, title: window.DATA.title,
           parseMs, fetchMs, prog, ocr: window.DATA.ocr || null,
           bandFallback: window.DATA.bandFallback || null };
}, Boolean(aPdf), { timeout: 0 });
const wallMs = Date.now() - t0;
console.log(`parsed ${summary.count} items in ${(summary.parseMs / 1000).toFixed(1)}s ` +
            `(wall ${(wallMs / 1000).toFixed(1)}s)`);

// ---- answer-key explanations (answerInfo) --------------------------------
const aInfo = await page.evaluate(async () => {
  const out = [];
  for (let i = 0; i < window.DATA.items.length; i++) {
    let info = null;
    try { info = await window.DATA.answerInfo(i); } catch (e) { info = null; }
    out.push(info ? { paras: info.paragraphs.length,
                      chars: info.paragraphs.join(" ").length,
                      first: info.paragraphs[0].slice(0, 90) } : null);
  }
  return out;
}, { timeout: 0 });

// ---- items.json ---------------------------------------------------------
const items = await page.evaluate(() => window.DATA.items.map((it, i) => ({
  idx: i,
  item: it.item,
  correct: it.correct,
  answer_available: it.answer_available,
  q_pages: it.q_pages,
  a_pages: it.a_pages,
  mode: it.content ? "text" : "image",
  aspect: it.aspect,
  n_words: it.words.length,
  n_choices: it.choices.length,
  // choice geometry (row rect + radio) so a layout regression is diffable
  rows: it.choices.map((c) => ({ letter: c.letter, row: c.row, radio: c.radio })),
  stem: it.content
    ? it.content.blocks.filter((b) => b.t === "p").map((b) => window.__runsText(b.runs))
    : null,
  choices: it.content
    ? it.content.choices.map((c) => ({ letter: c.letter, text: window.__runsText(c.runs) }))
    : null,
  figures: it.content
    ? it.content.blocks.filter((b) => b.t === "img").map((b) => ({
        y: Math.round(b.y), x0f: +b.x0f.toFixed(4), wf: +b.wf.toFixed(4),
        fr: b.fr ? 1 : 0, px: b.px }))
    : [],
})), { timeout: 0 });
items.forEach((it, i) => { it.answer_info = aInfo[i]; });

await fsp.writeFile(path.join(out, "items.json"),
  JSON.stringify({ source: { q: qPdf, a: aPdf }, title: summary.title,
                   count: summary.count, ocr: summary.ocr,
                   parse_seconds: +(summary.parseMs / 1000).toFixed(2),
                   items }, null, 1));
// HARNESS_WORDS=31,43 dumps those items' raw word boxes, which is the only way
// to see what OCR actually handed the choice-run matcher.
if (process.env.HARNESS_WORDS) {
  const want = process.env.HARNESS_WORDS.split(",").map((s) => parseInt(s, 10));
  const dump = await page.evaluate((nums) => Object.fromEntries(
    window.DATA.items.filter((it) => nums.includes(it.item))
      .map((it) => [it.item, it.words.map((w) => JSON.parse(JSON.stringify(w)))])), want);
  await fsp.writeFile(path.join(out, "words.json"), JSON.stringify(dump, null, 1));
}

await fsp.writeFile(path.join(out, "progress.txt"),
  summary.prog.map(([l, f]) => `${(f * 100).toFixed(1).padStart(5)}%  ${l}`).join("\n") + "\n");

// ---- figure crops -------------------------------------------------------
let nFig = 0;
for (const it of items) {
  for (let k = 0; k < it.figures.length; k++) {
    const dataUrl = await page.evaluate(
      (i, kk) => window.__blobToDataURL(
        window.DATA.items[i].content.blocks.filter((b) => b.t === "img")[kk].url),
      it.idx, k);
    await fsp.writeFile(path.join(out, `item${it.item}_fig${k}.png`),
      Buffer.from(dataUrl.split(",")[1], "base64"));
    nFig++;
  }
}

// ---- side-by-side previews ---------------------------------------------
for (const it of items) {
  await page.evaluate((i) => {
    const d = window.DATA, item = d.items[i];
    const el = document.getElementById("preview");
    el.innerHTML =
      '<div class="pv"><div><div class="cap">page render (item ' + item.item +
      ', pages ' + item.q_pages.join("+") + ')</div>' +
      (d.qURLs[i] ? '<img class="page" src="' + d.qURLs[i] + '">' : "") +
      '</div><div><div class="cap">text render (' +
      (item.content ? "text mode" : "IMAGE MODE") + ')</div>' +
      '<div class="qhtml">' + window.__renderItemHtml(item.content) + "</div></div></div>";
    return Promise.all([...el.querySelectorAll("img")].map((im) =>
      im.complete ? null : new Promise((r) => { im.onload = im.onerror = r; })));
  }, it.idx);
  const el = await page.$(".pv");
  await el.screenshot({ path: path.join(out, `item${it.item}.png`) });
}

// ---- summary.txt --------------------------------------------------------
const keyed = items.filter((i) => i.answer_available).length;
const textMode = items.filter((i) => i.mode === "text").length;
const lines = [];
lines.push(`Q: ${qPdf}`);
lines.push(`A: ${aPdf || "(none — unscored)"}`);
lines.push(`title: ${summary.title}`);
const withInfo = items.filter((i) => i.answer_info).length;
lines.push(`items: ${items.length}   keyed: ${keyed}   text-mode: ${textMode}` +
           `   figures: ${nFig}   answer explanations: ${withInfo}`);
if (summary.ocr && Object.keys(summary.ocr).length) {
  lines.push(`OCR: ${JSON.stringify(summary.ocr)}`);
}
if (summary.bandFallback) {
  lines.push(`content-band fallback pages: ${JSON.stringify(summary.bandFallback)}`);
}
lines.push(`parse time: ${(summary.parseMs / 1000).toFixed(2)}s ` +
           `(pdf fetch ${(summary.fetchMs / 1000).toFixed(2)}s, wall ${(wallMs / 1000).toFixed(2)}s)`);
lines.push("");
lines.push("item  key  avail  mode   qpg      apg  figs  words  chc   expl  stem");
for (const it of items) {
  lines.push(
    String(it.item).padStart(4) + "  " +
    (it.correct || "-").padStart(3) + "  " +
    (it.answer_available ? "yes" : "NO ").padStart(5) + "  " +
    it.mode.padEnd(5) + "  " +
    it.q_pages.join(",").padEnd(7) + "  " +
    String(it.a_pages.length).padStart(3) + "  " +
    String(it.figures.length).padStart(4) + "  " +
    String(it.n_words).padStart(5) + "  " +
    String(it.n_choices).padStart(3) + "  " +
    (it.answer_info ? String(it.answer_info.chars) : "noexpl").padStart(6) + "  " +
    ((it.stem ? it.stem.join(" ") : "(image mode)").slice(0, 90)));
}
if (consoleLines.length) {
  lines.push("");
  lines.push("--- console ---");
  lines.push(...consoleLines.slice(0, 200));
}
await fsp.writeFile(path.join(out, "summary.txt"), lines.join("\n") + "\n");

console.log(`items ${items.length}  keyed ${keyed}  text-mode ${textMode}  figures ${nFig}`);
console.log(`-> ${out}`);

await browser.close();
server.close();
if (!reuseProfile) await fsp.rm(userDataDir, { recursive: true, force: true });
