"use strict";
/* Client-side exam PDF parser — a port of the Python parser (app/parsing/parser.py)
   using PDF.js. Everything runs in the browser: the PDFs never leave the
   user's machine.

   parseExam(questionBytes, answerBytes, onProgress, opts) resolves to the same
   data shape the Flask /api/exam endpoint served, plus:
     - qURLs[i]      : blob URL of the cropped question-page image
     - answerURL(i)  : lazy blob URL of the full answer-key page image

   A PDF that is one screenshot per page with no text layer is recognized here
   with tesseract.js, fetched from a CDN only when such a document is detected
   (see "OCR for image-only PDFs" below).

   opts (all optional, used by tests/harness):
     - keepPageImages : keep the page render even for items that parsed as text
*/

const SCALE = 132 / 72;   // same 132 dpi rendering as the server version

/* ---------------- text helpers (ports of _norm/_stem_key/...) ---------- */

function normText(s) {
  // OCR'd text layers separate words with U+00A0, which defeats the literal
  // spaces in the chrome pattern below.
  s = s.replace(/\u00a0/g, " ");
  s = s.replace(/Exam Section[\s\S]*?Self-Assessment/g, " ");
  // the other share format's header: "Question 7 Of 50 (03:41)". The timer
  // differs between a question page and its answer page, so it has to go
  // before the two stems are compared.
  s = s.replace(/Question\s*\d+\s*[Oo]f\s*\d+\s*\(?[\d:]*\)?/g, " ");
  s = s.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function stemKey(text) {
  // the answer key prints a red X before a wrongly answered item's number
  let t = text.replace(/^[\s\S]*?\n[^\S\n]*(?:[Xx\u00d7*\u2713\u221a]\s*)?\d+\s*[.)]\s/, " ");
  t = t.split(/\n\s*[A-Z]\)|C[oa]rrect\s*Answer/)[0];
  return normText(t).slice(0, 350);
}

/* Two share formats, two page headers: the NBME client prints
   "Exam Section : Item 7 of 50", the app the ObGyn forms come from prints
   "Question 7 Of 50 (03:41)". Either one names the item the page belongs to.
   The space can be lost by OCR ("Question 35Of Of 50"), so it is optional. */
const HEADER_ITEM = /(?:Item|Question)\s*(\d+)\s*[Oo]f\b/;

/* Without a header, a page may still print its number on a line of its own
   ("27." above the NBME chrome on Surgery Form 2). That number always sits
   above the answer choices, and it must: OCR reads a choice label "I)" as
   "1)", so on Surgery Form 1 item 30 (choices A to I, no header) the line
   "1) Increase tidal volume" was taken as the item number, the page became a
   second item 1, and the two shared one saved answer. A number found at or
   below choice A is a choice label, not the item's number. Choice A may
   carry the radio circle OCR'd in front of it ("O A)", "OA)", "• A)"). */
const FIRST_CHOICE = /(?:^|\n)[^\S\n]*(?:\S[^\S\n]+|[O0o(•○◯●])?A\s*[.)]\s/;

function itemNumber(text) {
  let m = text.match(HEADER_ITEM);
  if (m) return parseInt(m[1], 10);
  m = text.match(/(?:^|\n)\s*(\d+)\s*[.)]\s+[A-Z(]/);
  if (m) {
    const c = text.match(FIRST_CHOICE);
    if (!c || m.index < c.index) return parseInt(m[1], 10);
  }
  return null;
}

/* The key's lead line normally reads "Correct Answer: G.", but the colon is a
   glyph of its own and some exports lose it: Surgery 3 item 24 prints
   "Correct Answer G." and the item came out with no key at all. The separator
   is therefore optional, which means the pattern must refuse
   "Incorrect Answers: A, B, C" on its own merits — once by what precedes
   "Correct" and once by the plural "Answers" — and must take a letter that
   stands alone, never the initial of the next word. Written without a
   lookbehind so older Safari still parses this file. */
// "Carrect": OCR's reading of Surgery Form 9 item 7's key line.
const CORRECT_ANSWER =
  /(?:^|[^A-Za-z])C[oa]rrect\s*Answer(?!s)\s*[:.\u2013\u2014-]?\s*([A-Z])(?![A-Za-z])/;

function correctLetter(text) {
  const m = text.match(CORRECT_ANSWER);
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
  else if (dark.length) {
    // A capture pasted onto a larger sheet leaves white below it, so the
    // footer bar stops well short of the page bottom: Surgery Form 2's sits at
    // 0.70–0.75 of page height on every page, under the 0.78 cut, and the
    // whole footer ("Next / Lab Values / Review / Help / Pause") was landing
    // inside the last choice on 45 of its 48 text-mode items. Fall back to the
    // last run of navy rows, which is the footer whatever height it sits at --
    // but only below the middle of the page, so a dark figure in the content
    // area is never mistaken for one.
    // The footer is not one solid run: the seal watermark lightens its middle,
    // so it breaks into two bands a few rows apart, and taking the last of
    // them would cut inside the footer and leave its labels in the item. Join
    // runs closer together than a twentieth of the page, which is far below
    // the distance from the content to the footer.
    const gap = Math.max(4, h * 0.05);
    const runs = [];
    for (const y of dark) {
      const last = runs.length ? runs[runs.length - 1] : null;
      if (last && y - last[1] <= gap) last[1] = y;
      else runs.push([y, y]);
    }
    const foot = runs[runs.length - 1];
    if (foot && foot[0] > h * 0.5 && foot[0] > top) bottom = foot[0];
  }
  if (top === 0 && bottom === h) {
    // No navy bars at all: the ObGyn share app draws its header and its
    // toolbar as flat light-grey strips on a white page. The content is what
    // is white, so walk in from each edge while the rows are not — which
    // steps over the toolbar's coloured icons, where a rule looking for grey
    // rows alone stops short and leaves "Define" in the stem.
    const whiteRow = (y) => {
      let wh = 0, n = 0;
      const row = y * w * 4;
      for (let x = 0; x < w; x += 2) {
        const i = row + x * 4;
        if (data[i] >= 253 && data[i + 1] >= 253 && data[i + 2] >= 253) wh++;
        n++;
      }
      return wh / n > 0.6;
    };
    let y = 0;
    while (y < h * 0.22 && !whiteRow(y)) y++;
    top = y;
    y = h - 1;
    while (y > h * 0.78 && !whiteRow(y)) y--;
    bottom = y + 1;
  }
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
   radio circles and text are ink too. But an exhibit can carry on past
   choice A — a two-column item whose figure sits beside the stem, or simply a
   tall image — and scanning only the stem band slices it in half.

   Choice text is masked like any other text; the radio circles are drawn, not
   written, so they carry no text box and have to be masked explicitly. Once
   they are, ANY figure can be followed downwards: a column that really does
   share its rows with the choices finds only masked pixels and stops on its
   own. (Before, only a figure starting right of the choice letters was
   followed, so a full-width exhibit, or one in the choice column, was always
   cut off at choice A.) */
function extendFiguresBelow(imgData, figs, stemBot, contentBot, textRects, pxChoices) {
  const data = imgData.data, W = imgData.width;
  const mask = textRects.concat(pxChoices.map((c) => [
    c.cx - c.rad - 6, c.cy - c.rad - 6, c.cx + c.rad + 6, c.cy + c.rad + 6]));
  for (const f of figs) {
    let lastInk = f.y1, gap = 0;
    for (let y = Math.ceil(stemBot); y < Math.floor(contentBot); y += 2) {
      const iv = [];
      for (const r of mask) if (y >= r[1] && y <= r[3]) iv.push([r[0], r[2]]);
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

/* Lab-value tables and other column blocks read fine as text but reflow into
   nonsense, so they are cropped as pictures instead. They are found line by
   line, not paragraph by paragraph: a stem and the vitals table under it are
   one paragraph as far as line spacing goes, and classifying the paragraph
   used to turn the whole stem into an image — no selectable text, nothing in
   the results export.

   A line is columnar when it has an internal gap far wider than the page's own
   word spacing, or when it starts well right of the text margin and is short.
   The second test matters because a table whose label column the PDF draws
   rather than writes (Surgery 6 item 44 prints "pH", "Pco2"… as vectors)
   leaves a value column with no wide gap of its own. Two adjacent columnar
   lines make a table; a lone one is an OCR hole in a prose line, so it is
   ignored. A short line with no gap — a "Serum" sub-heading, a wrapped value —
   joins a run it sits inside. */
function findTableRuns(lines, cw) {
  if (lines.length < 2) return [];
  const gaps = [];
  for (const L of lines) {
    for (let i = 1; i < L.words.length; i++) gaps.push(L.words[i].x0 - L.words[i - 1].x1);
  }
  const gapThr = Math.max(median(gaps) * 5, cw * 0.02, 10);
  const prose = lines.filter((L) => L.words.length >= 8);
  const textLeft = Math.min(...(prose.length ? prose : lines).map((L) => L.x0));
  const indent = textLeft + cw * 0.075;
  const pitches = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].base - lines[i - 1].base;
    if (d > 2) pitches.push(d);
  }
  const pitch = median(pitches) || 26;

  const runs = [];
  let cur = null;
  lines.forEach((L, i) => {
    let g = 0;
    for (let k = 1; k < L.words.length; k++) g = Math.max(g, L.words[k].x0 - L.words[k - 1].x1);
    const columnar = g > gapThr || (L.x0 > indent && L.words.length <= 8);
    if (!columnar) { cur = null; return; }
    if (cur && L.base - lines[i - 1].base < pitch * 2.2) cur.push(L);
    else { cur = [L]; runs.push(cur); }
  });
  return runs.filter((r) => r.length >= 2);
}

/* Answer choices are not always one column. A ten-choice item prints A to E
   down the left half and F to J down the right; a seventeen-choice one runs
   A to I left and J to Q right. Cluster the label boxes by x0 — jitter within
   one column is a few pixels (the labels are right-aligned, so "I)" starts
   further right than "M)"), while the step to the next column is most of the
   page — and return the columns left to right, each with its members in
   reading order down the page.

   Everything downstream then bounds a choice by its own column: its row ends
   at the next label in that column (not the next letter, which may be back at
   the top of the next column) and stops short of the next column's radio. */
function choiceColumns(ordered, cw) {
  const thr = Math.max(cw * 0.08, 40);
  const byX = ordered.map((_, i) => i)
    .sort((a, b) => ordered[a][1].x0 - ordered[b][1].x0);
  const cols = [];
  let cur = null;
  for (const i of byX) {
    const x0 = ordered[i][1].x0;
    if (!cur || x0 - cur.xLast > thr) { cur = { x0, xLast: x0, members: [] }; cols.push(cur); }
    cur.xLast = x0;
    cur.members.push(i);
  }
  cols.forEach((c) => c.members.sort((a, b) => ordered[a][1].y0 - ordered[b][1].y0));
  return cols;
}

/* The first stem line printed BELOW the answer choices, or null.

   A matching set ("For each patient with a limp, select the most likely
   diagnosis.") prints its shared lead-in, then the whole lettered list, and
   only then the patient's vignette, so the page reads choices-then-stem.
   Taking it as stem-then-choices gives the item no stem of its own and hands
   the vignette to the last choice, whose text band runs to the foot of the
   page — which is how "I) Toxic synovitis A previously healthy 14-year-old
   boy…" reached the results export.

   A wrapped continuation line of the last choice is indented to the choice
   text, while stem prose starts at the page's left margin, left of even the
   choice letters — that is what tells the two apart. The button glyphs above
   the footer bar are not stem text either, so what is found below has to be a
   real paragraph's worth of words. Port of _stem_below_choices in
   app/parsing/parser.py. */
function stemBelowChoices(raw, ordered, bottom) {
  if (!ordered.length) return null;
  const labelLeft = Math.min(...ordered.map(([, b]) => b.x0));
  let last = ordered[0][1];
  for (const [, b] of ordered) if (b.base > last.base) last = b;
  const floor = last.base + (last.y1 - last.y0) * 0.4;
  const below = raw.filter((w) => w.base > floor && w.y1 <= bottom &&
                                  /[A-Za-z0-9]/.test(w.text));
  if (!below.length) return null;
  const lines = clusterTextLines(below);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].x0 >= labelLeft - 4) continue;
    let wordy = 0;
    for (let k = i; k < lines.length; k++) {
      for (const w of lines[k].words) if (/[A-Za-z]{3,}/.test(w.text)) wordy++;
    }
    return wordy >= 10 ? lines[i] : null;
  }
  return null;
}

