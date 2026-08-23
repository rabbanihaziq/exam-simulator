"use strict";
/* self-assessment exam front-end.
   Renders question page images with an interactive overlay: click-to-select
   answers, drag-to-highlight text (via word boxes), lab values, calculator,
   navigator, timer, and a submit-and-review flow scored against the key. */

let DATA = null;              // /api/exam payload
let cur = 0;                  // current item index (0-based)
let reviewing = false;
const S = {                   // persisted session state
  answers: {},                // item -> letter
  marks: {},                  // item -> true
  struck: {},                 // item -> {letter:true}
  highlights: {},             // item -> [ [x0,y0,x1,y1], ... ] normalized
  startedAt: null,
};

const $ = (id) => document.getElementById(id);
const overlay = () => $("overlay");

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */
let LSKEY = "sa_exam_state";  // replaced with a per-exam key once DATA loads
function saveState() {
  try { localStorage.setItem(LSKEY, JSON.stringify(S)); } catch (e) {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(LSKEY);
    if (raw) Object.assign(S, JSON.parse(raw));
  } catch (e) {}
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  const res = await fetch("/api/exam");
  if (!res.ok) { location.href = "/"; return; }
  DATA = await res.json();
  if (DATA.sid) LSKEY = "sa_exam_" + DATA.sid;  // isolate saved state per exam
  loadState();
  $("examTitle").textContent = DATA.title || "Self-Assessment";
  document.title = DATA.title || "Self-Assessment";
  $("brand").textContent = DATA.title || "";
  $("total").textContent = DATA.count;
  if (!S.startedAt) { S.startedAt = Date.now(); saveState(); }
  buildLab();
  buildCalc();
  wireChrome();
  startTimer();
  showItem(0);
}

function item(i) { return DATA.items[i]; }

/* ------------------------------------------------------------------ */
/* render a question                                                   */
/* ------------------------------------------------------------------ */
function showItem(i) {
  cur = Math.max(0, Math.min(DATA.count - 1, i));
  const it = item(cur);
  $("curno").textContent = it.item;
  $("markChk").checked = !!S.marks[it.item];
  $("markLbl").classList.toggle("on", !!S.marks[it.item]);
  $("prevBtn").disabled = cur === 0;
  $("nextBtn").disabled = cur === DATA.count - 1;
  $("unavail").style.display = it.answer_available ? "none" : "block";

  const img = $("qimg");
  overlay().innerHTML = "";
  img.onload = () => layoutItem(it);
  img.src = "/img/q/" + it.item;
  if (img.complete && img.naturalWidth) layoutItem(it);
  saveState();
}

function layoutItem(it) {
  const img = $("qimg");
  const w = img.clientWidth, h = img.clientHeight;
  const ov = overlay();
  ov.style.width = w + "px";
  ov.style.height = h + "px";
  ov.innerHTML = "";

  // choices
  it.choices.forEach((c) => {
    const el = document.createElement("div");
    el.className = "choice";
    el.dataset.letter = c.letter;
    el.style.left = (c.row[0] * w) + "px";
    el.style.top = (c.row[1] * h) + "px";
    el.style.width = ((c.row[2] - c.row[0]) * w) + "px";
    el.style.height = ((c.row[3] - c.row[1]) * h) + "px";
    const rad = document.createElement("div");
    rad.className = "radio";
    const rr = c.radio[2] * h;
    // radio position is relative to the choice element (el), so subtract el's origin
    rad.style.width = rad.style.height = (rr * 1.05) + "px";
    rad.style.left = (c.radio[0] * w - rr * 0.52 - c.row[0] * w) + "px";
    rad.style.top = (c.radio[1] * h - rr * 0.52 - c.row[1] * h) + "px";
    el.appendChild(rad);
    const st = document.createElement("div");
    st.className = "strike";
    // through the vertical center of the option text (= radio center), from
    // just past the radio to the end of the option's words
    st.style.top = ((c.radio[1] - c.row[1]) * h - 1) + "px";
    const rowWords = it.words.filter((wd) => {
      const cy = (wd[1] + wd[3]) / 2;
      return cy >= c.row[1] && cy <= c.row[3];
    });
    if (rowWords.length) {
      const leftPx = (c.radio[0] * w + c.radio[2] * h * 1.6) - c.row[0] * w;
      const endPx = Math.max(...rowWords.map((wd) => wd[2])) * w - c.row[0] * w;
      st.style.left = leftPx + "px";
      st.style.width = Math.max(20, endPx - leftPx + 4) + "px";
    }
    el.appendChild(st);
    if (S.answers[it.item] === c.letter) el.classList.add("sel");
    if (S.struck[it.item] && S.struck[it.item][c.letter]) el.classList.add("struck");
    ov.appendChild(el);
  });

  buildTextLayer(it, w, h);
  drawHighlights(it);
}

