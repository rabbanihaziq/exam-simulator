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
  // OCR'd text layers separate words with U+00A0, which defeats the literal
  // spaces in the chrome pattern below.
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/Exam Section[\s\S]*?Self-Assessment/g, " ");
  s = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function stemKey(text) {
  // the answer key prints a red X before a wrongly answered item's number
  let t = text.replace(/^[\s\S]*?\n[^\S\n]*(?:[Xx\u00d7*\u2713\u221a]\s*)?\d+\s*[.)]\s/, " ");
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
    if (!it.str) continue;
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
    // A space can also arrive as its own text item, and an OCR'd layer's
    // word widths can already cover it, leaving no gap to measure — so a
    // whitespace-only item forces the separator on its own.
    let line = "", endX = null, pendingSpace = false;
    for (const i of items) {
      if (!i.str.trim()) { pendingSpace = true; continue; }
      if (endX !== null) line += (pendingSpace || i.x - endX > i.h * 0.21) ? " " : "";
      line += i.str;
      endX = i.x + i.w;
      pendingSpace = false;
    }
    return { y, text: line };
  });
}

async function getPageText(page) {
  return (await getPageLines(page)).map((l) => l.text).join("\n");
}

/* Render with print intent — the default display intent schedules paint
   continuations on requestAnimationFrame, which never fires in a
   backgrounded tab, silently stalling the parse. Plus a watchdog that
   cancels and retries a render that still won't resolve. */