/* Build the structured content for one question page: stem paragraphs with
   inline figure crops, plus per-choice text runs. Returns null when the page
   doesn't extract cleanly (caller falls back to image mode). */
async function buildItemContent(raw, pxChoices, top, cw, ch, canvas, imgData,
                                bodyBase) {
  if (!pxChoices.length) return null;
  // The topmost choice, not choice A: with the choices in two columns the
  // right column's first label can sit a few pixels above A's.
  const stemBot = Math.min(...pxChoices.map((c) => c.rowTop));
  // The stem ends at the first choice's BASELINE, not at the top of its box.
  // A word's box is y0 = baseline - fontSize, y1 = baseline + 0.25*fontSize,
  // so a last stem line only a line and a half above choice A failed
  // `y1 <= rowTop` and vanished from the text render entirely. The choice rows
  // below are already bounded by baselines for the same reason.
  const stemLimit = Math.min(...pxChoices.map((c) => c.base - c.tol));
  // bodyBase: the baseline of the first stem line printed BELOW the choices
  // (a matching set, see stemBelowChoices). Those lines are stem too — they
  // are the item's whole vignette — so they join the stem here and are kept
  // out of the last choice's band further down.
  const belowFrom = bodyBase == null ? null : bodyBase - 2;
  const stemWords = raw.filter((w) => w.y0 >= top - 2 &&
    (w.base < stemLimit ||
     (belowFrom !== null && w.base >= belowFrom && w.y1 <= top + ch)));
  if (stemWords.length < 5) return null;

  // ---- figures: ink regions outside every text box, then column blocks -----
  // lines first: merging two figures must never produce a rectangle that
  // swallows body text sitting between them (see mergeBlocked below)
  let lines = clusterTextLines(stemWords);
  const pitches = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].base - lines[i - 1].base;
    if (d > 2) pitches.push(d);
  }
  const pitch = median(pitches) || 26;
  const textRects = (raw.itemRects || [])
    .map((r) => [r[0] - 4, r[1] - 4, r[2] + 4, r[3] + 4]);
  // Note: line-sized ink slivers are kept. They are usually a line of text the
  // source's OCR layer missed entirely (Surgery 8 item 50's "of action?"), and
  // cropping them is the only way those words reach the reader at all.
  let figs = inkFigures(imgData, top, stemBot, textRects);

  function figsTouch(a, b) {
    const ovX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
    const ovY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    // two halves of one region, near-touching in both axes
    if (ovY > -8 && ovX > -40) return true;
    // one column with a small vertical break: a two-panel image, or a table
    // with a blank row, which inkFigures splits at any gap over 12px
    if (ovX > Math.min(a.x1 - a.x0, b.x1 - b.x0) * 0.5 && ovY > -36) return true;
    // A table's label column can be drawn rather than written (Surgery 6
    // item 44 prints "pH", "Pco2"… as vectors), leaving it a separate ink
    // region a column's width away from the values it labels. Join the two,
    // but only when the shorter region sits entirely within the other's rows:
    // an exhibit that merely shares a band with the table would otherwise drag
    // the union rectangle across the stem between them.
    if ((a.tbl || b.tbl) && ovY >= Math.min(a.y1 - a.y0, b.y1 - b.y0) - 8 &&
        ovX > -cw * 0.15) return true;
    return false;
  }
  /* Two figures in neighbouring columns can be a few pixels apart and still
     share rows, and their union is then a rectangle covering the stem text
     above or beside them. Refuse such a merge: if a body line lands well
     inside the union but touches neither box, the two are separate figures. */
  function mergeBlocked(a, b) {
    const ux0 = Math.min(a.x0, b.x0), uy0 = Math.min(a.y0, b.y0);
    const ux1 = Math.max(a.x1, b.x1), uy1 = Math.max(a.y1, b.y1);
    const over = (f, L) => Math.max(0, Math.min(f.x1, L.x1) - Math.max(f.x0, L.x0)) *
                           Math.max(0, Math.min(f.y1, L.y1) - Math.max(f.y0, L.y0));
    return lines.some((L) => {
      if (L.inFig) return false;
      const area = Math.max(1, (L.x1 - L.x0) * (L.y1 - L.y0));
      return over({ x0: ux0, y0: uy0, x1: ux1, y1: uy1 }, L) / area > 0.3 &&
             !over(a, L) && !over(b, L);
    });
  }
  function mergeFigs() {
    let merged = true;
    while (merged) {
      merged = false;
      outer:
      for (let i = 0; i < figs.length; i++) {
        for (let j = i + 1; j < figs.length; j++) {
          if (figsTouch(figs[i], figs[j]) && !mergeBlocked(figs[i], figs[j])) {
            figs[i] = {
              y0: Math.min(figs[i].y0, figs[j].y0), y1: Math.max(figs[i].y1, figs[j].y1),
              x0: Math.min(figs[i].x0, figs[j].x0), x1: Math.max(figs[i].x1, figs[j].x1),
              tbl: figs[i].tbl || figs[j].tbl,
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

  // Words sitting inside an ink region are part of the picture: an "R"/"L"
  // orientation marker on an x-ray, a value printed inside a chart. Drop them
  // before the lines are formed — a marker that happens to share a baseline
  // with body text otherwise stretches that line across the page, and the hole
  // it leaves looks exactly like a table column.
  //
  // Only islands are dropped: a word is part of the picture when its whole
  // line is inside the figure, or when it sits far from the nearest word on
  // its line that isn't. A stem line whose last word merely reaches the edge
  // of the exhibit beside it (OCR word boxes are a few pixels off, so the
  // figure's detected edge can overlap it) stays text.
  const inFigWord = (w) => {
    const cx = (w.x0 + w.x1) / 2, cy = (w.y0 + w.y1) / 2;
    return figs.some((f) => cx > f.x0 - 4 && cx < f.x1 + 4 &&
                            cy > f.y0 - 4 && cy < f.y1 + 4);
  };
  if (figs.length) {
    const allGaps = [];
    for (const L of lines) {
      for (let i = 1; i < L.words.length; i++) allGaps.push(L.words[i].x0 - L.words[i - 1].x1);
    }
    const islandGap = Math.max(median(allGaps), 2) * 6;
    const drop = new Set();
    for (const L of lines) {
      const ins = L.words.map(inFigWord);
      L.words.forEach((w, i) => {
        if (!ins[i]) return;
        let d = Infinity;
        L.words.forEach((o, j) => {
          if (ins[j]) return;
          d = Math.min(d, o.x0 >= w.x1 ? o.x0 - w.x1 : w.x0 - o.x1);
        });
        if (d > islandGap) drop.add(w);
      });
    }
    if (drop.size) {
      lines = clusterTextLines(stemWords.filter((w) => !drop.has(w)));
      if (!lines.length) return null;
    }
  }

  for (const run of findTableRuns(lines, cw)) {
    run.forEach((L) => { L.inFig = true; });
    figs.push({ tbl: 1,
      x0: Math.min(...run.map((L) => L.x0)) - 4, x1: Math.max(...run.map((L) => L.x1)) + 4,
      y0: Math.min(...run.map((L) => L.y0)) - 4, y1: Math.max(...run.map((L) => L.y1)) + 4 });
  }
  mergeFigs();

  // Text that belongs to a figure — a label inside a diagram, an axis label or
  // a caption right above or below it — is absorbed into it. Whole lines only,
  // and only lines that fit inside the figure's own column: the old rule
  // matched word by word with 110px of vertical slack, so it took the middle
  // out of stem lines that happened to run under an image. The holes it left
  // then looked like table columns, and the whole stem became a picture.
  for (let pass = 0; pass < 3; pass++) {
    let grew = false;
    for (const L of lines) {
      if (L.inFig) continue;
      for (const f of figs) {
        if (!(L.x0 >= f.x0 - 24 && L.x1 <= f.x1 + 24)) continue;
        const inside = L.y0 >= f.y0 - 4 && L.y1 <= f.y1 + 4;
        // a caption is short; a stem line that merely passes above or below a
        // full-width exhibit is not
        const caption = L.words.length <= 8 &&
          L.y0 > f.y0 - pitch * 1.2 && L.y1 < f.y1 + pitch * 1.2;
        if (!inside && !caption) continue;
        L.inFig = true;
        grew = true;
        f.x0 = Math.min(f.x0, L.x0 - 4); f.x1 = Math.max(f.x1, L.x1 + 4);
        f.y0 = Math.min(f.y0, L.y0 - 4); f.y1 = Math.max(f.y1, L.y1 + 4);
        break;
      }
    }
    mergeFigs();
    if (!grew) break;
  }

  const bodyLines = lines.filter((L) => !L.inFig);
  if (bodyLines.reduce((n, L) => n + L.words.length, 0) < 5) return null;

  // ---- body text: lines -> paragraphs ------------------------------------
  // Paragraph breaks are measured against the page's line pitch, taken over
  // every line, not just the body ones: an item whose body is two lines of
  // prose plus a question line under a table has a body-only median equal to
  // the paragraph gap itself, and then nothing ever splits.
  const paras = [];
  let curP = null;
  bodyLines.forEach((L, i) => {
    const gap = i ? L.base - bodyLines[i - 1].base : 0;
    if (!curP || gap > pitch * 1.55) { curP = { lines: [] }; paras.push(curP); }
    curP.lines.push(L);
  });
  paras.forEach((p) => {
    p.y0 = Math.min(...p.lines.map((l) => l.y0));
    p.y1 = Math.max(...p.lines.map((l) => l.y1));
    p.x0 = Math.min(...p.lines.map((l) => l.x0));
    p.x1 = Math.max(...p.lines.map((l) => l.x1));
    p.nWords = p.lines.reduce((n, l) => n + l.words.length, 0);
  });
  // A paragraph belongs to a figure when it sits inside it (text within a
  // bordered table) or is a short caption directly above or below it.
  // A body paragraph that merely overlaps a figure's column stays real text:
  // absorbing it turns the stem into pixels, which are neither selectable nor
  // exported, and that is what the old `xFrac > 0.6 && ovY > -60` rule did to
  // the last paragraph above every full-width exhibit.
  for (let pass = 0; pass < 2; pass++) {
    paras.forEach((p) => {
      if (p.consumed) return;
      const short = p.lines.length <= 2 && p.nWords <= 12;
      for (const f of figs) {
        const ovY = Math.min(f.y1, p.y1) - Math.max(f.y0, p.y0);
        const ovX = Math.min(f.x1, p.x1) - Math.max(f.x0, p.x0);
        const xFrac = ovX / Math.max(1, p.x1 - p.x0);
        const within = p.x0 >= f.x0 - 24 && p.x1 <= f.x1 + 24;
        // On a matching-set page the short paragraph under the boxed
        // "The response options for the next N items are the same" notice is
        // the set's lead-in, not that box's caption: keeping it as text is the
        // difference between an item whose stem reads "For each patient with a
        // limp…" and one that starts mid-vignette.
        const captionBelow = !(bodyBase != null && p.y0 > f.y1);
        if ((ovY > (p.y1 - p.y0) * 0.5 && xFrac > 0.3 && (within || short)) ||
            (short && xFrac > 0.6 && ovY > -pitch * 1.2 && captionBelow)) {
          p.consumed = true;
          f.y0 = Math.min(f.y0, p.y0 - 4); f.y1 = Math.max(f.y1, p.y1 + 4);
          f.x0 = Math.min(f.x0, p.x0 - 4); f.x1 = Math.max(f.x1, p.x1 + 4);
          break;
        }
      }
    });
  }

  // Last, once every figure's extent is settled: follow a figure that carries
  // on past the answer choices. Done here so a taller figure can't feed back
  // into the merging and paragraph-absorbing above, where it could chain
  // across the page and swallow the stem.
  extendFiguresBelow(imgData, figs, stemBot, top + ch, textRects, pxChoices);

  // assemble blocks in reading order, assigning word ids for highlighting
  let wid = 0;
  const blocks = [];
  for (const p of paras.filter((p) => !p.consumed)) {
    const runs = [];
    p.lines.forEach((l) => l.words.forEach((w) => runs.push(wordRun(w, wid++))));
    if (runs.length) blocks.push({ t: "p", y: p.y0, runs });
  }
  // Crop with a 6px margin, clamped to the content area: at 2px a thin table
  // border or an axis line lands right on the edge and gets shaved off.
  // Two corrections first, both about the body text beside a figure. An OCR'd
  // word box a few pixels narrower than its glyphs leaks ink outside the text
  // mask, so a band can start at the tail of the stem line next to it — pull
  // such an edge back past the line, but only while it shaves the outer fifth
  // of the figure. Then hold the margin short of any body line that sits right
  // against the crop, so widening it never drags text into the picture.
  const M = 6;
  for (const f of figs) {
    const fw = f.x1 - f.x0;
    let x0 = f.x0, x1 = f.x1;
    const sameRows = (L) => Math.min(f.y1, L.y1) - Math.max(f.y0, L.y0) > 0;
    for (const L of bodyLines) {
      if (!sameRows(L)) continue;
      if (L.x0 < f.x0 && L.x1 > x0 && L.x1 < f.x0 + fw * 0.2) x0 = L.x1 + 2;
      if (L.x1 > f.x1 && L.x0 < x1 && L.x0 > f.x1 - fw * 0.2) x1 = L.x0 - 2;
    }
    let mL = M, mR = M, mT = M, mB = M;
    for (const L of bodyLines) {
      if (sameRows(L)) {
        if (L.x1 <= x0) mL = Math.min(mL, Math.max(0, x0 - L.x1 - 1));
        if (L.x0 >= x1) mR = Math.min(mR, Math.max(0, L.x0 - x1 - 1));
      }
      if (Math.min(x1, L.x1) - Math.max(x0, L.x0) > 0) {
        if (L.y1 <= f.y0) mT = Math.min(mT, Math.max(0, f.y0 - L.y1 - 1));
        if (L.y0 >= f.y1) mB = Math.min(mB, Math.max(0, L.y0 - f.y1 - 1));
      }
    }
    const bx0 = Math.max(0, x0 - mL), by0 = Math.max(top, f.y0 - mT);
    const bx1 = Math.min(cw, x1 + mR), by1 = Math.min(top + ch, f.y1 + mB);
    const block = {
      t: "img", y: f.y0,
      url: await cropBlob(canvas, bx0, by0, bx1, by1),
      x0f: Math.max(0, bx0 / cw),
      wf: Math.min(1, (bx1 - bx0) / cw),
      // the crop rect in page pixels; only the test harness reads it, but it
      // costs nothing and makes a bad crop diagnosable from items.json alone
      px: [Math.round(bx0), Math.round(by0), Math.round(bx1), Math.round(by1)],
    };
    // a right-side figure with body text beside it floats right so the text
    // wraps around it like the original layout
    const beside = paras.find((p) => !p.consumed &&
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
    // The last choice IN THIS COLUMN runs to the end of the content, never
    // into the footer bar. nextBase is the next label down the same column:
    // bounding by the next letter instead gave the bottom choice of a
    // two-column left column a negative-height band (its "next" letter is the
    // right column's top one), which emptied it and dropped the item to image
    // mode. colRight keeps the run out of the neighbouring column.
    // …and the last one stops at the stem below it on a matching-set page,
    // instead of running the vignette into the choice's own text.
    let to = pc.nextBase != null ? pc.nextBase - pc.nextTol : top + ch;
    if (pc.nextBase == null && belowFrom !== null) to = Math.min(to, belowFrom);
    const colRight = pc.colRight == null ? Infinity : pc.colRight;
    const cws = raw.filter((w) => {
      if (!(w.base >= from && w.base < to)) return false;
      if (w.x0 < pc.lx0 - 2 || w.x0 >= colRight) return false;
      // lw is the label token itself; comparing text would miss the O label,
      // which some text layers spell "0)"
      if (w === pc.lw || w === pc.lw.src || w.text === pc.letter + ")") return false;
      if (w.strike) return false;           // the strike-through button
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

/* The contiguous run of choice labels A, B, C, ... on one page.

   `rx` spells a label: "A)" on the NBME client, "A." on the app the ObGyn
   forms come from, either of them with the unticked radio circle fused onto
   the front ("OA.", "OI."). Only the topmost occurrence of each letter counts,
   and never one above choice A's own line — "37.0C (98.6F)" in a vitals table
   hands us an "F)" token a third of a page above the real choices, and a
   phantom F both invents a sixth choice and puts the run out of reading order.
   A second column's first label shares A's line, so a line of slack is
   allowed. Port of _choice_run in app/parsing/parser.py. */
// The unticked radio circle, as OCR reads it: "O", "(O", "(OO", "©", "()"…
const LABEL_JUNK = /^[O0Qo\u00a9\u00ae\u2022()\[\]{}.,_|\-\u2013\u2014]{1,4}$/;

function choiceRun(raw, top, bottom, rx, lineInitial) {
  const cands = new Map();
  for (const wd of raw) {
    const m = wd.text.match(rx);
    if (!m) continue;
    if (wd.y0 < top || wd.y1 > bottom) continue;
    // A label opens its row. Only the radio circle, when OCR read it as a
    // token of its own, may sit to its left. Without this a choice ending in
    // "...vitamin E." would be read as the next choice in the run — which is
    // why the bracketed spelling, unambiguous on its own, does not ask for it
    // (a two-column grid's right-hand labels share a row with the left's).
    if (lineInitial) {
      const lh = wd.y1 - wd.y0;
      const tol = lh * 0.5;
      // Only a word butting up against this one disqualifies it. Anything
      // further left belongs to another column: on Form 2's matching sets the
      // gutter before the right-hand label is 1.3 to 3.8 line boxes wide,
      // while a word space inside a choice is about a tenth of one, so the
      // two never come close. Without this the right column is rejected
      // outright -- item 27 stopped at I and lost options J through R.
      const left = raw.filter((o) => o !== wd && Math.abs(o.base - wd.base) <= tol &&
                                     o.x1 <= wd.x0 + 2 && wd.x0 - o.x1 < lh * 0.6);
      if (!left.every((o) => LABEL_JUNK.test(o.text))) continue;
    }
    // A label letter OCR reads as the digit it looks like. "0" for O was
    // always here; "1" for I turns up on Form 2's 20-option matching sets,
    // where the run has to reach R and stops dead at the missing I.
    const L = m[1] === "0" ? "O" : m[1] === "1" ? "I" : m[1];
    // an unticked radio circle read as part of the label — keep the right
    // edge, since the circle sits in the part being dropped, and remember the
    // token itself so the choice's own text can still exclude it
    const bx = wd.text.length > 2
      ? { ...wd, x0: wd.x1 - (wd.x1 - wd.x0) * 2 / wd.text.length, src: wd }
      : wd;
    if (!cands.has(L)) cands.set(L, []);
    cands.get(L).push(bx);
  }
  for (const list of cands.values()) list.sort((a, b) => a.y0 - b.y0);
  const boxes = new Map();
  const aList = cands.get("A");
  if (aList) {
    const floor = aList[0].base - (aList[0].y1 - aList[0].y0);
    for (const [L, list] of cands) {
      const b = list.find((wd) => wd.base >= floor);
      if (b) boxes.set(L, b);
    }
  }
  const ordered = [];
  let code = 65;
  for (;;) {
    const L = String.fromCharCode(code);
    if (boxes.has(L)) { ordered.push([L, boxes.get(L)]); code++; continue; }
    // A single missing letter, rebuilt from the rows on either side of it.
    // OCR drops or fuses one label often enough -- Form 2 item 27's "O)" came
    // back as nothing at all, Form 1 item 13's "E)" as "E)5L" -- and without
    // this the run stops at the hole and every choice below it is swallowed
    // by the choice above. Both neighbours must be present, in the same
    // column, and about two rows apart, so a stray "G)" further down the page
    // can never extend a run that has genuinely ended.
    const after = boxes.get(String.fromCharCode(code + 1));
    const prev = ordered.length ? ordered[ordered.length - 1][1] : null;
    if (!prev) break;
    const lh = prev.y1 - prev.y0;
    // The row pitch, from every label found on the page and not just the run
    // so far: with only A behind it the run has no spacing of its own, and
    // the guess of 2.2 line boxes is too wide for Surgery Form 9's tight
    // rows, so a hole at B (items 29, 32, 40, 41) was never filled.
    let pitch = lh * 2.2;
    {
      const found = [...boxes].sort((a, b) => a[0].charCodeAt(0) - b[0].charCodeAt(0));
      const d = [];
      for (let i = 1; i < found.length; i++) {
        const [L0, b0] = found[i - 1], [L1, b1] = found[i];
        if (Math.abs(b1.x0 - b0.x0) > lh * 2) continue;   // another column
        const gap = (b1.base - b0.base) / (L1.charCodeAt(0) - L0.charCodeAt(0));
        if (gap > 0) d.push(gap);
      }
      d.sort((a, b) => a - b);
      if (d.length) pitch = d[d.length >> 1];
    }
    if (after && Math.abs(prev.x0 - after.x0) <= lh * 2) {   // same column
      const span = after.base - prev.base;
      if (span >= pitch * 1.4 && span <= pitch * 2.8) {
        const mid = (a, b) => (a + b) / 2;
        ordered.push([L, { x0: mid(prev.x0, after.x0), x1: mid(prev.x1, after.x1),
                           y0: mid(prev.y0, after.y0), y1: mid(prev.y1, after.y1),
                           base: mid(prev.base, after.base), filled: true }]);
        code++;
        continue;
      }
    }
    if (!after) {
      // Nothing follows the hole, so there is no pair to interpolate between.
      // The letter can still be misread rather than missing: Form 2 item 4's
      // "E)" came back as a second "B)", which leaves a label sitting exactly
      // one row below D that belongs to no choice, and the item showed four
      // options with the fifth glued to the end of the fourth. Claim such a
      // token only when its own letter is already spoken for by a different
      // row -- a genuine new letter is a new choice, not a misreading -- and
      // when it sits one pitch below the last row, in the same column.
      let stray = null;
      for (const [SL, list] of cands) {
        for (const b of list) {
          if (b === boxes.get(SL)) continue;                 // that row's own label
          if (!boxes.has(SL)) continue;                      // not a duplicate
          if (Math.abs(b.x0 - prev.x0) > lh * 0.8) continue;  // another column
          if (Math.abs(b.base - prev.base - pitch) > pitch * 0.35) continue;
          if (!stray || b.base < stray.base) stray = b;
        }
      }
      if (stray) {
        ordered.push([L, { ...stray, relabelled: true }]);
        code++;
        continue;
      }
    }
    // The label is gone altogether but its choice text is not. Surgery Form 9
    // prints small "A." labels hard against the radio circle, and OCR drops
    // whole labels on its rows ("Colonic injury" with nothing in front of it,
    // C and D both missing on items 2 and 5), two in a row or at the end of
    // the list, where neither repair above can reach. The row is rebuilt from
    // a line that opens exactly where the other choices' text opens, one row
    // pitch below the last choice: a wrapped continuation of that choice opens
    // there too, but sits about half a pitch under the line above it, so the
    // gap to the nearest line above is what tells the two apart.
    const orphan = boxes.size >= 2 && orphanRow(raw, [...boxes], prev, pitch, bottom);
    if (!orphan) break;
    ordered.push([L, { x0: prev.x0, x1: prev.x1,
                       y0: orphan.base - (prev.base - prev.y0),
                       y1: orphan.base + (prev.y1 - prev.base),
                       base: orphan.base, filled: true }]);
    code++;
  }
  return ordered;
}

/* The first word of a choice whose label OCR lost: it opens where the other
   choices' text opens, one row pitch (give or take) below the last choice,
   and the line above it is a whole row away, not a wrapped line's spacing. */
function orphanRow(raw, ordered, prev, pitch, bottom) {
  const lh = prev.y1 - prev.y0;
  // Only where rows are spaced wider than wrapped lines. Surgery Form 2 sets
  // its choices a single line apart, so E's wrapped second line ("proceed
  // with the operation", item 21) is a row pitch below E and was read as F.
  if (pitch < lh * 1.4) return null;
  const starts = [];
  for (const [, bx] of ordered) {
    const tol = (bx.y1 - bx.y0) * 0.5;
    const right = raw.filter((o) => Math.abs(o.base - bx.base) <= tol &&
                                    o.x0 >= bx.x1 - 1 && /[A-Za-z0-9]/.test(o.text));
    if (right.length) starts.push(Math.min(...right.map((o) => o.x0)));
  }
  if (starts.length < 2) return null;
  starts.sort((a, b) => a - b);
  const textX = starts[starts.length >> 1];
  const labelX = Math.min(...ordered.map(([, bx]) => bx.x0));
  const cands = raw.filter((o) => Math.abs(o.x0 - textX) <= lh * 0.5 &&
                                  o.y1 <= bottom && /[A-Za-z0-9]/.test(o.text) &&
                                  o.base - prev.base >= pitch * 0.8 &&
                                  o.base - prev.base <= pitch * 1.8)
                  .sort((a, b) => a.base - b.base);
  for (const c of cands) {
    const tol = (c.y1 - c.y0) * 0.5;
    // nothing but radio-circle junk between the label column and this word
    const left = raw.filter((o) => o !== c && Math.abs(o.base - c.base) <= tol &&
                                   o.x1 <= c.x0 + 2 && o.x0 >= labelX - lh * 2);
    if (!left.every((o) => LABEL_JUNK.test(o.text))) continue;
    // the nearest line above, anywhere in the choice's text band
    const above = raw.filter((o) => o.base < c.base - tol && o.base > prev.base - tol &&
                                    o.x0 >= textX - lh * 0.5)
                     .map((o) => o.base);
    const gap = c.base - Math.max(prev.base, ...above);
    if (gap < pitch * 0.8) continue;
    return c;
  }
  return null;
}

/* Two things OCR does to the choice list on Surgery Form 9's client. It reads
   the strike-through button at the right end of every row ("ab" drawn struck
   through) as a word -- "ab", "kr", "te", "=k", "25" -- which then ends every
   choice's text; those tokens are short, have nothing after them on their
   line and sit far from the text before them, so they are kept out of the
   choice text (only there: the flag is read by nothing else). And it fuses a label to its choice's first word ("OB.S1-82" for
   "B. S1-S2"), so the label is never seen; that token is split in two. */
function tidyChoiceWords(raw) {
  const out = [];
  for (const wd of raw) {
    const m = wd.text.match(/^([O0QoCJ©®•(\[]{1,2}[A-Z][.)])([A-Za-z0-9].+)$/);
    if (!m) { out.push(wd); continue; }
    const cut = wd.x0 + (wd.x1 - wd.x0) * m[1].length / wd.text.length;
    out.push({ ...wd, x1: cut, text: m[1] });
    out.push({ ...wd, x0: cut + 1, text: m[2] });
  }
  const labelish = (o) => LABEL_JUNK.test(o.text) ||
    /^[O0QoCJ\u00a9\u00ae\u2022(\[]{0,2}[A-Z][.,)]$/.test(o.text);
  // Short, last on its line, and behind some real choice text: a one-word
  // choice ("ECG") has only its label to its left and is never a candidate.
  const cands = [];
  for (const wd of out) {
    if (wd.text.length > 3) continue;
    const lh = wd.y1 - wd.y0;
    const line = out.filter((o) => o !== wd && Math.abs(o.base - wd.base) <= lh * 0.5);
    if (line.some((o) => o.x0 > wd.x0)) continue;
    const left = line.filter((o) => o.x1 <= wd.x0 + 2).sort((a, b) => a.x0 - b.x0);
    if (!left.some((o) => !labelish(o))) continue;
    cands.push({ wd, lh, left });
  }
  const drop = new Set();
  for (const { wd, lh, left } of cands) {
    // Either it lines up with the same button on other rows -- the box is as
    // wide as its longest choice, so on a list of short choices the button
    // sits right after the text --
    const peers = cands.filter((c) => c.wd !== wd && Math.abs(c.wd.x0 - wd.x0) <= lh * 0.6 &&
                                      Math.abs(c.wd.base - wd.base) > lh);
    if (peers.length >= 2) { drop.add(wd); continue; }
    // -- or, when OCR saw the button on only one row, it sits well clear of
    // the prose before it. A choice laid out as a table row ("7.30  50  24")
    // has wide gaps of its own, and its last cell is data, not the button.
    if (wd.x0 - left[left.length - 1].x1 < lh * 3) continue;
    let gapped = false;
    for (let i = 2; i < left.length; i++) {
      if (left[i].x0 - left[i - 1].x1 > lh * 2) gapped = true;
    }
    if (!gapped) drop.add(wd);
  }
  // Flagged, not removed: the glyph's ink has to stay covered by a word box,
  // or figure detection takes it for an exhibit and swallows the stem.
  const res = out.map((wd) => drop.has(wd) ? { ...wd, strike: true } : wd);
  res.itemRects = raw.itemRects;   // the text boxes figure detection masks
  return res;
}

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

/* One group of 1-based page numbers per item, skipping pages that belong to
   no item at all: ObGyn Form 9's export carries a 1004x30 strip (a Touch Bar
   screenshot caught by the capture), which names no item and holds no text,
   and which would otherwise become an item of its own and shift every item
   after it by one. Port of ExamParser._groups. */
function itemGroups(texts) {
  const pages = [], nums = [];
  texts.forEach((t, i) => {
    const n = itemNumber(t);
    if (n === null && (t.match(/[A-Za-z]{2,}/g) || []).length < 10) return;
    pages.push(i + 1);
    nums.push(n);
  });
  return groupPages(nums).map((g) => g.map((i) => pages[i]));
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

/* ---------------- OCR for image-only PDFs ------------------------------- */

/* Some share PDFs are one screenshot per page with no text layer at all: pdf.js
   finds about 25 characters of t.me watermark and nothing else, so "Item N of
   50", "A)" and "Correct Answer: X" are all invisible and no exam can be built.
   Rather than send the user to a command-line tool, such a document is read
   here with tesseract.js, which is fetched from a CDN only when one is actually
   detected — a PDF that has a text layer never touches the network.

   Everything downstream is unchanged: the OCR result is handed back in exactly
   the shapes getPageWords/getPageLines produce, so stitching, item numbering,
   the choice logic and the answer-key extraction all run as they always do. */

const TESS_VERSION = "5.1.1";          // pinned: the version this was tested on
const TESS_SRC = `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/tesseract.min.js`;
const OCR_DPI = 200;                   // the screenshots are ~2670px wide: about native
const OCR_MIN_PX = 3300;               // ...but see the scale note in ocrDocument
const OCR_MAX_SCALE = 6;               // bound the canvas for a very small page
const OCR_CACHE_VERSION = 2;           // bump to invalidate every cached page
const OCR_DB = "exam-parser-ocr", OCR_STORE = "pages";

/* Load tesseract.js on demand. Its worker, wasm core and language data all
   default to the same jsdelivr CDN, so only this one script has to be named. */
let tessPromise = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (!tessPromise) {
    tessPromise = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = TESS_SRC;
      s.async = true;
      s.onload = () => (window.Tesseract ? res(window.Tesseract)
                                         : rej(new Error("no Tesseract global")));
      s.onerror = () => rej(new Error("script load failed"));
      document.head.appendChild(s);
    }).catch(() => {
      tessPromise = null;
      throw new Error(
        "This PDF has no text layer, so it has to be read with OCR — and the " +
        "OCR engine could not be downloaded. Check your internet connection " +
        "(the engine comes from cdn.jsdelivr.net) and try again, or add a text " +
        "layer to the PDFs first with the OCR tool in the repo's tools/ocr_layer " +
        "folder and load the files it produces.");
    });
  }
  return tessPromise;
}

/* Image-only: under ~60 alphanumeric characters per page over the first three
   pages. Decided per document, so a text questions PDF and a scanned answer
   key can be mixed. */
async function docIsImageOnly(doc) {
  const n = Math.min(3, doc.numPages);
  let chars = 0;
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    for (const it of tc.items) chars += (it.str.match(/[A-Za-z0-9]/g) || []).length;
    page.cleanup();
  }
  return chars / n < 60;
}

async function sha256Hex(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/* IndexedDB page cache. Every call degrades to "no cache" rather than failing:
   private windows, blocked site data and quota errors are all normal. */
function idbOpen() {
  return new Promise((res) => {
    try {
      const rq = indexedDB.open(OCR_DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore(OCR_STORE);
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => res(null);
      rq.onblocked = () => res(null);
    } catch (e) { res(null); }
  });
}
function idbGet(db, key) {
  return new Promise((res) => {
    if (!db) return res(null);
    try {
      const rq = db.transaction(OCR_STORE, "readonly").objectStore(OCR_STORE).get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    } catch (e) { res(null); }
  });
}
function idbPut(db, key, val) {
  return new Promise((res) => {
    if (!db) return res();
    try {
      const tx = db.transaction(OCR_STORE, "readwrite");
      tx.objectStore(OCR_STORE).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror = () => res();
      tx.onabort = () => res();
    } catch (e) { res(); }
  });
}

/* Render one page for OCR and flatten it to luminance. Tesseract silently
   drops whole coloured regions — a yellow-highlighted choice row, the blue
   "Correct Answer" line — and a grey page comes back with half again as many
   words on those pages. */
async function renderForOcr(doc, pno, scale) {
  const page = await doc.getPage(pno);
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  await renderPage(page, vp, ctx);
  page.cleanup();
  const im = ctx.getImageData(0, 0, c.width, c.height);
  const d = im.data;
  for (let i = 0; i < d.length; i += 4) {
    const g = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(im, 0, 0);
  return c;
}

/* ---- token cleanups (ported from the Vision pipeline's build_layer.py) ---- */

const OCR_MARKERS = new Set(["X", "x", "×", "%", "*", "✓", "√", "'", '"']);
// a junk token before a choice letter is the radio circle, read as one of these
const OCR_JUNK = /^[Oo0QJCG©®•()\[\]{}.,_|\-—–\s]+$/;

/* "(A)", "[A)", "OA)", "©A)", "BE)", "F.)" are all the radio circle fused to a
   choice letter. Keep the last letter before the ")" and pull the box in from
   the left, because the circle occupies the part being dropped. */
function unfuseChoiceLabel(t) {
  const m = t.text.match(/^(.{0,3}?)([A-Z])\.?\)$/);
  if (!m || /[a-z]/.test(m[1])) return t;
  const dropped = t.text.length - 2;
  if (!dropped) return t;
  return { ...t, text: m[2] + ")",
           x0: t.x0 + (t.x1 - t.x0) * (dropped / t.text.length) };
}

function cleanOcrTokens(toks, hdr, takeItemNo) {
  // "B" + ")" -> "B)"
  const merged = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^[A-Z]$/.test(t.text) && i + 1 < toks.length && toks[i + 1].text === ")") {
      merged.push({ ...t, text: t.text + ")", x1: toks[i + 1].x1 });
      i++;
    } else merged.push(t);
  }
  toks = merged.map((t, i) => (i <= 2 ? unfuseChoiceLabel(t) : t));

  // Low-confidence junk goes, but only after the label has been unfused: a
  // radio circle read as part of the letter ("OC)") drags the whole token's
  // confidence under the threshold, and dropping it costs the item a choice.
  toks = toks.filter((t) => t.c === undefined || t.c >= 25 || /^.{0,3}\)$/.test(t.text));

  // a red X (or a check, or a stray quote) precedes a wrongly answered item's
  // number on answer pages
  if (toks.length >= 2 && OCR_MARKERS.has(toks[0].text) &&
      /^\d{1,2}\.?$/.test(toks[1].text)) toks = toks.slice(1);

  // the item number that opens the stem must read "31.", not "31"
  if (takeItemNo && hdr && toks.length > 1 && toks[0].text === hdr) {
    toks[0] = { ...toks[0], text: hdr + "." };
  }

  // Radio-circle leftovers immediately before a choice letter. The letter is
  // not always readable — a circle touching a C comes back as "(OO" + "€)" —
  // so a short low-confidence token ending in ")" counts as the label here and
  // repairChoiceRun works out which letter it is afterwards.
  let li = toks.findIndex((t) => /^[A-Z]\)$/.test(t.text));
  // The circle itself reads as a label often enough: an untouched radio comes
  // back as "O)" or "C)", which the letter range now matches. When a second
  // label-shaped token follows it in the same breath, the first one is the
  // circle and the second is the real letter.
  if (li >= 0 && li <= 1 && OCR_JUNK.test(toks[li].text)) {
    const nx = toks.findIndex((t, i) => i > li && /^[A-Z]\)$/.test(t.text));
    if (nx > 0 && nx <= 2) li = nx;
  }
  if (li < 0) {
    li = toks.findIndex((t) => /^.{0,3}\)$/.test(t.text) &&
                               (t.c === undefined || t.c < 60));
  }
  if (li > 0 && li <= 2 && toks.slice(0, li).every((t) => OCR_JUNK.test(t.text))) {
    toks = toks.slice(li);
  }

  return toks.filter((t) => /[A-Za-z0-9]/.test(t.text) || /^.{0,3}\)$/.test(t.text));
}

/* The choice letter itself can be misread, or missed altogether: with the
   radio circle touching it, "C)" comes back as "€)" and sometimes as nothing
   at all. Because the parser only keeps a contiguous run from A, one bad
   letter costs the item every choice from there down.

   The labels sit one per row in a single column, with the choice text in a
   second column, so the run can be rebuilt positionally. Take every line that
   opens in either column, letter them in page order, and accept the result
   only when every cleanly read label already agrees with the letter its
   position implies AND the sequence starts at A — anything else (a wrapped
   choice line, an explanation paragraph at the same indent) breaks the
   agreement and the page is left alone. */
function repairChoiceRun(recs) {
  const head = (r) => r.toks[0];
  const clean = (t) => /^[A-Z]\)$/.test(t.text);
  const good = recs.filter((r) => head(r) && clean(head(r)));
  if (good.length < 2) return;
  const colX = median(good.map((r) => head(r).x0));
  const labW = median(good.map((r) => head(r).x1 - head(r).x0));
  const withText = good.filter((r) => r.toks.length > 1);
  if (!withText.length) return;
  const textX = median(withText.map((r) => r.toks[1].x0));
  if (textX - colX < labW * 0.8) return;     // can't tell the columns apart

  const cand = recs.filter((r) => {
    const t = head(r);
    if (!t) return false;
    // a label, however badly read, still looks like one and sits in the label
    // column — which on some forms is also the stem's left margin, so the
    // shape test matters. A circle fused into the letter ("OF") swallows the
    // bracket and starts a circle's width further left.
    if (Math.abs(t.x0 - colX) <= 12) return /^.{0,3}\)$/.test(t.text);
    if (t.x0 > colX - labW * 2 && t.x0 < colX) {
      return /^[Oo0Q\u00a9\u00ae\u2022(\[]{1,2}[A-Z]$/.test(t.text);
    }
    // no label read at all: the line starts at the choice-text column
    return Math.abs(t.x0 - textX) <= 12;
  }).sort((a, b) => a.b - b.b);
  if (cand.length < 2) return;

  // Where does A sit? A prose line can look like a label ("(T,)" in the stem
  // above the choices), so try each start and keep the one that letters every
  // cleanly read label correctly.
  let i0 = -1;
  for (let i = 0; i < cand.length && i0 < 0; i++) {
    let ok = true;
    for (let j = 0; j < cand.length; j++) {
      if (!clean(head(cand[j]))) continue;
      if (j < i || head(cand[j]).text.charCodeAt(0) !== 65 + (j - i)) { ok = false; break; }
    }
    if (ok) i0 = i;
  }
  if (i0 < 0) return;

  // and where does it stop? Rows of choices are evenly spaced; a bigger gap
  // after the last real label means the next candidate is something else.
  const gaps = [];
  for (let j = i0 + 1; j < cand.length; j++) gaps.push(cand[j].b - cand[j - 1].b);
  const rowGap = median(gaps) || 1;
  const lastGood = cand.lastIndexOf(good[good.length - 1]);
  let i1 = cand.length - 1;
  for (let j = i0 + 1; j < cand.length; j++) {
    if (j > lastGood && cand[j].b - cand[j - 1].b > rowGap * 1.7) { i1 = j - 1; break; }
  }

  let fixes = 0;
  for (let j = i0; j <= i1; j++) if (!clean(head(cand[j]))) fixes++;
  if (!fixes) return;
  for (let j = i0; j <= i1; j++) {
    const r = cand[j], t = head(r);
    if (clean(t)) continue;
    const want = String.fromCharCode(65 + (j - i0)) + ")";
    if (t.x0 < textX - labW * 0.5) {
      // a misread label: keep the row, fix the text, and put the box back in
      // the label column (a fused circle drags x0 left of it)
      t.text = want;
      t.x1 = colX + labW;
      t.x0 = colX;
    } else {
      // the label was not recognised at all: put one back where it belongs
      r.toks.unshift({ text: want, x0: colX, x1: colX + labW, c: 99 });
    }
  }
}

/* Turn one tesseract.js result into the cached per-page record: one entry per
   visual line, with a single baseline and font size, because that is what the
   downstream line/row logic keys on. Coordinates are divided back to PDF
   points so any render scale can use them. */
function ocrPageRecord(data, scale, height, hdr) {
  const raw = [];
  for (const b of data.blocks || []) {
    for (const p of b.paragraphs || []) {
      for (const l of p.lines || []) {
        const ws = (l.words || []).filter((w) => w.text && w.text.trim());
        if (!ws.length) continue;
        raw.push({ l, ws });
      }
    }
  }
  if (!raw.length) return { v: OCR_CACHE_VERSION, L: [] };

  const heights = raw.map(({ l }) => l.bbox.y1 - l.bbox.y0);
  const medH = median(heights) || 20;
  // tesseract's font_size is not dependable; the cap height is
  const sizes = raw.map(({ l }) => (baselineAt(l, (l.bbox.x0 + l.bbox.x1) / 2) - l.bbox.y0) / 0.73);
  const medFs = median(sizes.filter((s) => s > 0)) || medH * 1.3;

  const out = [];
  let itemNoTaken = false;
  raw.forEach(({ l, ws }, i) => {
    const inContent = l.bbox.y0 > height * 0.06 && l.bbox.y1 < height * 0.94;
    const lh = l.bbox.y1 - l.bbox.y0;
    // a line the scroll screenshot cut in half is unreadable, not text
    if (inContent && lh < medH * 0.65 && ws.length >= 3) return;
    const meanConf = ws.reduce((s, w) => s + w.confidence, 0) / ws.length;
    const nearEdge = l.bbox.y0 < height * 0.10 || l.bbox.y1 > height * 0.90;
    if (inContent && nearEdge && meanConf < 50) return;

    let toks = ws.map((w) => ({ text: w.text, x0: w.bbox.x0, x1: w.bbox.x1,
                                c: w.confidence }));
    const takeItemNo = inContent && !itemNoTaken;
    toks = cleanOcrTokens(toks, hdr, takeItemNo);
    if (!toks.length) return;
    if (takeItemNo && hdr && toks[0].text === hdr + ".") itemNoTaken = true;

    const base = baselineAt(l, (l.bbox.x0 + l.bbox.x1) / 2);
    // Clamp hard to the page's own font size. The cap-height estimate swings
    // by a third depending on whether a line happens to contain a tall
    // ascender, and clusterTextLines folds a line into its neighbour as a
    // subscript once it looks 20 percent shorter — which interleaved two stem
    // lines word by word and scrambled the sentence. A tight band keeps every
    // body line the same height, and the page's body text really is one size.
    let fs = Math.max(1, sizes[i]);
    fs = Math.max(medFs * 0.9, Math.min(medFs * 1.1, fs));
    out.push({ b: base, f: fs, toks });
  });
  out.sort((a, b) => a.b - b.b);
  repairChoiceRun(out);
  applyDotChoiceLabels(out);
  // now that the labels are settled, the tokens kept only because they might
  // have been one can go if they are still unreadable
  const L = [];
  for (const r of out) {
    const toks = r.toks.filter((t) => /^[A-Z]\)$/.test(t.text) ||
                                      ((t.c === undefined || t.c >= 25) &&
                                       /[A-Za-z0-9]/.test(t.text)));
    if (!toks.length) continue;
    L.push({
      b: +(r.b / scale).toFixed(2),
      f: +(r.f / scale).toFixed(2),
      w: toks.map((t) => [+(t.x0 / scale).toFixed(2), +(t.x1 / scale).toFixed(2), t.text]),
    });
  }
  return { v: OCR_CACHE_VERSION, L };
}

function baselineAt(l, x) {
  const b = l.baseline;
  if (!b || !b.has_baseline) return l.bbox.y1;
  const span = b.x1 - b.x0;
  if (Math.abs(span) < 1) return b.y0;
  return b.y0 + (b.y1 - b.y0) * ((x - b.x0) / span);
}

/* The real NBME interface labels choices "A." not "A)". Accept that spelling,
   but only when no "A)" run exists and the dotted letters open their lines and
   form a contiguous run from A — otherwise an abbreviation would become a
   choice and shift the whole item. */
function applyDotChoiceLabels(recs) {
  if (recs.some((r) => r.toks.length && /^A\)$/.test(r.toks[0].text))) return;
  const first = new Map();
  for (const r of recs) {
    const m = r.toks.length && r.toks[0].text.match(/^([A-Z])\.$/);
    if (m && !first.has(m[1])) first.set(m[1], r.toks[0]);
  }
  const run = [];
  for (let c = 65; first.has(String.fromCharCode(c)); c++) {
    run.push([String.fromCharCode(c), first.get(String.fromCharCode(c))]);
  }
  if (run.length < 2) return;
  run.forEach(([letter, tok]) => { tok.text = letter + ")"; });
}

/* ---- the OCR pass over one document ------------------------------------ */

async function ocrDocument(doc, hash, label, onProgress, span) {
  const Tesseract = await loadTesseract();
  const n = doc.numPages;
  // no hash (crypto.subtle needs a secure context) means no cache, not no OCR
  const db = hash ? await idbOpen() : null;
  const pages = new Map();
  const todo = [];
  for (let p = 1; p <= n; p++) {
    const rec = db ? await idbGet(db, `${hash}:${OCR_CACHE_VERSION}:${p}`) : null;
    if (rec && rec.v === OCR_CACHE_VERSION) pages.set(p, rec);
    else todo.push(p);
  }
  const stats = { pages: n, cached: n - todo.length, headerFallback: 0, noHeader: [] };
  if (!todo.length) {
    onProgress(`${label} — reading cached text…`, span[1]);
    return { pages, stats };
  }

  const nw = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 1));
  const scheduler = Tesseract.createScheduler();
  const workers = [];
  const wopts = {
    workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESS_VERSION}/dist/worker.min.js`,
    corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESS_VERSION}`,
  };
  for (let i = 0; i < nw; i++) {
    const w = await Tesseract.createWorker("eng", 1, wopts);
    await w.setParameters({ preserve_interword_spaces: "1" });
    scheduler.addWorker(w);
    workers.push(w);
  }

  // How big the capture was pasted varies enormously between shares: Forms 3,
  // 9 and 10 carry it at native size (a 2048-px image on a 2048-pt page),
  // while Form 2's sits on an ordinary 792-pt sheet. A flat 200 dpi therefore
  // renders Form 2's text about 15 px tall against Form 3's 53, and tesseract
  // drops or fuses glyphs that small: Form 2 item 31 lost its "C)" label
  // outright and item 43 came back with circle, label and choice text as one
  // "OD)EEG" token. Either one is a hole in the A-B-C-D run, and the choice
  // list stops dead at it. So scale a small page up until its text is a
  // comparable size, and never render below OCR_DPI.
  const first = await doc.getPage(todo[0]);
  const vw = first.getViewport({ scale: 1 }).width;
  first.cleanup();
  const scale = Math.min(OCR_MAX_SCALE, Math.max(OCR_DPI / 72, OCR_MIN_PX / vw));
  let next = 0, done = 0;
  const say = () => onProgress(
    `This PDF has no text layer. Recognizing text in your browser ` +
    `(page ${done} of ${todo.length})…`,
    span[0] + (span[1] - span[0]) * (done / todo.length) * 0.95);
  say();

  const needHeader = [];
  async function pump() {
    for (;;) {
      const i = next++;
      if (i >= todo.length) return;
      const p = todo[i];
      const canvas = await renderForOcr(doc, p, scale);
      const { data } = await scheduler.addJob("recognize", canvas, {},
                                              { blocks: true, text: true });
      const hdr = (data.text.match(HEADER_ITEM) || [])[1] || null;
      const rec = ocrPageRecord(data, scale, canvas.height, hdr);
      if (!hdr) needHeader.push(p);
      pages.set(p, rec);
      canvas.width = canvas.height = 1;      // release the bitmap
      if (db) await idbPut(db, `${hash}:${OCR_CACHE_VERSION}:${p}`, rec);
      done++;
      say();
    }
  }
  await Promise.all(Array.from({ length: Math.min(nw + 1, todo.length) }, pump));
  await Promise.all(workers.map((w) => w.terminate().catch(() => {})));
  try { await scheduler.terminate(); } catch (e) {}

  /* Pages captured with the browser chrome in dark mode put light text on a
     dark bar, and whole-page recognition reads nothing there — which loses
     "Item N of 50" and orphans the page from its item's other screenshots.
     Re-read just the header strip, enlarged, as a single block of text, and
     failing that inverted. */
  if (needHeader.length) {
    const hw = await Tesseract.createWorker("eng", 1, wopts);
    await hw.setParameters({ tessedit_pageseg_mode: "6", preserve_interword_spaces: "1" });
    for (const p of needHeader) {
      onProgress(`Reading page headers (${needHeader.indexOf(p) + 1} of ${needHeader.length})…`,
                 span[1] - (span[1] - span[0]) * 0.04);
      const full = await renderForOcr(doc, p, scale);
      let found = null;
      for (const invert of [false, true]) {
        const strip = headerStrip(full, invert);
        const { data } = await hw.recognize(strip, {}, { blocks: true, text: true });
        strip.width = strip.height = 1;
        if (HEADER_ITEM.test(data.text)) { found = data; break; }
      }
      full.width = full.height = 1;
      if (!found) { stats.noHeader.push(p); continue; }
      const rec = pages.get(p);
      const strip = ocrPageRecord(found, scale * 2, full.height, null);
      // the strip is the page's own top, at twice the scale: its coordinates
      // already divide back to the same points as the rest of the page
      rec.L = strip.L.concat(rec.L).sort((a, b) => a.b - b.b);
      pages.set(p, rec);
      stats.headerFallback++;
      if (db) await idbPut(db, `${hash}:${OCR_CACHE_VERSION}:${p}`, rec);
    }
    await hw.terminate().catch(() => {});
  }
  onProgress(`${label} — done`, span[1]);
  return { pages, stats };
}