/* Cluster words (already in reading order) into visual lines so every span
   on a line shares one top/height — selection then paints as a continuous
   band per line, like text on a normal web page. */
function computeLines(it) {
  if (it._lines) return;
  const lines = [], lineOf = [];
  let cur = null;
  it.words.forEach((wd, i) => {
    const wh = wd[3] - wd[1];
    const overlap = cur ? Math.min(cur.bot, wd[3]) - Math.max(cur.top, wd[1]) : -1;
    if (!cur || overlap < wh * 0.5) {
      cur = { top: wd[1], bot: wd[3], words: [] };
      lines.push(cur);
    } else {
      cur.top = Math.min(cur.top, wd[1]);
      cur.bot = Math.max(cur.bot, wd[3]);
    }
    cur.words.push(i);
    lineOf.push(lines.length - 1);
  });
  it._lines = lines;
  it._lineOf = lineOf;
}

/* Invisible selectable text positioned over the page image (PDF.js-style),
   so highlighting uses the browser's native text selection. */
function buildTextLayer(it, w, h) {
  computeLines(it);
  const tl = document.createElement("div");
  tl.className = "textlayer" + (hlOn ? " hl-mode" : "");
  const targets = [];
  it._lines.forEach((ln) => {
    const lh = (ln.bot - ln.top) * h;
    ln.words.forEach((wi, k) => {
      const wd = it.words[wi];
      const last = k === ln.words.length - 1;
      const s = document.createElement("span");
      s.textContent = wd[4] + (last ? "" : " ");
      s.style.left = (wd[0] * w) + "px";
      s.style.top = (ln.top * h) + "px";
      s.style.fontSize = (lh * 0.78) + "px";
      s.style.lineHeight = lh + "px";
      // stretch through the gap to the next word so selection is continuous
      const right = last ? wd[2] : it.words[ln.words[k + 1]][0];
      targets.push(Math.max(1, (right - wd[0]) * w));
      tl.appendChild(s);
    });
  });
  overlay().appendChild(tl);
  const widths = [...tl.children].map((s) => s.getBoundingClientRect().width);
  [...tl.children].forEach((s, i) => {
    if (widths[i] > 0) s.style.transform = `scaleX(${targets[i] / widths[i]})`;
  });
}

function drawHighlights(it) {
  const ov = overlay();
  ov.querySelectorAll(".hl").forEach((e) => e.remove());
  const w = ov.clientWidth, h = ov.clientHeight;
  (S.highlights[it.item] || []).forEach((r, idx) => {
    const el = document.createElement("div");
    el.className = "hl";
    el.style.left = (r[0] * w) + "px";
    el.style.top = (r[1] * h) + "px";
    el.style.width = ((r[2] - r[0]) * w) + "px";
    el.style.height = ((r[3] - r[1]) * h) + "px";
    el.dataset.idx = idx;
    el.addEventListener("click", () => { if (!reviewing) removeHighlight(idx); });
    ov.appendChild(el);
  });
}

/* ------------------------------------------------------------------ */
/* answer selection + strike-through                                   */
/* ------------------------------------------------------------------ */
function selectChoice(letter) {
  const it = item(cur);
  S.answers[it.item] = letter;
  overlay().querySelectorAll(".choice").forEach((el) =>
    el.classList.toggle("sel", el.dataset.letter === letter));
  saveState();
}
function toggleStrike(letter) {
  const it = item(cur);
  S.struck[it.item] = S.struck[it.item] || {};
  if (S.struck[it.item][letter]) delete S.struck[it.item][letter];
  else S.struck[it.item][letter] = true;
  const el = [...overlay().querySelectorAll(".choice")]
    .find((e) => e.dataset.letter === letter);
  if (el) el.classList.toggle("struck", !!S.struck[it.item][letter]);
  saveState();
}