async function renderPage(page, viewport, ctx) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const task = page.render({ canvasContext: ctx, viewport, intent: "print" });
    const result = await Promise.race([
      task.promise.then(() => "ok").catch(() => "cancelled"),
      new Promise((res) => setTimeout(() => res("timeout"), 7000)),
    ]);
    if (result === "ok") return;
    try { task.cancel(); } catch (e) {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("page render stalled");
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

/* Let a figure run past the first answer choice.

   inkFigures only scans the stem band, because below it the answer choices'
   radio circles and text are ink too. But some items are laid out in two
   columns, with the exhibit in a column beside the stem that continues well
   past choice A — scanning only the stem band slices such an image in half.
   A figure whose column is clear of the choice text can safely be followed
   down to the bottom of the content. */
function extendFiguresBelow(imgData, figs, stemBot, contentBot, textRects, pxChoices) {
  const data = imgData.data, W = imgData.width;
  // Only the radio circles are ink the text mask can't hide, and they sit just
  // left of the choice letters, so a figure starting right of the letters can
  // be followed down safely. Choice text itself is masked, and a figure column
  // that does overlap it simply finds no ink and stops.
  const lettersEnd = pxChoices.reduce((m, c) => Math.max(m, c.lx1), 0);
  for (const f of figs) {
    if (f.x0 < lettersEnd + 8) continue;   // shares the column with the choices
    let lastInk = f.y1, gap = 0;
    for (let y = Math.ceil(stemBot); y < Math.floor(contentBot); y += 2) {
      const iv = [];
      for (const r of textRects) if (y >= r[1] && y <= r[3]) iv.push([r[0], r[2]]);
      iv.sort((a, b) => a[0] - b[0]);
      let cnt = 0, k = 0;
      const from = Math.max(0, Math.floor(f.x0)), to = Math.min(W, Math.ceil(f.x1));
      for (let x = from; x < to; x += 2) {
        while (k < iv.length && x > iv[k][1]) k++;
        if (k < iv.length && x >= iv[k][0]) continue;
        const idx = (y * W + x) * 4;
        const d = Math.max(255 - data[idx], 255 - data[idx + 1], 255 - data[idx + 2]);
        if (d > 40) cnt++;
      }
      if (cnt >= 3) { lastInk = y; gap = 0; }
      else if (y > f.y1) { gap += 2; if (gap > 24) break; }
    }
    f.y1 = Math.max(f.y1, lastInk);
  }
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

  // Last, once every figure's extent is settled: follow a figure that sits in
  // its own column down past the answer choices. Done here so a taller figure
  // can't feed back into the merging and paragraph-absorbing above, where it
  // could chain across the page and swallow the stem.
  extendFiguresBelow(imgData, figs, stemBot, top + ch, textRects, pxChoices);

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
  // Rows are bounded by baselines, not by box centres: a word's box is
  // y0 = baseline - fontSize, so an OCR'd layer that fits a font size to each
  // word's width moves its centre up or down out of its own row, while every
  // word on a visual line shares a baseline whatever its size.
  const choices = [];
  for (let ci = 0; ci < pxChoices.length; ci++) {
    const pc = pxChoices[ci];
    // A boundary sits a fraction of a line above the next choice's baseline:
    // clear of that choice's own text whatever font it uses, yet still below a
    // wrapped continuation line of this one.
    const from = pc.base - pc.tol;
    // the last choice runs to the end of the content, never into the footer bar
    const next = pxChoices[ci + 1];
    const to = next ? next.base - next.tol : top + ch;
    const cws = raw.filter((w) => {
      if (!(w.base >= from && w.base < to)) return false;
      if (w.x0 < pc.lx0 - 2 || w.text === pc.letter + ")") return false;
      // a label OCR'd inside the exhibit (an "R" orientation marker on an
      // x-ray) can share a choice's baseline; it belongs to the figure
      const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
      return !figs.some((f) => cx > f.x0 - 4 && cx < f.x1 + 4 &&
                               cy > f.y0 - 4 && cy < f.y1 + 4);
    });
    if (!cws.length) return null;  // image choices etc: fall back whole item
    const runs = [];
    clusterTextLines(cws).forEach((l) => l.words.forEach((w) => runs.push(wordRun(w, wid++))));
    choices.push({ letter: pc.letter, runs });
  }
  return { blocks, choices };
}

/* ---------------- multi-screenshot items -------------------------------- */

/* Some share PDFs put one item on one page; others capture it as two or three
   overlapping scroll screenshots, where the first shows the exhibit but clips
   the choices and a later one shows every choice but clips the top of the
   exhibit. Pages then outnumber items, so numbering items by page index would
   shift every later item and mis-key the exam. The shots of one item are
   consecutive and carry the same "Item N of M" header, so they are grouped by
   it and painted back into one tall page. Port of app/parsing/stitch.py. */

const MIN_ANCHOR_LEN = 5;   // shorter text repeats too often to anchor on
const REFINE_RADIUS = 8;    // px the pixel search may move a text offset
const STRIDE = 4;           // column stride for pixel comparisons

/* Consecutive pages sharing one header item number become one group. */
function groupPages(nums) {
  const groups = [];
  nums.forEach((num, i) => {
    const prev = groups.length ? groups[groups.length - 1] : null;
    if (prev && num !== null && nums[prev[prev.length - 1]] === num) prev.push(i);
    else groups.push([i]);
  });
  return groups;
}

/* Content words long enough to anchor on, keyed by text, uniques only. */
function buildAnchors(words, top, bottom) {
  const seen = new Map();
  for (const w of words) {
    if (w.y0 <= top || w.y1 >= bottom) continue;
    if (w.text.length < MIN_ANCHOR_LEN) continue;
    if (!seen.has(w.text)) seen.set(w.text, []);
    seen.get(w.text).push((w.y0 + w.y1) / 2);
  }
  const out = new Map();
  for (const [t, ys] of seen) if (ys.length === 1) out.set(t, ys[0]);
  return out;
}

/* Rows B is scrolled past A, from text common to both shots. */
function offsetFromText(a, b) {
  const deltas = [];
  for (const [t, ya] of a) if (b.has(t)) deltas.push(ya - b.get(t));
  if (!deltas.length) return null;
  deltas.sort((x, y) => x - y);
  const med = deltas[deltas.length >> 1];
  const agree = deltas.filter((d) => Math.abs(d - med) <= 6);
  return agree.length ? agree.reduce((s, d) => s + d, 0) / agree.length : med;
}

function overlapRows(bandA, bandB, d) {
  return [Math.max(0, d),
          Math.min(bandA[1] - bandA[0], bandB[1] - bandB[0] + d)];
}

/* Per document row: mean |difference| between the shots, and the ink in A. */
function rowScores(A, B, w, bandA, bandB, d, lo, hi) {
  const diff = new Float64Array(hi - lo), ink = new Float64Array(hi - lo);
  for (let r = lo; r < hi; r++) {
    const ra = (bandA[0] + r) * w, rb = (bandB[0] + r - d) * w;
    let sum = 0, tone = 0, n = 0;
    for (let x = 0; x < w; x += STRIDE) {
      const ia = (ra + x) * 4, ib = (rb + x) * 4;
      sum += Math.abs(A[ia] - B[ib]) + Math.abs(A[ia + 1] - B[ib + 1])
           + Math.abs(A[ia + 2] - B[ib + 2]);
      tone += A[ia] + A[ia + 1] + A[ia + 2];
      n++;
    }
    diff[r - lo] = sum / (n * 3);
    ink[r - lo] = 255 - tone / (n * 3);
  }
  return [diff, ink];
}

/* Text boxes are good to a few pixels; a seam is only invisible when the
   offset is exact, so search a small window for the best-matching shift. */
function refineOffset(A, B, w, bandA, bandB, d0) {
  const start = Math.round(d0);
  let best = start, bestScore = Infinity;
  for (let d = start - REFINE_RADIUS; d <= start + REFINE_RADIUS; d++) {
    const [lo, hi] = overlapRows(bandA, bandB, d);
    if (hi - lo < 40) continue;
    const [diff] = rowScores(A, B, w, bandA, bandB, d, lo, hi);
    let s = 0;
    for (let i = 0; i < diff.length; i++) s += diff[i];
    s /= diff.length;
    if (s < bestScore) { bestScore = s; best = d; }
  }
  return best;
}

/* Cut where the shots agree most closely — in practice a blank row between
   two text lines, so no glyph is sliced in half. */
function seamRow(A, B, w, bandA, bandB, d) {
  let [lo, hi] = overlapRows(bandA, bandB, d);
  lo += 6; hi -= 6;
  if (hi <= lo) return Math.max(0, d);
  const [diff, ink] = rowScores(A, B, w, bandA, bandB, d, lo, hi);
  let best = lo, bestScore = Infinity;
  for (let i = 0; i < diff.length; i++) {
    const s = diff[i] * 4 + ink[i] * 0.02;
    if (s < bestScore) { bestScore = s; best = lo + i; }
  }
  return best;
}

/* Rebuild page text from positioned words, one visual line per line. Needed
   only for stitched items, where no single PDF page holds the whole stem. */
function textFromWords(words) {
  if (!words.length) return "";
  const hs = words.map((w) => w.y1 - w.y0).sort((a, b) => a - b);
  const tol = hs[hs.length >> 1] * 0.6;
  const lines = [];
  [...words].sort((a, b) => ((a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2) || (a.x0 - b.x0))
    .forEach((w) => {
      const cy = (w.y0 + w.y1) / 2;
      const cur = lines[lines.length - 1];
      if (cur && Math.abs(cy - cur.cy) <= tol) cur.ws.push(w);
      else lines.push({ cy, ws: [w] });
    });
  return lines.map((l) => l.ws.sort((a, b) => a.x0 - b.x0)
    .map((w) => w.text).join(" ")).join("\n");
}

/* Paint an item's shots into one tall canvas and merge their words without
   duplicating the overlap. A single shot is returned untouched, so forms with
   one page per item take exactly the path they always did. */
function stitchShots(shots) {
  if (shots.length === 1) {
    const s = shots[0];
    return { canvas: s.canvas, img: s.img, words: s.words,
             top: s.band[0], bottom: s.band[1], w: s.w, h: s.h };
  }
  const offsets = [];
  for (let i = 1; i < shots.length; i++) {
    const a = shots[i - 1], b = shots[i];
    const d0 = offsetFromText(buildAnchors(a.words, a.band[0], a.band[1]),
                              buildAnchors(b.words, b.band[0], b.band[1]));
    if (d0 === null) {
      throw new Error("pages carry the same item number but share no text to align on");
    }
    offsets.push(refineOffset(a.img.data, b.img.data, a.w, a.band, b.band, d0));
  }
  const starts = [0];
  offsets.forEach((d) => starts.push(starts[starts.length - 1] + d));
  const seams = [];
  for (let i = 0; i < shots.length - 1; i++) {
    seams.push(starts[i] + seamRow(shots[i].img.data, shots[i + 1].img.data,
                                   shots[i].w, shots[i].band, shots[i + 1].band,
                                   offsets[i]));
  }
  const last = shots[shots.length - 1];
  const docEnd = starts[starts.length - 1] + (last.band[1] - last.band[0]);
  const bounds = [0, ...seams, docEnd];
  const top = shots[0].band[0];
  const w = shots[0].w;
  const height = top + docEnd + (last.h - last.band[1]);

  const canvas = document.createElement("canvas");
  canvas.width = w; canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, height);
  ctx.drawImage(shots[0].canvas, 0, 0, w, top, 0, 0, w, top);          // header bar
  ctx.drawImage(last.canvas, 0, last.band[1], w, last.h - last.band[1],
                0, top + docEnd, w, last.h - last.band[1]);            // footer bar

  const words = [];
  const itemRects = [];
  shots.forEach((s, i) => {
    const lo = bounds[i], hi = bounds[i + 1];
    const shift = top + starts[i] - s.band[0];
    ctx.drawImage(s.canvas, 0, s.band[0] + lo - starts[i], w, hi - lo,
                  0, top + lo, w, hi - lo);
    for (const wd of s.words) {
      const cy = (wd.y0 + wd.y1) / 2 + shift;
      // each shot owns the document rows it was cut to contribute; the chrome
      // bars come from the first and last shot
      if (!((cy >= top + lo && cy < top + hi)
            || (i === 0 && cy < top)
            || (i === shots.length - 1 && cy >= top + docEnd))) continue;
      words.push({ ...wd, y0: wd.y0 + shift, y1: wd.y1 + shift,
                   base: wd.base + shift });
    }
    // every shot's text boxes mask figure detection; duplicates land on the
    // same content, so keeping them all only makes the mask more complete
    for (const r of (s.words.itemRects || [])) {
      itemRects.push([r[0], r[1] + shift, r[2], r[3] + shift]);
    }
  });
  words.sort((a, b) => (Math.round(a.base) - Math.round(b.base)) || (a.x0 - b.x0));
  words.itemRects = itemRects;
  return { canvas, img: ctx.getImageData(0, 0, w, height), words: dedupeWords(words),
           top, bottom: top + docEnd, w, h: height };
}

/* The seam is an integer row but the offset between two shots can be
   fractional, so a line can land just either side of it and survive twice.
   Drop a word that repeats another at the same place. */
function dedupeWords(words) {
  const seen = new Map();
  const kept = [];
  for (const wd of words) {
    const key = wd.text + "@" + Math.round(wd.x0 / 2);
    const prev = seen.get(key);
    const cy = (wd.y0 + wd.y1) / 2;
    if (prev && Math.abs(prev - cy) < (wd.y1 - wd.y0) * 0.6) continue;
    seen.set(key, cy);
    kept.push(wd);
  }
  kept.itemRects = words.itemRects;
  return kept;
}

/* ---------------- main ------------------------------------------------- */

async function parseExam(qBytes, aBytes, onProgress) {
  const pdfjs = window.pdfjsLib;
  const qdoc = await pdfjs.getDocument({ data: qBytes, useSystemFonts: false, disableFontFace: true }).promise;
  const adoc = await pdfjs.getDocument({ data: aBytes, useSystemFonts: false, disableFontFace: true }).promise;
  const nq = qdoc.numPages, na = adoc.numPages;

  /* -- index the answer key (text only, fast) -- */
  const aTexts = [];
  for (let i = 1; i <= na; i++) {
    onProgress(`Reading answer key…`, (i - 1) / na * 0.25);
    aTexts.push(await getPageText(await adoc.getPage(i)));
  }
  // An answer can span several screenshots. Group them so the whole answer is
  // shown, but keep matching on each marked shot's own stem, as page-at-a-time
  // indexing did.
  const aGroups = groupPages(aTexts.map(itemNumber)).map((g) => g.map((i) => i + 1));
  const answerPages = [];
  const answerByItem = new Map();
  aGroups.forEach((group, gi) => {
    for (const pno of group) {
      const text = aTexts[pno - 1];
      const letter = correctLetter(text);
      if (!letter) continue;   // continuation shot with no answer marker
      const cand = { group: gi, num: itemNumber(text), letter, key: stemKey(text) };
      answerPages.push(cand);
      if (cand.num !== null && !answerByItem.has(cand.num)) {
        answerByItem.set(cand.num, cand);
      }
    }
  });

  function resolveAnswer(itemNo, qStem) {
    let bestGroup = null, bestLetter = null, bestRatio = 0;
    const cand = answerByItem.get(itemNo);
    if (cand) {
      bestGroup = cand.group; bestLetter = cand.letter;
      bestRatio = similarity(qStem, cand.key);
    }
    for (const p of answerPages) {
      const r = similarity(qStem, p.key);
      if (r > bestRatio) { bestGroup = p.group; bestLetter = p.letter; bestRatio = r; }
    }
    // Dice bigrams need a higher bar than difflib's 0.55: true matches are
    // near-identical text (~0.9), while different stems that share medical
    // vocabulary can reach ~0.6.
    if (bestRatio < 0.75) {
      // An answer captured in several screenshots can have its stem split
      // across them, leaving no single shot similar enough to the question,
      // while its printed item number is unambiguous. Only an item the key
      // never mentions stays unmatched.
      if (cand) return [cand.group, cand.letter];
      return [null, null];
    }
    return [bestGroup, bestLetter];
  }

  /* -- parse question pages -- */
  const items = [];
  const qURLs = [];
  let title = "Self-Assessment";
  const qTexts = [];
  for (let i = 1; i <= nq; i++) {
    onProgress(`Reading questions…`, 0.25 + (i - 1) / nq * 0.05);
    qTexts.push(await getPageText(await qdoc.getPage(i)));
  }
  const qGroups = groupPages(qTexts.map(itemNumber)).map((g) => g.map((i) => i + 1));

  for (let gi = 0; gi < qGroups.length; gi++) {
    const group = qGroups[gi];
    const pno = group[0];
    onProgress(`Preparing question ${gi + 1} of ${qGroups.length}…`,
               0.3 + gi / qGroups.length * 0.7);
    const shots = [];
    for (const p of group) {
      const page = await qdoc.getPage(p);
      const viewport = page.getViewport({ scale: SCALE });
      const w = Math.round(viewport.width), h = Math.round(viewport.height);
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const cx = c.getContext("2d", { willReadFrequently: true });
      await renderPage(page, viewport, cx);
      const im = cx.getImageData(0, 0, w, h);
      shots.push({ canvas: c, img: im, w, h, band: contentBand(im.data, w, h),
                   words: await getPageWords(page, viewport) });
    }
    const st = stitchShots(shots);
    const canvas = st.canvas, img = st.img, rawWords = st.words;
    const top = st.top, bottom = st.bottom;
    const w = st.w, h = st.h;
    const cw = st.w, ch = bottom - top;
    const itemText = group.length === 1 ? qTexts[pno - 1] : textFromWords(rawWords);
    const itemNo = itemNumber(itemText) ?? (gi + 1);

    if (pno === 1) {
      const t = qTexts[0];
      const m = t.match(/([A-Z][A-Za-z ]+Self-Assessment)/);
      if (m) {
        // drop leading header-chrome words (e.g. "Mark", an org name ending
        // in "... Examiners") that share the line with the exam title
        title = m[1].replace(/^(?:.*\bExaminers\s+|.*\bMark\s+)/, "").trim();
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
      pxChoices.push({ letter: L, rowTop, rowBot, lx0: bx.x0, lx1: bx.x1,
                       base: bx.base, tol: (bx.y1 - bx.y0) * 0.4 });
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
    const qStem = stemKey(itemText);
    const [aGroup, letter] = resolveAnswer(itemNo, qStem);

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
      item: itemNo,
      aspect: Math.round(ch / cw * 1e5) / 1e5,
      choices, words, content,
      correct: letter,
      answer_available: aGroup !== null,
      has_answer_image: aGroup !== null,
      a_group: aGroup,
      q_pages: group,
      a_pages: aGroup === null ? [] : aGroups[aGroup],
    });
  }
  onProgress("Done", 1);

  /* -- lazy answer-page rendering -- */
  const aCache = new Map();
  async function answerURL(idx0) {
    const it = items[idx0];
    if (it.a_group === null || it.a_group === undefined) return null;
    if (aCache.has(it.a_group)) return aCache.get(it.a_group);
    const shots = [];
    for (const p of it.a_pages) {
      const page = await adoc.getPage(p);
      const viewport = page.getViewport({ scale: SCALE });
      const c = document.createElement("canvas");
      c.width = Math.round(viewport.width);
      c.height = Math.round(viewport.height);
      const cx = c.getContext("2d", { willReadFrequently: true });
      await renderPage(page, viewport, cx);
      const im = cx.getImageData(0, 0, c.width, c.height);
      shots.push({ canvas: c, img: im, w: c.width, h: c.height,
                   band: contentBand(im.data, c.width, c.height),
                   words: await getPageWords(page, viewport) });
    }
    const url = await new Promise((res) =>
      stitchShots(shots).canvas.toBlob((b) => res(URL.createObjectURL(b)), "image/png"));
    aCache.set(it.a_group, url);
    return url;
  }

  /* -- lazy answer-explanation text extraction --
     Returns { paragraphs: [string] } starting at "Correct Answer: X", grouped
     into paragraphs by the page's vertical line spacing, or null when the
     text is too thin to trust (caller falls back to the page image). */
  const aInfoCache = new Map();
  async function answerInfo(idx0) {
    const it = items[idx0];
    if (it.a_group === null || it.a_group === undefined) return null;
    if (aInfoCache.has(it.a_group)) return aInfoCache.get(it.a_group);
    let info = null;
    try {
      // an answer spanning several shots: run them together as one column of
      // lines, dropping the lines the overlap repeats
      const all = [];
      let shift = 0, prevLast = null;
      for (const p of it.a_pages) {
        const pl = await getPageLines(await adoc.getPage(p), true);
        if (!pl.length) continue;
        if (prevLast !== null) shift = prevLast + 14 - pl[0].y;
        for (const l of pl) all.push({ ...l, y: l.y + shift });
        prevLast = all[all.length - 1].y;
      }
      const seenLine = new Set();
      const lines = all.filter((l) => {
        const k = l.text.replace(/\s+/g, " ").trim();
        if (k.length < 12) return true;
        if (seenLine.has(k)) return false;
        seenLine.add(k);
        return true;
      });
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
    aInfoCache.set(it.a_group, info);
    return info;
  }

  return { count: items.length, title, items, qURLs, answerURL, answerInfo };
}

window.parseExam = parseExam;