function headerStrip(canvas, invert) {
  const h = Math.max(24, Math.round(canvas.height * 0.12));
  const c = document.createElement("canvas");
  c.width = canvas.width * 2;
  c.height = h * 2;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, canvas.width, h, 0, 0, c.width, c.height);
  if (invert) {
    const im = ctx.getImageData(0, 0, c.width, c.height);
    const d = im.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(im, 0, 0);
  }
  return c;
}

/* ---- serving OCR pages in the shapes the parser already speaks ---------- */

function ocrLines(rec) {
  // getPageLines returns PDF-space y (larger is higher) and top line first
  return (rec ? rec.L : []).map((L) => ({
    y: -L.b, text: L.w.map((w) => w[2]).join(" "),
  }));
}

function ocrWords(rec, viewport) {
  const s = viewport.scale;
  const raw = [];
  const itemRects = [];
  for (const L of (rec ? rec.L : [])) {
    const base = L.b * s, fs = L.f * s;
    const y0 = base - fs, y1 = base + 0.25 * fs;
    for (const w of L.w) {
      const x0 = w[0] * s, x1 = w[1] * s;
      itemRects.push([x0, y0, x1, y1]);
      raw.push({ x0, x1, y0, y1, base, text: w[2], it: false, bd: false });
    }
  }
  raw.sort((a, b) => (Math.round(a.base) - Math.round(b.base)) || (a.x0 - b.x0));
  raw.itemRects = itemRects;
  return raw;
}