/* ------------------------------------------------------------------ */
/* highlighting (native browser selection over the text layer)         */
/* ------------------------------------------------------------------ */
let hlOn = true;
let downPos = null;   // mousedown point, to tell a click from a drag

function overlayXY(e) {
  const r = overlay().getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
}

// Normalised choice-row hit test (choice divs are visual-only).
function hitChoice(e) {
  const p = overlayXY(e);
  if (p.w <= 0 || p.h <= 0) return null;
  const nx = p.x / p.w, ny = p.y / p.h;
  const c = item(cur).choices.find((c) =>
    nx >= c.row[0] && nx <= c.row[2] && ny >= c.row[1] && ny <= c.row[3]);
  return c ? c.letter : null;
}

function onStageDown(e) {
  if (e.button !== 0) return;
  downPos = { x: e.clientX, y: e.clientY, target: e.target };
}

function onStageMove(e) {
  if (reviewing || downPos) return;
  const L = hitChoice(e);
  overlay().querySelectorAll(".choice").forEach((el) =>
    el.classList.toggle("hover", el.dataset.letter === L));
  const tl = overlay().querySelector(".textlayer");
  if (tl) tl.style.cursor = L ? "pointer" : "";
}

function onStageUp(e) {
  if (!downPos) return;
  const d = downPos; downPos = null;
  if (reviewing) return;
  const moved = Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 5;
  const sel = window.getSelection();
  const hasSel = sel && !sel.isCollapsed && sel.rangeCount > 0;
  if (hasSel && hlOn && commitSelectionHighlight(sel)) return;
  if (!moved && !hasSel) {
    // a click on an existing highlight is handled by the .hl element itself
    if (d.target.closest && d.target.closest(".hl")) return;
    const L = hitChoice(e);
    if (L) selectChoice(L);
  }
}

/* Turn the current native selection into persistent word-snapped highlight
   rects (merged per line, same storage format as before). */
function commitSelectionHighlight(sel) {
  const tl = overlay().querySelector(".textlayer");
  if (!tl) return false;
  const it = item(cur);
  const picked = [];
  for (let i = 0; i < tl.children.length; i++) {
    if (sel.containsNode(tl.children[i], true)) picked.push(i);
  }
  if (!picked.length) return false;

  // Merge picked words per line; rects snap exactly to the line band so the
  // stored highlight matches what the live selection showed.
  const byLine = {};
  picked.forEach((i) => {
    (byLine[it._lineOf[i]] = byLine[it._lineOf[i]] || []).push(it.words[i]);
  });
  const rects = S.highlights[it.item] = S.highlights[it.item] || [];
  Object.entries(byLine).forEach(([li, ws]) => {
    const ln = it._lines[li];
    rects.push([Math.min(...ws.map((a) => a[0])) - 0.002, ln.top,
                Math.max(...ws.map((a) => a[2])) + 0.002, ln.bot]);
  });
  sel.removeAllRanges();
  saveState();
  drawHighlights(it);
  return true;
}
function removeHighlight(idx) {
  const it = item(cur);
  if (!S.highlights[it.item]) return;
  S.highlights[it.item].splice(idx, 1);
  saveState();
  drawHighlights(it);
}
function clearHighlights() {
  const it = item(cur);
  S.highlights[it.item] = [];
  saveState();
  drawHighlights(it);
}

/* ------------------------------------------------------------------ */
/* timer                                                               */
/* ------------------------------------------------------------------ */
let timerInt = null;
function startTimer() {
  const total = (DATA.minutes || 0) * 60;
  const t = $("timer");
  if (!total) { t.textContent = "Off"; return; }
  function tick() {
    const elapsed = Math.floor((Date.now() - S.startedAt) / 1000);
    let left = total - elapsed;
    if (left < 0) left = 0;
    const hh = Math.floor(left / 3600), mm = Math.floor((left % 3600) / 60),
          ss = left % 60;
    t.textContent = (hh ? hh + " hr " : "") +
      String(mm).padStart(2, "0") + " min " + String(ss).padStart(2, "0") + " sec";
    t.classList.toggle("warn", left <= 300 && left > 60);
    t.classList.toggle("crit", left <= 60);
  }
  tick();
  timerInt = setInterval(tick, 1000);
}

