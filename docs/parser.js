"use strict";
/* Client-side exam PDF parser — a port of the Python parser (app/parsing/parser.py)
   using PDF.js. Everything runs in the browser: the PDFs never leave the
   user's machine.

   parseExam(questionBytes, answerBytes, onProgress) resolves to the same
   data shape the Flask /api/exam endpoint served, plus:
     - qURLs[i]      : blob URL of the cropped question-page image
     - answerURL(i)  : lazy blob URL of the full answer-key page image
*/

const SCALE = 132 / 72;   // same 132 dpi rendering as the server version

/* ---------------- text helpers (ports of _norm/_stem_key/...) ---------- */

function normText(s) {
  s = s.replace(/Exam Section[\s\S]*?Self-Assessment/g, " ");
  s = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function stemKey(text) {
  let t = text.replace(/^[\s\S]*?\n\s*\d+\s*[.)]\s/, " ");
  t = t.split(/\n\s*[A-J]\)|Correct\s*Answer/)[0];
  return normText(t).slice(0, 350);
}

function itemNumber(text) {
  let m = text.match(/Item\s+(\d+)\s+of/);
  if (m) return parseInt(m[1], 10);
  m = text.match(/(?:^|\n)\s*(\d+)\s*[.)]\s+[A-Z(]/);
  if (m) return parseInt(m[1], 10);
  return null;
}

function correctLetter(text) {
  const m = text.match(/Correct\s*Answer:\s*([A-J])/);
  return m ? m[1] : null;
}

/* Dice coefficient over character bigrams — plays the role of Python's
   difflib ratio for stem matching (near-identical stems score ~0.9+,
   unrelated ones well under 0.4). */
function bigramCounts(s) {
  const m = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const b = s.slice(i, i + 2);
    m.set(b, (m.get(b) || 0) + 1);
  }
  return m;
}
function similarity(a, b) {
  if (!a.length || !b.length) return 0;
  const ma = bigramCounts(a), mb = bigramCounts(b);
  let inter = 0, total = 0;
  ma.forEach((n, k) => { inter += Math.min(n, mb.get(k) || 0); });
  ma.forEach((n) => { total += n; });
  mb.forEach((n) => { total += n; });
  return total ? (2 * inter) / total : 0;
}

/* ---------------- image / geometry helpers ----------------------------- */

/* Find the vertical content band between the navy header/footer bars. */
function contentBand(data, w, h) {
  const dark = [];
  for (let y = 0; y < h; y++) {
    let blue = 0, n = 0;
    const row = y * w * 4;
    for (let x = 0; x < w; x += 2) {
      const i = row + x * 4;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (b > 55 && b < 170 && b > r + 18 && b > g + 8 && r < 100) blue++;
      n++;
    }
    if (blue / n > 0.45) dark.push(y);
  }
  let top = 0, bottom = h;
  const topBand = dark.filter((y) => y < h * 0.22);
  const botBand = dark.filter((y) => y > h * 0.78);
  if (topBand.length) top = Math.max(...topBand) + 1;
  if (botBand.length) bottom = Math.min(...botBand);
  if (bottom - top < h * 0.3) return [0, h];
  return [top, bottom];
}

