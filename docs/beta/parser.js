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

/* Extract positioned words from a page, in canvas pixel coords, with font
   style flags (italic/bold) resolved from the page's loaded fonts. Must be
   called after the page has been rendered so commonObjs is populated. */
async function getPageWords(page, viewport) {
  const tc = await page.getTextContent();
  const U = window.pdfjsLib.Util;
  const fcache = {};
  function fontFlags(fname) {
    if (!(fname in fcache)) {
      let n = "";
      try {
        const f = page.commonObjs.get(fname);
        n = (f && (f.name || f.loadedName)) || "";
      } catch (e) { n = ""; }
      fcache[fname] = { it: /italic|oblique/i.test(n), bd: /bold|black|heavy/i.test(n) };
    }
    return fcache[fname];
  }
  const raw = [];
  const itemRects = [];   // exact per-text-item boxes (no per-word estimation)
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = U.transform(viewport.transform, it.transform);
    const x = m[4], yBase = m[5];
    const fh = Math.hypot(m[2], m[3]);            // scaled font size
    const wpx = it.width * viewport.scale;
    itemRects.push([x, yBase - fh, x + wpx, yBase + fh * 0.25]);
    const str = it.str;
    const fl = fontFlags(it.fontName);
    for (const match of str.matchAll(/\S+/g)) {
      const f0 = match.index / str.length;
      const f1 = (match.index + match[0].length) / str.length;
      raw.push({
        x0: x + wpx * f0, x1: x + wpx * f1,
        y0: yBase - fh, y1: yBase + fh * 0.25,
        base: yBase, text: match[0], it: fl.it, bd: fl.bd,
      });
    }
  }
  // reading order: by baseline, then x
  raw.sort((a, b) => (Math.round(a.base) - Math.round(b.base)) || (a.x0 - b.x0));
  raw.itemRects = itemRects;
  return raw;
}

/* ---------------- structured (real-text) question extraction ------------ */

function median(a) {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/* Cluster words into visual lines; fold sub/superscript fragments (smaller
   font, offset baseline) into their parent line with a sub/sup flag. */
function clusterTextLines(ws) {
  const sorted = [...ws].sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(w.base - L.base) <= 5) L.words.push(w);
    else lines.push({ base: w.base, words: [w] });
  }
  for (let i = lines.length - 1; i >= 0; i--) {
    const L = lines[i];
    const h = median(L.words.map((w) => w.y1 - w.y0));
    for (const N of [lines[i - 1], lines[i + 1]]) {
      if (!N) continue;
      const nh = median(N.words.map((w) => w.y1 - w.y0));
      if (h < nh * 0.8 && Math.abs(L.base - N.base) < nh * 0.75) {
        const flag = L.base > N.base ? "sub" : "sup";
        L.words.forEach((w) => { w[flag] = true; });
        N.words.push(...L.words);
        lines.splice(i, 1);
        break;
      }
    }
  }
  lines.forEach((L) => {
    L.words.sort((a, b) => a.x0 - b.x0);
    L.x0 = Math.min(...L.words.map((w) => w.x0));
    L.x1 = Math.max(...L.words.map((w) => w.x1));
    L.y0 = Math.min(...L.words.map((w) => w.y0));
    L.y1 = Math.max(...L.words.map((w) => w.y1));
  });
  return lines;
}

/* Non-text ink (photos, charts, table borders) found by scanning the
   rendered page for pixels outside every text-item box. Needed because some
   share-PDFs are full-page screenshots (one big image op), so the operator
   list can't localize the figures inside them. */