/* ------------------------------------------------------------------ */
/* chrome wiring                                                       */
/* ------------------------------------------------------------------ */
function wireChrome() {
  $("prevBtn").onclick = () => showItem(cur - 1);
  $("nextBtn").onclick = () => showItem(cur + 1);
  $("markChk").onchange = (e) => {
    const it = item(cur);
    if (e.target.checked) S.marks[it.item] = true; else delete S.marks[it.item];
    $("markLbl").classList.toggle("on", e.target.checked);
    saveState();
  };
  $("hlBtn").onclick = () => {
    hlOn = !hlOn;
    $("hlBtn").style.background = hlOn ? "#ffffff33" : "transparent";
    $("hlLabel").textContent = hlOn ? "Highlight: on" : "Highlight: off";
    const tl = overlay().querySelector(".textlayer");
    if (tl) tl.classList.toggle("hl-mode", hlOn);
  };
  $("hlBtn").style.background = "#ffffff33";
  $("hlLabel").textContent = "Highlight: on";
  $("clearHlBtn").onclick = clearHighlights;
  $("labBtn").onclick = () => openModal("labModal");
  $("calcBtn").onclick = () => openModal("calcModal");
  $("navBtn").onclick = () => { buildNav(); openModal("navModal"); };
  $("endBtn").onclick = () => { buildEndText(); openModal("endModal"); };
  $("confirmEnd").onclick = () => { closeModal(); submitExam(); };
  $("exitReview").onclick = () => exitReview();
  $("newExam").onclick = () => { localStorage.removeItem(LSKEY); location.href = "/reset"; };

  // overlay interactions: native selection does the dragging; we only need
  // click-vs-selection disambiguation on mouseup.
  const st = $("stage");
  st.addEventListener("mousedown", onStageDown);
  st.addEventListener("mousemove", onStageMove);
  window.addEventListener("mouseup", onStageUp);
  st.addEventListener("contextmenu", (e) => {
    if (reviewing) return;
    const L = hitChoice(e);
    if (L) { e.preventDefault(); toggleStrike(L); }
  });

  // modal close handlers
  document.querySelectorAll(".modal-back").forEach((m) => {
    m.addEventListener("click", (e) => {
      if (e.target === m || (e.target.dataset && e.target.dataset.close !== undefined))
        closeModal();
    });
  });
  document.querySelectorAll("[data-close]").forEach((x) =>
    x.addEventListener("click", closeModal));

  // keyboard: arrows navigate, A-G select, 1-9 select, Esc closes
  window.addEventListener("keydown", (e) => {
    if (document.querySelector(".modal-back.open")) {
      if (e.key === "Escape") closeModal();
      return;
    }
    if (e.key === "ArrowRight") showItem(cur + 1);
    else if (e.key === "ArrowLeft") showItem(cur - 1);
    else if (!reviewing) {
      const it = item(cur);
      const L = e.key.toUpperCase();
      if (/^[A-J]$/.test(L) && it.choices.some((c) => c.letter === L)) selectChoice(L);
      else if (/^[1-9]$/.test(e.key)) {
        const c = it.choices[parseInt(e.key, 10) - 1];
        if (c) selectChoice(c.letter);
      } else if (L === "M") { $("markChk").click(); }
    }
  });

  // keep overlay aligned on resize
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!reviewing) layoutItem(item(cur)); }, 120);
  });
}

/* ------------------------------------------------------------------ */
/* modals                                                              */
/* ------------------------------------------------------------------ */
function openModal(id) { $(id).classList.add("open"); }
function closeModal() {
  document.querySelectorAll(".modal-back.open").forEach((m) => m.classList.remove("open"));
}