/* Locate the radio circle left of a choice-letter box. Returns [cx,cy,r]. */
function radioForLetter(data, w, h, box) {
  const [x0, y0, , y1] = [box[0], box[1], box[2], box[3]];
  const lh = y1 - y0;
  const scanLeft = Math.max(0, Math.floor(x0 - lh * 2.4));
  let cx = x0 - lh * 0.95, cy = (y0 + y1) / 2, rad = lh * 0.45;
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, count = 0;
  for (let y = Math.floor(y0); y < Math.min(h, Math.ceil(y1)); y++) {
    for (let x = scanLeft; x < Math.floor(x0); x++) {
      const i = (y * w + x) * 4;
      const gray = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (gray < 175) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (count > 4) {
    cx = (minX + maxX) / 2;
    cy = (minY + maxY) / 2;
    rad = Math.max(maxX - minX, maxY - minY) / 2;
  }
  return [cx, cy, rad];
}

/* ---------------- PDF.js text extraction -------------------------------- */

/* Reconstruct a page's text lines (top first), keeping each line's baseline
   y so callers can detect paragraph breaks from vertical spacing.
   foldSubscripts widens baseline merging so sub/superscripts (e.g. the 4 in
   T4, offset ~0.4em) join their line — only safe on well-spaced body text,
   not on dense tables, so it's opt-in (used for explanation extraction). */
async function getPageLines(page, foldSubscripts) {
  const tc = await page.getTextContent();
  const rows = new Map();  // rounded baseline y -> [{x, w, str}]
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const y = Math.round(it.transform[5]);
    let row = null;
    const tol = foldSubscripts ? Math.max(4, (it.height || 10) * 0.45) : 2;
    for (const key of rows.keys()) {
      if (Math.abs(key - y) <= tol) { row = key; break; }
    }
    if (row === null) { rows.set(y, []); row = y; }
    rows.get(row).push({ x: it.transform[4], w: it.width,
                         h: it.height || 10, str: it.str });
  }
  const ordered = [...rows.entries()].sort((a, b) => b[0] - a[0]); // top first
  return ordered.map(([y, items]) => {
    items.sort((a, b) => a.x - b.x);
    // gap-aware join: PDFs split words into glyph runs; only insert a space
    // when there's a real horizontal gap between adjacent items
    let line = "", endX = null;
    for (const i of items) {
      if (endX !== null) line += (i.x - endX > i.h * 0.21) ? " " : "";
      line += i.str;
      endX = i.x + i.w;
    }
    return { y, text: line };
  });
}

async function getPageText(page) {
  return (await getPageLines(page)).map((l) => l.text).join("\n");
}

/* Extract positioned words from a page, in canvas pixel coords. */
async function getPageWords(page, viewport) {
  const tc = await page.getTextContent();
  const U = window.pdfjsLib.Util;
  const raw = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = U.transform(viewport.transform, it.transform);
    const x = m[4], yBase = m[5];
    const fh = Math.hypot(m[2], m[3]);            // scaled font size
    const wpx = it.width * viewport.scale;
    const str = it.str;
    for (const match of str.matchAll(/\S+/g)) {
      const f0 = match.index / str.length;
      const f1 = (match.index + match[0].length) / str.length;
      raw.push({
        x0: x + wpx * f0, x1: x + wpx * f1,
        y0: yBase - fh, y1: yBase + fh * 0.25,
        base: yBase, text: match[0],
      });
    }
  }
  // reading order: by baseline, then x
  raw.sort((a, b) => (Math.round(a.base) - Math.round(b.base)) || (a.x0 - b.x0));
  return raw;
}

/* ---------------- main ------------------------------------------------- */