/* One accessor for a document's text, whether it has a text layer or was
   recognized. Everything in parseExam goes through this, so the OCR path and
   the text path are the same code from here on. */
function makeSource(doc, ocrPages) {
  return {
    doc,
    numPages: doc.numPages,
    ocr: !!ocrPages,
    async lines(p, foldSubscripts) {
      if (ocrPages) return ocrLines(ocrPages.get(p));
      return getPageLines(await doc.getPage(p), foldSubscripts);
    },
    async text(p) {
      return (await this.lines(p)).map((l) => l.text).join("\n");
    },
    async words(p, viewport) {
      if (ocrPages) return ocrWords(ocrPages.get(p), viewport);
      return getPageWords(await doc.getPage(p), viewport);
    },
  };
}

/* ---------------- main ------------------------------------------------- */

async function parseExam(qBytes, aBytes, onProgress, opts) {
  opts = opts || {};
  const pdfjs = window.pdfjsLib;
  // hash first: getDocument transfers the buffers to the pdf.js worker and
  // leaves them detached, and the OCR cache is keyed on the file's bytes
  let qHash = null, aHash = null;
  try {
    qHash = await sha256Hex(qBytes);
    if (aBytes) aHash = await sha256Hex(aBytes);
  } catch (e) { qHash = aHash = null; }   // insecure context: no cache, still works
  const qdoc = await pdfjs.getDocument({ data: qBytes, useSystemFonts: false, disableFontFace: true }).promise;
  // The answer key is optional: a form whose key has not been shared yet still
  // makes a usable practice sitting, with every item flagged as having no key
  // and left out of the score.
  const adoc = aBytes
    ? await pdfjs.getDocument({ data: aBytes, useSystemFonts: false, disableFontFace: true }).promise
    : null;
  const nq = qdoc.numPages, na = adoc ? adoc.numPages : 0;

  // A screenshot-only PDF has no text to read, so recognize it up front. This
  // is the only place tesseract.js is ever fetched.
  const qImageOnly = await docIsImageOnly(qdoc);
  const aImageOnly = adoc ? await docIsImageOnly(adoc) : false;
  const ocrStats = {};
  // contentBand keys on the navy chrome bars; a page it can't find them on
  // falls back to the whole page, which makes stitching align on chrome text.
  // Worth knowing about, so count them.
  const bandFallback = { questions: [], answers: [] };
  let qOcr = null, aOcr = null, base = 0;
  if (qImageOnly || aImageOnly) {
    const OCR_BUDGET = 0.55;            // OCR dominates the wall clock
    const total = (qImageOnly ? nq : 0) + (aImageOnly ? na : 0);
    let at = 0;
    if (qImageOnly) {
      const span = [OCR_BUDGET * at / total, OCR_BUDGET * (at + nq) / total];
      const r = await ocrDocument(qdoc, qHash, "Questions", onProgress, span);
      qOcr = r.pages; ocrStats.questions = r.stats; at += nq;
    }
    if (aImageOnly) {
      const span = [OCR_BUDGET * at / total, OCR_BUDGET * (at + na) / total];
      const r = await ocrDocument(adoc, aHash, "Answer key", onProgress, span);
      aOcr = r.pages; ocrStats.answers = r.stats;
    }
    base = OCR_BUDGET;
  }
  const qSrc = makeSource(qdoc, qOcr);
  const aSrc = adoc ? makeSource(adoc, aOcr) : null;
  const prog = (label, f) => onProgress(label, base + (1 - base) * f);

  /* -- index the answer key (text only, fast) -- */
  const aTexts = [];
  for (let i = 1; i <= na; i++) {
    prog(`Reading answer key…`, (i - 1) / na * 0.25);
    aTexts.push(await aSrc.text(i));
  }
  // An answer can span several screenshots. Group them so the whole answer is
  // shown, but keep matching on each marked shot's own stem, as page-at-a-time
  // indexing did.
  const aGroups = itemGroups(aTexts);
  const answerPages = [];
  const answerByItem = new Map();
  const groupLetter = new Map();
  aGroups.forEach((group, gi) => {
    for (const pno of group) {
      const text = aTexts[pno - 1];
      const letter = correctLetter(text);
      if (!letter) continue;   // continuation shot with no answer marker
      const cand = { group: gi, num: itemNumber(text), letter, key: stemKey(text) };
      answerPages.push(cand);
      if (!groupLetter.has(gi)) groupLetter.set(gi, letter);
      if (cand.num !== null && !answerByItem.has(cand.num)) {
        answerByItem.set(cand.num, cand);
      }
    }
  });

  function resolveAnswer(itemNo, qStem, gi, nq) {
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
      // Last resort, by position, when both files hold the same number of
      // items and so line up one to one. Surgery Form 9's key pages carry no
      // item number and some stems do not survive OCR well enough to match:
      // yellow highlighting over the vignette (item 7), or an image viewer's
      // "Invert / Contrast / Zoom" chrome in front of it (items 12, 18), and
      // four items came out unkeyed while the key sat on the facing page.
      if (aGroups.length === nq && groupLetter.has(gi)) return [gi, groupLetter.get(gi)];
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
    prog(`Reading questions…`, 0.25 + (i - 1) / nq * 0.05);
    qTexts.push(await qSrc.text(i));
  }
  const qGroups = itemGroups(qTexts);
  const usedItemNos = new Set();

  for (let gi = 0; gi < qGroups.length; gi++) {
    const group = qGroups[gi];
    const pno = group[0];
    prog(`Preparing question ${gi + 1} of ${qGroups.length}…`,
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
      const band = contentBand(im.data, w, h);
      if (band[0] === 0 && band[1] === h) bandFallback.questions.push(p);
      shots.push({ canvas: c, img: im, w, h, band,
                   words: await qSrc.words(p, viewport) });
    }
    const st = stitchShots(shots);
    const canvas = st.canvas, img = st.img, rawWords = tidyChoiceWords(st.words);
    const top = st.top, bottom = st.bottom;
    const w = st.w, h = st.h;
    const cw = st.w, ch = bottom - top;
    const itemText = group.length === 1 ? qTexts[pno - 1] : textFromWords(rawWords);
    let itemNo = itemNumber(itemText) ?? (gi + 1);
    // two pages claiming one number would share a saved answer; the later
    // claim is the suspect one, so it falls back to its position
    if (usedItemNos.has(itemNo) && !usedItemNos.has(gi + 1)) itemNo = gi + 1;
    usedItemNos.add(itemNo);

    if (pno === 1) {
      const t = qTexts[0];
      const m = t.match(/([A-Z][A-Za-z ]+Self-Assessment)/);
      if (m) {
        // drop leading header-chrome words (e.g. "Mark", an org name ending
        // in "... Examiners") that share the line with the exam title
        title = m[1].replace(/^(?:.*\bExaminers\s+|.*\bMark\s+)/, "").trim();
      }
    }

    // choice letters: "A)" on the NBME client, "A." on the app the ObGyn forms
    // come from, either of them with the radio circle fused onto the front.
    // The second pass accepts both spellings, because the OCR repair can
    // rewrite a dotted page's clean labels and leave the fused ones behind,
    // and it is taken only when it finds more labels than the unambiguous
    // bracketed pass did.
    let ordered = choiceRun(rawWords, top, bottom, /^([A-Z0])\)$/, false);
    const loose = choiceRun(rawWords, top, bottom,
                            /^[O0QoCJ\u00a9\u00ae\u2022(\[]{0,2}([A-Z01])[.,)]$/, true);
    if (loose.length > ordered.length) ordered = loose;

    const choices = [];
    const pxChoices = [];
    // A matching set prints its choices above the vignette; the bottom
    // choice's row and text band both have to stop where that stem starts.
    const stemLine = stemBelowChoices(rawWords, ordered, bottom);
    const bodyTop = stemLine ? stemLine.y0 - 2 : null;
    // A label-shaped token sitting in the choice block that the run never
    // claimed means the run broke at a letter OCR dropped or fused, and every
    // choice past the hole has been swallowed by the one above it: Form 2's
    // items 27 and 28 print a 20-option matching set in two columns and came
    // back with 8 options, the last of them carrying the other twelve as
    // prose. A list like that cannot be answered and, worse, does not look
    // broken, so hand the item to image mode and show the page as it is.
    let runBroken = false;
    if (ordered.length) {
      // Matched by row, not just by letter: Form 2 item 4's "E)" was read as
      // a second "B)", so the letter looks claimed while its row is not, and
      // the choice went on showing four options with the fifth glued to the
      // end of D.
      const rowOf = new Map(ordered.map(([L, bx]) => [L, bx.base]));
      const firstY = ordered[0][1].y0;
      const lastY = bodyTop !== null ? bodyTop : bottom;
      runBroken = rawWords.some((wd) => {
        if (wd.y0 < firstY || wd.y1 > lastY) return false;
        const m = wd.text.match(/^[O0Qo©®•(\[]{0,2}([A-Z])[.)]$/);
        if (!m) return false;
        const base = rowOf.get(m[1]);
        if (base !== undefined && Math.abs(base - wd.base) <= (wd.y1 - wd.y0)) return false;
        // Only a token that opens its row can be a label. Mid-line it is
        // ordinary prose that happens to look like one -- "Streptococcus
        // pyogenes (group A)" on Form 4 item 44, "E. coli" on Form 5 item 9,
        // both of which this flagged as broken runs until it asked.
        const lh = wd.y1 - wd.y0;
        return !rawWords.some((o) => o !== wd && Math.abs(o.base - wd.base) <= lh * 0.5 &&
                                     o.x1 <= wd.x0 + 2 && wd.x0 - o.x1 < lh * 0.6 &&
                                     !LABEL_JUNK.test(o.text));
      });
    }

    // Radios first: a column's right edge is the next column's leftmost radio.
    const radios = ordered.map(([, bx]) =>
      radioForLetter(img.data, w, h, [bx.x0, bx.y0, bx.x1, bx.y1]));
    const cols = choiceColumns(ordered, cw);
    const colOf = [];
    cols.forEach((c, ci) => c.members.forEach((i) => { colOf[i] = ci; }));
    cols.forEach((c) => {
      c.left = Math.min(...c.members.map((i) => radios[i][0] - radios[i][2] * 1.6));
    });
    cols.forEach((c, ci) => {
      c.right = ci + 1 < cols.length ? cols[ci + 1].left - 4 : cw * 0.99;
    });
    ordered.forEach(([L, bx], idx) => {
      const [cx, cy, rad] = radios[idx];
      const col = cols[colOf[idx]];
      // the next choice DOWN THIS COLUMN, not the next letter: with A to E
      // left and F to J right, E's row ended at F's top, a row above it
      const nx = col.members[col.members.indexOf(idx) + 1];
      const nbx = nx === undefined ? null : ordered[nx][1];
      const rowTop = bx.y0 - rad * 0.6;
      // This row's bottom IS the next row's top, so it has to be measured
      // with the next row's radio, not this one's. Measured with its own, any
      // row whose circle came out a pixel bigger than its neighbour's began
      // before the row above it had ended: 64 overlapping pairs on Form 2 and
      // 104 on Form 1, where OCR sizes every circle a little differently,
      // against none on Form 5. An overlap is a band in which a click on the
      // option text registers as the choice above it.
      let rowBot = nbx ? nbx.y0 - radios[nx][2] * 0.6
                       : bx.y1 + (bx.y1 - bx.y0) * 1.4;
      if (bodyTop !== null) rowBot = Math.min(rowBot, bodyTop);
      // cx/cy/rad let extendFiguresBelow mask the radio circles, the only ink
      // below the stem that no text box covers
      pxChoices.push({ letter: L, rowTop, rowBot, lx0: bx.x0, lx1: bx.x1,
                       base: bx.base, tol: (bx.y1 - bx.y0) * 0.4, cx, cy, rad,
                       lw: bx, colRight: col.right,
                       nextBase: nbx ? nbx.base : null,
                       nextTol: nbx ? (nbx.y1 - nbx.y0) * 0.4 : null });
      const rowLeft = cx - rad * 1.6;
      const rowRight = col.right;
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
    const [aGroup, letter] = resolveAnswer(itemNo, qStem, gi, qGroups.length);

    // structured real-text content; image mode is the fallback
    let content = null;
    try {
      if (!runBroken) {
        content = await buildItemContent(rawWords, pxChoices, top, cw, ch,
                                         canvas, img,
                                         stemLine ? stemLine.base : null);
      }
    } catch (e) { content = null; }

    // keepPageImages: the test harness wants the page render even for items
    // that parsed as text, to compare the HTML against the original layout.
    if (content && !opts.keepPageImages) {
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
  prog("Done", 1);

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
      const band = contentBand(im.data, c.width, c.height);
      if (band[0] === 0 && band[1] === c.height) bandFallback.answers.push(p);
      shots.push({ canvas: c, img: im, w: c.width, h: c.height, band,
                   words: await aSrc.words(p, viewport) });
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
        const pl = await aSrc.lines(p, true);
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
      const start = lines.findIndex((l) => CORRECT_ANSWER.test(l.text));
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
        // A floor, so a page that yielded only the letter and some OCR noise
        // shows no panel at all. It used to be 200 characters, which suited
        // NBME's own prose keys but silently dropped 28 of Form 1's 50
        // explanations and 14 of Form 2's: those are written in bullets, and
        // a real one can be as short as "Correct Answer: A. / SCC -> PTHrP ->
        // hypercalcemia". Worst case at 60 is a panel holding little more than
        // the letter, which is no worse than the empty panel it replaces.
        if (texts.join(" ").length >= 60) info = { paragraphs: texts };
      }
    } catch (e) { info = null; }
    aInfoCache.set(it.a_group, info);
    return info;
  }

  return { count: items.length, title, items, qURLs, answerURL, answerInfo,
           ocr: ocrStats, bandFallback };
}

window.parseExam = parseExam;