/* ---- lab values ---- */
let labCat = null;
function buildLab() {
  const cats = Object.keys(window.LAB_VALUES);
  labCat = cats[0];
  const tabs = $("labTabs");
  tabs.innerHTML = "";
  cats.forEach((c) => {
    const t = document.createElement("div");
    t.className = "labtab" + (c === labCat ? " on" : "");
    t.textContent = c;
    t.onclick = () => { labCat = c; renderLab(); };
    tabs.appendChild(t);
  });
  $("labSearch").addEventListener("input", renderLab);
  $("siToggle").addEventListener("change", renderLab);
  renderLab();
}
function renderLab() {
  document.querySelectorAll(".labtab").forEach((t) =>
    t.classList.toggle("on", t.textContent === labCat));
  const si = $("siToggle").checked;
  const q = $("labSearch").value.trim().toLowerCase();
  const rows = window.LAB_VALUES[labCat] || [];
  let html = '<table class="lab"><thead><tr><th>Test</th><th>Reference range</th></tr></thead><tbody>';
  rows.forEach((r) => {
    const val = si ? (r[2] || r[1]) : r[1];
    const hidden = q && !(r[0].toLowerCase().includes(q));
    html += `<tr class="${hidden ? "hide" : ""}"><td>${r[0]}</td><td class="val">${val || "—"}</td></tr>`;
  });
  html += "</tbody></table>";
  // when searching, look across all categories
  if (q) {
    let any = false;
    let all = '<table class="lab"><thead><tr><th>Test</th><th>Reference range</th></tr></thead><tbody>';
    Object.entries(window.LAB_VALUES).forEach(([cat, rs]) => {
      rs.forEach((r) => {
        if (r[0].toLowerCase().includes(q)) {
          any = true;
          const val = si ? (r[2] || r[1]) : r[1];
          all += `<tr><td>${r[0]} <span style="color:#8794a3;font-size:11px">(${cat})</span></td><td class="val">${val || "—"}</td></tr>`;
        }
      });
    });
    all += "</tbody></table>";
    $("labBody").innerHTML = any ? all :
      '<div style="padding:30px;text-align:center;color:#889">No matching test.</div>';
    return;
  }
  $("labBody").innerHTML = html;
}

/* ---- calculator ---- */
function buildCalc() {
  const grid = $("calcGrid");
  const disp = $("calcDisp");
  let expr = "";
  const keys = ["C", "←", "%", "/", "7", "8", "9", "*", "4", "5", "6", "-",
                "1", "2", "3", "+", "0", ".", "(", ")", "="];
  function refresh() { disp.textContent = expr || "0"; }
  keys.forEach((k) => {
    const b = document.createElement("button");
    b.textContent = k;
    if ("/*-+".includes(k)) b.className = "op";
    else if (k === "=") { b.className = "eq"; b.style.gridColumn = "1 / -1"; }
    else if (["C", "←", "%", "(", ")"].includes(k)) b.className = "fn";
    b.onclick = () => {
      if (k === "C") expr = "";
      else if (k === "←") expr = expr.slice(0, -1);
      else if (k === "=") {
        try {
          const v = Function('"use strict";return (' + expr.replace(/%/g, "/100") + ")")();
          expr = (v === undefined || v === null) ? "" : String(+v.toFixed(8)).replace(/\.?0+$/, "");
        } catch (e) { expr = "Error"; }
      } else expr += k;
      refresh();
    };
    grid.appendChild(b);
  });
  refresh();
}

/* ---- navigator ---- */
function buildNav() {
  const g = $("navGrid");
  g.innerHTML = "";
  DATA.items.forEach((it, i) => {
    const c = document.createElement("div");
    c.className = "navcell";
    c.textContent = it.item;
    if (S.answers[it.item]) c.classList.add("answered");
    if (S.marks[it.item]) c.classList.add("marked");
    if (!it.answer_available) c.classList.add("unavail");
    if (i === cur) c.classList.add("current");
    c.onclick = () => {
      closeModal();
      if (reviewing) showReview(i); else showItem(i);
    };
    g.appendChild(c);
  });
}