async function parseExam(qBytes, aBytes, onProgress) {
  const pdfjs = window.pdfjsLib;
  const qdoc = await pdfjs.getDocument({ data: qBytes, useSystemFonts: false }).promise;
  const adoc = await pdfjs.getDocument({ data: aBytes, useSystemFonts: false }).promise;
  const nq = qdoc.numPages, na = adoc.numPages;

  /* -- index the answer key (text only, fast) -- */
  const answerPages = [];
  for (let i = 1; i <= na; i++) {
    onProgress(`Reading answer key…`, (i - 1) / na * 0.25);
    const text = await getPageText(await adoc.getPage(i));
    const letter = correctLetter(text);
    if (!letter) continue;   // spillover page with no answer marker
    answerPages.push({ page: i, num: itemNumber(text), letter, key: stemKey(text) });
  }
  const answerByItem = new Map();
  for (const p of answerPages) {
    if (p.num !== null && !answerByItem.has(p.num)) answerByItem.set(p.num, p);
  }

  function resolveAnswer(itemNo, qStem) {
    let bestPage = null, bestLetter = null, bestRatio = 0;
    const cand = answerByItem.get(itemNo);
    if (cand) {
      bestPage = cand.page; bestLetter = cand.letter;
      bestRatio = similarity(qStem, cand.key);
    }
    for (const p of answerPages) {
      const r = similarity(qStem, p.key);
      if (r > bestRatio) { bestPage = p.page; bestLetter = p.letter; bestRatio = r; }
    }
    // Dice bigrams need a higher bar than difflib's 0.55: true matches are
    // near-identical text (~0.9), while different stems that share medical
    // vocabulary can reach ~0.6.
    if (bestRatio < 0.75) return [null, null];
    return [bestPage, bestLetter];
  }

  /* -- parse question pages -- */
  const items = [];
  const qURLs = [];
  let title = "Self-Assessment";
  for (let pno = 1; pno <= nq; pno++) {
    onProgress(`Preparing question ${pno} of ${nq}…`, 0.25 + (pno - 1) / nq * 0.75);
    const page = await qdoc.getPage(pno);
    const viewport = page.getViewport({ scale: SCALE });
    const w = Math.round(viewport.width), h = Math.round(viewport.height);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: ctx, viewport }).promise;
    const img = ctx.getImageData(0, 0, w, h);

    const [top, bottom] = contentBand(img.data, w, h);
    const cw = w, ch = bottom - top;

    const rawWords = await getPageWords(page, viewport);
    if (pno === 1) {
      const t = await getPageText(page);
      const m = t.match(/([A-Z][A-Za-z ]+Self-Assessment)/);
      if (m) {
        // drop leading header-chrome words (e.g. "Mark", an org name ending
        // in "... Examiners") that share the line with the exam title
        title = m[1].replace(/^(?:.*\bExaminers\s+|Mark\s+)/, "").trim();
      }
    }

    // choice letters A) B) ... — topmost occurrence per letter in the band
    const letterBoxes = new Map();
    for (const wd of rawWords) {
      const m = wd.text.match(/^([A-J])\)$/);
      if (!m) continue;
      if (wd.y0 < top || wd.y1 > bottom) continue;
      const L = m[1];
      if (!letterBoxes.has(L) || wd.y0 < letterBoxes.get(L).y0) letterBoxes.set(L, wd);
    }
    const ordered = [];
    let code = 65;
    while (letterBoxes.has(String.fromCharCode(code))) {
      ordered.push([String.fromCharCode(code), letterBoxes.get(String.fromCharCode(code))]);
      code++;
    }

    const choices = [];
    ordered.forEach(([L, bx], idx) => {
      const [cx, cy, rad] = radioForLetter(img.data, w, h, [bx.x0, bx.y0, bx.x1, bx.y1]);
      const rowTop = bx.y0 - rad * 0.6;
      const rowBot = idx + 1 < ordered.length
        ? ordered[idx + 1][1].y0 - rad * 0.6
        : bx.y1 + (bx.y1 - bx.y0) * 1.4;
      const rowLeft = cx - rad * 1.6;
      const rowRight = cw * 0.99;
      choices.push({
        letter: L,
        row: [rowLeft / cw, (rowTop - top) / ch, rowRight / cw, (rowBot - top) / ch]
          .map((v) => Math.round(v * 1e5) / 1e5),
        radio: [cx / cw, (cy - top) / ch, rad / ch].map((v) => Math.round(v * 1e5) / 1e5),
      });
    });

    // word boxes for the text layer (content area only, skip symbol noise)
    const words = [];
    for (const wd of rawWords) {
      if (wd.y0 < top || wd.y1 > bottom) continue;
      if (!/[A-Za-z0-9]/.test(wd.text)) continue;
      words.push([
        Math.round(wd.x0 / cw * 1e5) / 1e5,
        Math.round((wd.y0 - top) / ch * 1e5) / 1e5,
        Math.round(wd.x1 / cw * 1e5) / 1e5,
        Math.round((wd.y1 - top) / ch * 1e5) / 1e5,
        wd.text,
      ]);
    }

    // resolve against the answer key
    const qStem = stemKey(await getPageText(page));
    const [aPage, letter] = resolveAnswer(pno, qStem);

    // cropped content image -> blob URL
    const crop = document.createElement("canvas");
    crop.width = cw; crop.height = ch;
    crop.getContext("2d").drawImage(canvas, 0, -top);
    const url = await new Promise((res) =>
      crop.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
    qURLs.push(url);

    items.push({
      item: pno,
      aspect: Math.round(ch / cw * 1e5) / 1e5,
      choices, words,
      correct: letter,
      answer_available: aPage !== null,
      has_answer_image: aPage !== null,
      a_page: aPage,
    });
  }
  onProgress("Done", 1);

  /* -- lazy answer-page rendering -- */
  const aCache = new Map();
  async function answerURL(idx0) {
    const it = items[idx0];
    if (it.a_page === null) return null;
    if (aCache.has(it.a_page)) return aCache.get(it.a_page);
    const page = await adoc.getPage(it.a_page);
    const viewport = page.getViewport({ scale: SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const url = await new Promise((res) =>
      canvas.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
    aCache.set(it.a_page, url);
    return url;
  }

  /* -- lazy answer-explanation text extraction --
     Returns { paragraphs: [string] } starting at "Correct Answer: X", grouped
     into paragraphs by the page's vertical line spacing, or null when the
     text is too thin to trust (caller falls back to the page image). */
  const aInfoCache = new Map();
  async function answerInfo(idx0) {
    const it = items[idx0];
    if (it.a_page === null) return null;
    if (aInfoCache.has(it.a_page)) return aInfoCache.get(it.a_page);
    let info = null;
    try {
      const lines = await getPageLines(await adoc.getPage(it.a_page), true);
      const start = lines.findIndex((l) => /Correct\s*Answer\s*:/.test(l.text));
      if (start >= 0) {
        const CHROME = /Time Remaining|Exam Section|^\s*(Previous|Next|Highlight|Lab Values|Calculator|Navigator|End Block|Mark)\b/;
        const body = lines.slice(start)
          .filter((l) => l.text.trim() && !CHROME.test(l.text));
        const gaps = [];
        for (let i = 1; i < body.length; i++) {
          gaps.push(Math.abs(body[i - 1].y - body[i].y));
        }
        gaps.sort((a, b) => a - b);
        const med = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 14;
        const paras = [];
        let cur = null;
        body.forEach((l, i) => {
          const gap = i ? Math.abs(body[i - 1].y - l.y) : 0;
          const forceNew = /^(Incorrect Answers|Educational Objective)/.test(l.text.trim());
          if (!cur || forceNew || gap > med * 1.55) { cur = []; paras.push(cur); }
          cur.push(l.text.trim());
        });
        const texts = paras.map((p) => p.join(" ").replace(/\s+/g, " ")
          // folded subscripts can swallow the following space: "T4or" -> "T4 or"
          .replace(/([A-Z]\d{1,2})([a-z]{2,})/g, "$1 $2").trim())
          .filter(Boolean)
          // drop watermark/junk paragraphs (URLs, mostly-symbol noise)
          .filter((p) => !/https?:\/\/|t\.me\/|www\./i.test(p))
          .filter((p) => {
            const letters = (p.match(/[A-Za-z]/g) || []).length;
            return letters / p.length > 0.5;
          });
        if (texts.join(" ").length >= 200) info = { paragraphs: texts };
      }
    } catch (e) { info = null; }
    aInfoCache.set(it.a_page, info);
    return info;
  }

  return { count: items.length, title, items, qURLs, answerURL, answerInfo };
}

window.parseExam = parseExam;