function inkFigures(imgData, top, stemBot, textRects) {
  const data = imgData.data, W = imgData.width;
  // page-chrome artifacts live at the extreme edges (border strips, the
  // rendered scrollbar on the right) — exclude the outer margins
  const xMin = Math.ceil(W * 0.012), xMax = Math.floor(W * 0.97);
  const bands = [];
  let cur = null;
  for (let y = Math.ceil(top); y < Math.floor(stemBot); y += 2) {
    const iv = [];
    for (const r of textRects) if (y >= r[1] && y <= r[3]) iv.push([r[0], r[2]]);
    iv.sort((a, b) => a[0] - b[0]);
    let cnt = 0, x0 = Infinity, x1 = -1, k = 0;
    for (let x = xMin; x < xMax; x += 2) {
      while (k < iv.length && x > iv[k][1]) k++;
      if (k < iv.length && x >= iv[k][0]) continue;
      const idx = (y * W + x) * 4;
      const d = Math.max(255 - data[idx], 255 - data[idx + 1], 255 - data[idx + 2]);
      if (d > 40) { cnt++; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    if (cnt >= 3) {
      if (cur && y - cur.y1 <= 12) {
        cur.y1 = y;
        cur.x0 = Math.min(cur.x0, x0);
        cur.x1 = Math.max(cur.x1, x1);
      } else {
        cur = { y0: y, y1: y, x0, x1 };
        bands.push(cur);
      }
    }
  }
  return bands.filter((b) => b.y1 - b.y0 >= 10 && b.x1 - b.x0 >= 10);
}

function cropBlob(canvas, x0, y0, x1, y1) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(x1 - x0));
  c.height = Math.max(1, Math.round(y1 - y0));
  c.getContext("2d").drawImage(canvas, -Math.round(x0), -Math.round(y0));
  return new Promise((res) => c.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
}

function wordRun(w, wid) {
  const r = { text: w.text, wid };
  if (w.it) r.i = 1;
  if (w.bd) r.b = 1;
  if (w.sub) r.sub = 1;
  if (w.sup) r.sup = 1;
  return r;
}

/* Build the structured content for one question page: stem paragraphs with
   inline figure crops, plus per-choice text runs. Returns null when the page
   doesn't extract cleanly (caller falls back to image mode). */
async function buildItemContent(raw, pxChoices, top, cw, ch, canvas, imgData) {
  if (!pxChoices.length) return null;
  const stemBot = pxChoices[0].rowTop;
  const stemWords = raw.filter((w) => w.y0 >= top - 2 && w.y1 <= stemBot + 2);
  if (stemWords.length < 5) return null;

  // ---- figures first (column-aware): ink regions outside every text box --
  const textRects = (raw.itemRects || [])
    .map((r) => [r[0] - 4, r[1] - 4, r[2] + 4, r[3] + 4]);
  let figs = inkFigures(imgData, top, stemBot, textRects);
  function mergeFigs() {
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < figs.length; i++) {
        for (let j = i + 1; j < figs.length; j++) {
          if (figs[i].y0 <= figs[j].y1 + 8 && figs[j].y0 <= figs[i].y1 + 8 &&
              figs[i].x0 <= figs[j].x1 + 40 && figs[j].x0 <= figs[i].x1 + 40) {
            figs[i] = {
              y0: Math.min(figs[i].y0, figs[j].y0), y1: Math.max(figs[i].y1, figs[j].y1),
              x0: Math.min(figs[i].x0, figs[j].x0), x1: Math.max(figs[i].x1, figs[j].x1),
            };
            figs.splice(j, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
  }
  mergeFigs();

  // words that live inside/near a figure region are part of it (chart titles,
  // axis labels, values inside a diagram) — absorb them so side-by-side
  // column layouts don't corrupt the body-text lines
  const bodyWords = [];
  for (const w of stemWords) {
    const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    const f = figs.find((f) => cx > f.x0 - 24 && cx < f.x1 + 24 &&
                               cy > f.y0 - 110 && cy < f.y1 + 70);
    if (f) {
      f.x0 = Math.min(f.x0, w.x0 - 4); f.x1 = Math.max(f.x1, w.x1 + 4);
      f.y0 = Math.min(f.y0, w.y0 - 4); f.y1 = Math.max(f.y1, w.y1 + 4);
    } else bodyWords.push(w);
  }
  mergeFigs();
  if (bodyWords.length < 5) return null;

  // ---- body text: lines -> paragraphs ------------------------------------
  const lines = clusterTextLines(bodyWords);
  const deltas = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].base - lines[i - 1].base;
    if (d > 2) deltas.push(d);
  }
  const med = median(deltas) || 26;
  const paras = [];
  let curP = null;
  lines.forEach((L, i) => {
    const gap = i ? L.base - lines[i - 1].base : 0;
    if (!curP || gap > med * 1.55) { curP = { lines: [] }; paras.push(curP); }
    curP.lines.push(L);
  });
  paras.forEach((p) => {
    p.y0 = Math.min(...p.lines.map((l) => l.y0));
    p.y1 = Math.max(...p.lines.map((l) => l.y1));
    p.x0 = Math.min(...p.lines.map((l) => l.x0));
    p.x1 = Math.max(...p.lines.map((l) => l.x1));
    // tabular text (aligned columns) renders badly reflowed -> treat as figure
    let gappy = 0;
    p.lines.forEach((l) => {
      for (let i = 1; i < l.words.length; i++) {
        if (l.words[i].x0 - l.words[i - 1].x1 > cw * 0.055) { gappy++; break; }
      }
    });
    p.tabular = gappy >= 2;
  });
  figs = figs.concat(paras.filter((p) => p.tabular)
    .map((p) => ({ y0: p.y0 - 4, y1: p.y1 + 4, x0: p.x0 - 4, x1: p.x1 + 4 })));
  mergeFigs();
  // a text paragraph belongs to a figure when it overlaps it HORIZONTALLY —
  // inside a bordered table, or a caption above/below the figure. A body
  // paragraph merely sitting beside a figure stays real text.
  for (let pass = 0; pass < 2; pass++) {
    paras.forEach((p) => {
      if (p.consumed) return;
      for (const f of figs) {
        const ovY = Math.min(f.y1, p.y1) - Math.max(f.y0, p.y0);
        const ovX = Math.min(f.x1, p.x1) - Math.max(f.x0, p.x0);
        const xFrac = ovX / Math.max(1, p.x1 - p.x0);
        if ((ovY > (p.y1 - p.y0) * 0.5 && xFrac > 0.3) ||
            (xFrac > 0.6 && ovY > -60)) {
          p.consumed = true;
          f.y0 = Math.min(f.y0, p.y0 - 4); f.y1 = Math.max(f.y1, p.y1 + 4);
          f.x0 = Math.min(f.x0, p.x0 - 4); f.x1 = Math.max(f.x1, p.x1 + 4);
          break;
        }
      }
    });
  }

  // assemble blocks in reading order, assigning word ids for highlighting
  let wid = 0;
  const blocks = [];
  for (const p of paras.filter((p) => !p.consumed && !p.tabular)) {
    const runs = [];
    p.lines.forEach((l) => l.words.forEach((w) => runs.push(wordRun(w, wid++))));
    if (runs.length) blocks.push({ t: "p", y: p.y0, runs });
  }
  for (const f of figs) {
    const block = {
      t: "img", y: f.y0,
      url: await cropBlob(canvas, f.x0 - 2, f.y0 - 2, f.x1 + 2, f.y1 + 2),
      x0f: Math.max(0, (f.x0 - 2) / cw),
      wf: Math.min(1, (f.x1 - f.x0 + 4) / cw),
    };
    // a right-side figure with body text beside it floats right so the text
    // wraps around it like the original layout
    const beside = paras.find((p) => !p.consumed && !p.tabular &&
      Math.min(f.y1, p.y1) - Math.max(f.y0, p.y0) > (p.y1 - p.y0) * 0.3);
    if (beside && f.x0 > cw * 0.45) { block.fr = 1; block.y = beside.y0 - 1; }
    blocks.push(block);
  }
  blocks.sort((a, b) => a.y - b.y);

  // choice text runs (only words right of the letter label — this also drops
  // the radio circle, which some PDFs draw as a symbol-font glyph)
  const choices = [];
  for (const pc of pxChoices) {
    const cws = raw.filter((w) => {
      const cy = (w.y0 + w.y1) / 2;
      return cy >= pc.rowTop && cy <= pc.rowBot &&
             w.x0 >= pc.lx0 - 2 && w.text !== pc.letter + ")";
    });
    if (!cws.length) return null;  // image choices etc: fall back whole item
    const runs = [];
    clusterTextLines(cws).forEach((l) => l.words.forEach((w) => runs.push(wordRun(w, wid++))));
    choices.push({ letter: pc.letter, runs });
  }
  return { blocks, choices };
}

/* ---------------- main ------------------------------------------------- */

async function parseExam(qBytes, aBytes, onProgress) {
  const pdfjs = window.pdfjsLib;
  const qdoc = await pdfjs.getDocument({ data: qBytes, useSystemFonts: false, disableFontFace: true }).promise;
  const adoc = await pdfjs.getDocument({ data: aBytes, useSystemFonts: false, disableFontFace: true }).promise;
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
    const pxChoices = [];
    ordered.forEach(([L, bx], idx) => {
      const [cx, cy, rad] = radioForLetter(img.data, w, h, [bx.x0, bx.y0, bx.x1, bx.y1]);
      const rowTop = bx.y0 - rad * 0.6;
      const rowBot = idx + 1 < ordered.length
        ? ordered[idx + 1][1].y0 - rad * 0.6
        : bx.y1 + (bx.y1 - bx.y0) * 1.4;
      pxChoices.push({ letter: L, rowTop, rowBot, lx0: bx.x0 });
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

    // structured real-text content; image mode is the fallback
    let content = null;
    try {
      content = await buildItemContent(rawWords, pxChoices, top, cw, ch,
                                       canvas, img);
    } catch (e) { content = null; }

    if (content) {
      qURLs.push(null);
    } else {
      // cropped content image -> blob URL (fallback rendering)
      const crop = document.createElement("canvas");
      crop.width = cw; crop.height = ch;
      crop.getContext("2d").drawImage(canvas, 0, -top);
      qURLs.push(await new Promise((res) =>
        crop.toBlob((b) => res(URL.createObjectURL(b)), "image/png")));
    }

    items.push({
      item: pno,
      aspect: Math.round(ch / cw * 1e5) / 1e5,
      choices, words, content,
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