/* ---- end block ---- */
function buildEndText() {
  const answered = DATA.items.filter((it) => S.answers[it.item]).length;
  const unanswered = DATA.count - answered;
  const marked = DATA.items.filter((it) => S.marks[it.item]).length;
  $("endText").innerHTML =
    `You've answered <b>${answered}</b> of <b>${DATA.count}</b> items` +
    (unanswered ? `, leaving <b>${unanswered}</b> blank` : "") +
    (marked ? ` (<b>${marked}</b> marked for review)` : "") +
    `.<br><br>End the block and see your score against the answer key?`;
}

/* ------------------------------------------------------------------ */
/* submit + review                                                     */
/* ------------------------------------------------------------------ */
function submitExam() {
  if (timerInt) clearInterval(timerInt);
  let correct = 0, scored = 0;
  DATA.items.forEach((it) => {
    if (!it.answer_available) return;
    scored++;
    if (S.answers[it.item] && S.answers[it.item] === it.correct) correct++;
  });
  const pct = scored ? Math.round((correct / scored) * 100) : 0;
  DATA._score = { correct, scored, pct };
  reviewing = true;
  $("topbar").style.display = "none";
  $("content").style.display = "none";
  $("reviewbar").style.display = "flex";
  $("reviewwrap").style.display = "block";
  $("scoreBig").textContent = pct + "%";
  const naCount = DATA.count - scored;
  $("scoreSub").innerHTML =
    `${correct} / ${scored} correct` +
    (naCount ? ` &nbsp;·&nbsp; ${naCount} item(s) had no answer key and were not scored` : "");
  // repurpose footer for review nav
  $("hlBtn").style.display = "none";
  $("clearHlBtn").style.display = "none";
  $("markChk").parentElement.style.display = "none";
  $("endBtn").style.display = "none";
  showReview(0);
}

function showReview(i) {
  cur = Math.max(0, Math.min(DATA.count - 1, i));
  const it = item(cur);
  $("prevBtn").disabled = cur === 0;
  $("nextBtn").disabled = cur === DATA.count - 1;
  const strip = $("resultstrip");
  const img = $("reviewimg");
  const na = $("naNote");
  const your = S.answers[it.item];

  if (!it.answer_available) {
    strip.className = "resultstrip na";
    strip.innerHTML = `<b>Item ${it.item}</b> <span class="pill">Your answer: ${your || "—"}</span>` +
      `<span class="pill">Not in answer key</span>`;
    img.style.display = "none";
    na.style.display = "block";
    na.innerHTML = `The answer-key PDF did not include item ${it.item}, so it can't be shown here ` +
      `and wasn't counted in your score.`;
    return;
  }
  na.style.display = "none";
  img.style.display = "block";
  const isCorrect = your && your === it.correct;
  strip.className = "resultstrip " + (isCorrect ? "correct" : (your ? "wrong" : "skipped"));
  strip.innerHTML =
    `<b>Item ${it.item}</b>` +
    `<span class="pill">Your answer: <b>${your || "— (blank)"}</b></span>` +
    `<span class="pill">Correct: <b>${it.correct}</b></span>` +
    `<span>${isCorrect ? "✓ Correct" : (your ? "✗ Incorrect" : "○ Skipped")}</span>`;
  img.onload = () => { $("reviewwrap").scrollTop = 0; };
  img.src = "/img/a/" + it.item;
}

function exitReview() {
  reviewing = false;
  if (timerInt) clearInterval(timerInt);
  $("reviewbar").style.display = "none";
  $("reviewwrap").style.display = "none";
  $("topbar").style.display = "flex";
  $("content").style.display = "block";
  $("hlBtn").style.display = "";
  $("clearHlBtn").style.display = "";
  $("markChk").parentElement.style.display = "";
  $("endBtn").style.display = "";
  startTimer();
  showItem(cur);
}

// review nav reuses prev/next
const _origPrev = () => reviewing ? showReview(cur - 1) : showItem(cur - 1);
const _origNext = () => reviewing ? showReview(cur + 1) : showItem(cur + 1);
document.addEventListener("DOMContentLoaded", () => {
  boot().then(() => {
    $("prevBtn").onclick = _origPrev;
    $("nextBtn").onclick = _origNext;
  });
});
