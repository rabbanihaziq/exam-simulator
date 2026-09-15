"use strict";
/* self-assessment exam front-end (fully client-side version).
   The landing screen takes the two PDFs, parser.js parses them in the
   browser, and the exam interface renders question images with an
   interactive overlay: native text-selection highlighting, click-to-answer,
   lab values, calculator, navigator, timer, and a scored review. */

let DATA = null;              // parseExam() result
let cur = 0;                  // current item index (0-based)
let reviewing = false;
const S = {                   // persisted session state
  answers: {},                // item -> letter
  marks: {},                  // item -> true
  struck: {},                 // item -> {letter:true}
  highlights: {},             // item -> [ [x0,y0,x1,y1], ... ] (image mode)
  hlw: {},                    // item -> [wordId, ...]        (text mode)
  startedAt: null,
};

const $ = (id) => document.getElementById(id);
const overlay = () => $("overlay");

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */
let LSKEY = "sa_exam_state";  // replaced with a per-exam key on boot
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
/* landing: choose PDFs, parse in-browser, then boot                   */
/* ------------------------------------------------------------------ */
function wireDrop(dropId, txtId, inputId) {
  const drop = $(dropId), input = $(inputId), txt = $(txtId);
  input.addEventListener("change", () => {
    if (input.files[0]) {
      txt.innerHTML = "<b>" + input.files[0].name + "</b>";
      drop.classList.add("filled");
    }
  });
  ["dragover", "dragenter"].forEach((e) => drop.addEventListener(e, (ev) => {
    ev.preventDefault(); drop.style.borderColor = "#24507f";
  }));
  ["dragleave", "drop"].forEach((e) => drop.addEventListener(e, (ev) => {
    ev.preventDefault(); drop.style.borderColor = "";
  }));
  drop.addEventListener("drop", (ev) => {
    if (ev.dataTransfer.files[0]) {
      input.files = ev.dataTransfer.files;
      input.dispatchEvent(new Event("change"));
    }
  });
}

function showError(msg) {
  const e = $("err");
  e.textContent = msg;
  e.style.display = "block";
  $("go").disabled = false;
  $("go").textContent = "Start exam";
  $("progressWrap").style.display = "none";
}

async function sha16(bytes) {
  try {
    const d = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(d)].slice(0, 8)
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch (e) {  // non-secure context fallback: cheap rolling hash
    let h = 0;
    const v = new Uint8Array(bytes);
    for (let i = 0; i < v.length; i += 97) h = (h * 31 + v[i]) >>> 0;
    return "x" + h.toString(16) + v.length.toString(16);
  }
}

async function startExam() {
  const qf = $("file-q").files[0];
  const af = $("file-a").files[0];
  if (!qf || !af) {
    showError("Please choose both a questions PDF and an answer-key PDF.");
    return;
  }
  if (!window.pdfjsLib) {
    showError("The PDF engine hasn't finished loading — try again in a second.");
    return;
  }
  const minutes = Math.max(0, Math.min(600, parseInt($("minutes").value, 10) || 0));
  $("go").disabled = true;
  $("go").textContent = "Parsing…";
  $("err").style.display = "none";
  $("progressWrap").style.display = "block";

  try {
    const qBytes = await qf.arrayBuffer();
    const aBytes = await af.arrayBuffer();
    const sid = await sha16(qBytes.slice(0));
    const data = await window.parseExam(qBytes, aBytes, (label, frac) => {
      $("progressLabel").textContent = label;
      $("progressFill").style.width = Math.round(frac * 100) + "%";
    });
    if (!data.count) throw new Error("no question pages found");
    data.minutes = minutes;
    data.sid = sid;
    $("landing").style.display = "none";
    $("app").style.display = "flex";
    boot(data);
  } catch (e) {
    showError("Could not read those PDFs (" + (e.message || e) + "). Make sure " +
      "they are the self-assessment questions and answer-key PDFs.");
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
function boot(data) {
  DATA = data;
  LSKEY = "sa_exam_" + DATA.sid;  // isolate saved state per exam file
  loadState();
  S.hlw = S.hlw || {};            // state saved by older versions lacks this
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
  $("prevBtn").onclick = () => reviewing ? showReview(cur - 1) : showItem(cur - 1);
  $("nextBtn").onclick = () => reviewing ? showReview(cur + 1) : showItem(cur + 1);
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

  if (it.content) {
    $("stage").style.display = "none";
    $("qhtml").style.display = "block";
    renderQuestionHtml(it, $("qhtml"), false);
    $("content").scrollTop = 0;
  } else {
    $("qhtml").style.display = "none";
    $("stage").style.display = "block";
    const img = $("qimg");
    overlay().innerHTML = "";
    img.onload = () => layoutItem(it);
    img.src = DATA.qURLs[cur];
    if (img.complete && img.naturalWidth) layoutItem(it);
  }
  saveState();
}

/* ------------------------------------------------------------------ */
/* real-text question rendering                                        */
/* ------------------------------------------------------------------ */
function renderRuns(runs, hlSet) {
  return runs.map((r) => {
    let t = escHtml(r.text);
    if (r.sup) t = `<sup>${t}</sup>`;
    else if (r.sub) t = `<sub>${t}</sub>`;
    const cls = ["w"];
    if (r.i) cls.push("i");
    if (r.b) cls.push("b");
    if (hlSet.has(r.wid)) cls.push("hlw");
    return `<span class="${cls.join(" ")}" data-wi="${r.wid}">${t} </span>`;
  }).join("");
}

function renderQuestionHtml(it, container, review) {
  const hlSet = new Set(S.hlw[it.item] || []);
  const your = S.answers[it.item];
  let html = "";
  it.content.blocks.forEach((b) => {
    if (b.t === "p") {
      html += `<p class="qpara">${renderRuns(b.runs, hlSet)}</p>`;
    } else if (b.fr) {
      html += `<img class="qfig fr" src="${b.url}" ` +
        `style="width:${(b.wf * 100).toFixed(2)}%">`;
    } else {
      html += `<img class="qfig" src="${b.url}" ` +
        `style="width:${(b.wf * 100).toFixed(2)}%;margin-left:${(b.x0f * 100).toFixed(2)}%">`;
    }
  });
  html += `<div class="copts">` + it.content.choices.map((c) => {
    const cls = ["copt"];
    if (your === c.letter) cls.push("sel");
    if (S.struck[it.item] && S.struck[it.item][c.letter]) cls.push("struck");
    if (review) {
      if (c.letter === it.correct) cls.push("correct");
      if (your === c.letter && c.letter !== it.correct) cls.push("wrongpick");
    }
    return `<div class="${cls.join(" ")}" data-letter="${c.letter}">` +
      (review ? `<span class="cmark"></span>` : "") +
      `<span class="cradio"><span class="cdot"></span></span>` +
      `<span class="clab">${c.letter})</span>` +
      `<span class="ctext">${renderRuns(c.runs, hlSet)}</span></div>`;
  }).join("") + `</div>`;
  container.innerHTML = html;
  container.classList.toggle("hl-mode", hlOn && !review);
  if (review) {
    container.querySelectorAll(".copt.correct .cmark").forEach((m) =>
      m.appendChild(markSvg("good", 20)));
    container.querySelectorAll(".copt.wrongpick .cmark").forEach((m) =>
      m.appendChild(markSvg("bad", 20)));
  }
}

function applyHlwClasses(container, it) {
  const set = new Set(S.hlw[it.item] || []);
  container.querySelectorAll("span.w").forEach((s) =>
    s.classList.toggle("hlw", set.has(+s.dataset.wi)));
}

function commitHtmlHighlight(sel, container, it) {
  const spans = container.querySelectorAll("span.w");
  const picked = [];
  spans.forEach((s) => { if (sel.containsNode(s, true)) picked.push(+s.dataset.wi); });
  if (!picked.length) return false;
  const set = new Set(S.hlw[it.item] || []);
  picked.forEach((i) => set.add(i));
  S.hlw[it.item] = [...set].sort((a, b) => a - b);
  sel.removeAllRanges();
  saveState();
  applyHlwClasses(container, it);
  return true;
}

function removeHlRun(it, wi, container) {
  const set = new Set(S.hlw[it.item] || []);
  if (!set.has(wi)) return;
  let a = wi, b = wi;
  while (set.has(a - 1)) a--;
  while (set.has(b + 1)) b++;
  for (let i = a; i <= b; i++) set.delete(i);
  S.hlw[it.item] = [...set].sort((x, y) => x - y);
  saveState();
  applyHlwClasses(container, it);
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
    const el = makeChoiceEl(it, c, w, h);
    if (S.answers[it.item] === c.letter) el.classList.add("sel");
    if (S.struck[it.item] && S.struck[it.item][c.letter]) el.classList.add("struck");
    ov.appendChild(el);
  });

  buildTextLayer(it, w, h);
  drawHighlights(it);
}

/* Positioned choice-row element (radio + strike line), shared by the exam
   view and the review view. */
function makeChoiceEl(it, c, w, h) {
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
  return el;
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
  const sel = it.content
    ? document.querySelectorAll("#qhtml .copt")
    : overlay().querySelectorAll(".choice");
  sel.forEach((el) => el.classList.toggle("sel", el.dataset.letter === letter));
  saveState();
}
function toggleStrike(letter) {
  const it = item(cur);
  S.struck[it.item] = S.struck[it.item] || {};
  if (S.struck[it.item][letter]) delete S.struck[it.item][letter];
  else S.struck[it.item][letter] = true;
  const root = it.content ? document.querySelectorAll("#qhtml .copt")
                          : overlay().querySelectorAll(".choice");
  const el = [...root].find((e) => e.dataset.letter === letter);
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

let hlSuppress = false;  // a selection-drag's trailing click must not answer

function onWindowUp() {
  // text-mode items: native selection -> word highlights
  if (reviewing || !DATA) return false;
  const it = item(cur);
  if (!it.content) return false;
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && hlOn &&
      commitHtmlHighlight(sel, $("qhtml"), it)) {
    hlSuppress = true;
    setTimeout(() => { hlSuppress = false; }, 0);
  }
  return true;
}

function onStageUp(e) {
  if (onWindowUp()) return;
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
   rects (merged per line, snapped exactly to the line band). */
function commitSelectionHighlight(sel) {
  const tl = overlay().querySelector(".textlayer");
  if (!tl) return false;
  const it = item(cur);
  const picked = [];
  for (let i = 0; i < tl.children.length; i++) {
    if (sel.containsNode(tl.children[i], true)) picked.push(i);
  }
  if (!picked.length) return false;

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
  S.hlw[it.item] = [];
  saveState();
  if (it.content) applyHlwClasses($("qhtml"), it);
  else drawHighlights(it);
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
    $("qhtml").classList.toggle("hl-mode", hlOn);
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
  wireExport();
  $("newExam").onclick = () => { location.reload(); };
  $("origBtn").onclick = async () => {
    const img = $("reviewimg");
    if (img.style.display === "none") {
      const url = await DATA.answerURL(cur);
      if (url) {
        img.src = url;
        img.style.display = "block";
        $("origBtn").textContent = "Hide original answer-key page";
      }
    } else {
      img.style.display = "none";
      $("origBtn").textContent = "Show original answer-key page";
    }
  };

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

  // real-text question interactions
  const qh = $("qhtml");
  qh.addEventListener("click", (e) => {
    if (reviewing) return;
    const w = e.target.closest && e.target.closest("span.w.hlw");
    if (w) { removeHlRun(item(cur), +w.dataset.wi, qh); return; }
    if (hlSuppress) return;
    const opt = e.target.closest && e.target.closest(".copt");
    if (opt) selectChoice(opt.dataset.letter);
  });
  qh.addEventListener("contextmenu", (e) => {
    if (reviewing) return;
    const opt = e.target.closest && e.target.closest(".copt");
    if (opt) { e.preventDefault(); toggleStrike(opt.dataset.letter); }
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

  // keyboard: arrows navigate, A-J select, 1-9 select, Esc closes
  window.addEventListener("keydown", (e) => {
    if (document.querySelector(".modal-back.open")) {
      if (e.key === "Escape") closeModal();
      return;
    }
    if (e.key === "ArrowRight") reviewing ? showReview(cur + 1) : showItem(cur + 1);
    else if (e.key === "ArrowLeft") reviewing ? showReview(cur - 1) : showItem(cur - 1);
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

  // keep image-mode overlays aligned on resize (text mode reflows itself)
  let rt = null;
  window.addEventListener("resize", () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (item(cur).content) return;
      if (reviewing) layoutReview(item(cur));
      else layoutItem(item(cur));
    }, 120);
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
  $("hlBtn").style.display = "none";
  $("clearHlBtn").style.display = "none";
  $("markChk").parentElement.style.display = "none";
  $("endBtn").style.display = "none";
  showReview(0);
}

async function showReview(i) {
  cur = Math.max(0, Math.min(DATA.count - 1, i));
  const it = item(cur);
  $("prevBtn").disabled = cur === 0;
  $("nextBtn").disabled = cur === DATA.count - 1;
  const strip = $("resultstrip");
  const img = $("reviewimg");
  const na = $("naNote");
  const rstage = $("rstage");
  const expl = $("expl");
  const origWrap = $("origWrap");
  const your = S.answers[it.item];

  img.style.display = "none";
  expl.style.display = "none";
  origWrap.style.display = "none";

  if (!it.answer_available) {
    strip.className = "resultstrip na";
    strip.innerHTML = `<b>Item ${it.item}</b> <span class="pill">Your answer: ${your || "—"}</span>` +
      `<span class="pill">Not in answer key</span>`;
    rstage.style.display = "none";
    $("rhtml").style.display = "none";
    na.style.display = "block";
    na.innerHTML = `The answer-key PDF did not include item ${it.item}, so it can't be shown here ` +
      `and wasn't counted in your score.`;
    return;
  }
  na.style.display = "none";
  const isCorrect = your && your === it.correct;
  strip.className = "resultstrip " + (isCorrect ? "correct" : (your ? "wrong" : "skipped"));
  strip.innerHTML =
    `<b>Item ${it.item}</b>` +
    `<span class="pill">Your answer: <b>${your || "— (blank)"}</b></span>` +
    `<span class="pill">Correct: <b>${it.correct}</b></span>` +
    `<span>${isCorrect ? "✓ Correct" : (your ? "✗ Incorrect" : "○ Skipped")}</span>`;

  // the question as YOU left it: your pick, strikes, highlights — plus
  // right/wrong markers
  if (it.content) {
    rstage.style.display = "none";
    $("rhtml").style.display = "block";
    renderQuestionHtml(it, $("rhtml"), true);
  } else {
    $("rhtml").style.display = "none";
    rstage.style.display = "block";
    const rimg = $("rimg");
    rimg.onload = () => layoutReview(it);
    rimg.src = DATA.qURLs[cur];
    if (rimg.complete && rimg.naturalWidth) layoutReview(it);
  }
  $("reviewwrap").scrollTop = 0;

  // explanation as clean text; fall back to the answer-page image
  const requested = cur;
  const info = await DATA.answerInfo(cur);
  if (cur !== requested || !reviewing) return;
  if (info) {
    expl.innerHTML = renderExplanation(info);
    expl.style.display = "block";
    origWrap.style.display = "block";
    $("origBtn").textContent = "Show original answer-key page";
  } else {
    const url = await DATA.answerURL(cur);
    if (cur !== requested || !reviewing) return;
    if (url) { img.src = url; img.style.display = "block"; }
  }
}

function layoutReview(it) {
  const img = $("rimg");
  const w = img.clientWidth, h = img.clientHeight;
  const ov = $("roverlay");
  ov.style.width = w + "px";
  ov.style.height = h + "px";
  ov.innerHTML = "";
  const your = S.answers[it.item];

  it.choices.forEach((c) => {
    const el = makeChoiceEl(it, c, w, h);
    const isPick = your === c.letter;
    const isKey = c.letter === it.correct;
    if (isPick) el.classList.add("sel");
    if (S.struck[it.item] && S.struck[it.item][c.letter]) el.classList.add("struck");
    if (isKey) el.classList.add("correct");
    if (isPick && !isKey) el.classList.add("wrongpick");
    ov.appendChild(el);
    if (isKey || (isPick && !isKey)) {
      const mk = document.createElement("div");
      mk.className = "rmark";
      const r = c.radio[2] * h;
      mk.appendChild(markSvg(isKey ? "good" : "bad", r * 2.6));
      mk.style.left = (c.radio[0] * w - r * 4.2) + "px";
      mk.style.top = (c.radio[1] * h) + "px";
      ov.appendChild(mk);
    }
  });

  // clip the card just below the content so the explanation sits right
  // under the choices instead of after a page of white space
  const lastChoice = it.choices.length
    ? Math.max(...it.choices.map((c) => c.row[3])) : 1;
  const lastWord = it.words.length
    ? Math.max(...it.words.map((wd) => wd[3])) : 1;
  $("rstage").style.height =
    Math.min(h, Math.max(lastChoice, lastWord) * h + 16) + "px";

  (S.highlights[it.item] || []).forEach((rct) => {
    const el = document.createElement("div");
    el.className = "hl static";
    el.style.left = (rct[0] * w) + "px";
    el.style.top = (rct[1] * h) + "px";
    el.style.width = ((rct[2] - rct[0]) * w) + "px";
    el.style.height = ((rct[3] - rct[1]) * h) + "px";
    ov.appendChild(el);
  });
}

/* Crisp SVG check / X marks in NBME's review colors. */
function markSvg(kind, size) {
  const NS = "http://www.w3.org/2000/svg";
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.style.width = s.style.height = size + "px";
  s.style.display = "block";
  const p = document.createElementNS(NS, "path");
  p.setAttribute("d", kind === "good"
    ? "M3.5 13.5 L9.5 19.5 L20.5 5"
    : "M5 5 L19 19 M19 5 L5 19");
  p.setAttribute("fill", "none");
  p.setAttribute("stroke", kind === "good" ? "#2e7d32" : "#c62828");
  p.setAttribute("stroke-width", "3.6");
  p.setAttribute("stroke-linecap", "round");
  s.appendChild(p);
  return s;
}

function escHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}
function renderExplanation(info) {
  return info.paragraphs.map((p) => {
    let html = escHtml(p);
    if (/^Correct Answer\s*:/.test(p)) return `<p class="ans-correct">${html}</p>`;
    html = html.replace(/^(Incorrect Answers:|Educational Objective:)/, "<b>$1</b>");
    return `<p>${html}</p>`;
  }).join("");
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

/* ------------------------------------------------------------------ */
/* export results (your answers vs the key) as Markdown / JSON         */
/* ------------------------------------------------------------------ */
function runsText(runs) {
  return (runs || []).map((r) => r.text).join(" ").replace(/\s+/g, " ").trim();
}
function itemResult(it) {
  const your = S.answers[it.item];
  if (!it.answer_available) return "no_key";
  if (!your) return "skipped";
  return your === it.correct ? "correct" : "incorrect";
}
async function buildExport(includeExpl, onProgress) {
  const sc = DATA._score || { correct: 0, scored: 0, pct: 0 };
  const items = [];
  for (let i = 0; i < DATA.items.length; i++) {
    const it = DATA.items[i];
    const rec = {
      item: it.item,
      your: S.answers[it.item] || null,
      correct: it.answer_available ? it.correct : null,
      result: itemResult(it),
      marked: !!S.marks[it.item],
      struck: Object.keys(S.struck[it.item] || {}).sort(),
    };
    if (it.content) {
      rec.stem = it.content.blocks.filter((b) => b.t === "p").map((b) => runsText(b.runs)).join("\n");
      rec.choices = it.content.choices.map((c) => ({ letter: c.letter, text: runsText(c.runs) }));
    }
    if (includeExpl && it.answer_available && DATA.answerInfo) {
      if (onProgress) onProgress(`Reading answer-key page for item ${it.item}… (${i + 1}/${DATA.items.length})`);
      try {
        const info = await DATA.answerInfo(i);
        if (info && info.paragraphs) rec.explanation = info.paragraphs;
      } catch (e) {}
    }
    items.push(rec);
  }
  const counts = { correct: 0, incorrect: 0, skipped: 0, no_key: 0 };
  items.forEach((r) => counts[r.result]++);
  const json = {
    title: DATA.title || "Self-Assessment",
    sid: DATA.sid || null,
    exported_at: new Date().toISOString(),
    started_at: S.startedAt ? new Date(S.startedAt).toISOString() : null,
    score: { correct: sc.correct, scored: sc.scored, pct: sc.pct },
    counts, items,
  };

  const mark = { correct: "✓ Correct", incorrect: "✗ Incorrect", skipped: "○ Skipped", no_key: "– Not in key" };
  const md = [];
  md.push(`# ${json.title} — results`);
  md.push(`Exported ${json.exported_at.slice(0, 10)}. Score **${sc.correct}/${sc.scored} (${sc.pct}%)** — ` +
    `${counts.incorrect} incorrect, ${counts.skipped} skipped, ${counts.no_key} not in key.`);
  const missed = items.filter((r) => r.result === "incorrect" || r.result === "skipped").map((r) => r.item);
  const marked = items.filter((r) => r.marked).map((r) => r.item);
  md.push(`Missed: ${missed.length ? missed.join(", ") : "none"}. Marked: ${marked.length ? marked.join(", ") : "none"}.`);
  md.push("");
  md.push("| Item | Yours | Key | Result | Marked |");
  md.push("|---|---|---|---|---|");
  items.forEach((r) => md.push(`| ${r.item} | ${r.your || "—"} | ${r.correct || "—"} | ${mark[r.result]} | ${r.marked ? "yes" : ""} |`));
  const hasDetail = items.some((r) => r.stem || r.explanation);
  if (hasDetail) {
    md.push("");
    md.push("## Items");
    items.forEach((r) => {
      md.push("");
      md.push(`### Item ${r.item} — ${mark[r.result]} (yours ${r.your || "—"}, key ${r.correct || "—"})` +
        (r.marked ? " · marked" : ""));
      if (r.stem) md.push(r.stem);
      if (r.choices) r.choices.forEach((c) => md.push(`- ${c.letter}. ${c.text}`));
      if (r.explanation) { md.push(""); md.push("**Answer key:** " + r.explanation.join("\n\n")); }
    });
  }
  return { json, md: md.join("\n") + "\n" };
}
function downloadText(name, text, mime) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: mime }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function exportBaseName() {
  return (DATA.title || "self-assessment").replace(/[^\w\-]+/g, "_").replace(/^_+|_+$/g, "") +
    "_results_" + new Date().toISOString().slice(0, 10);
}
let EXPORT = null;
async function refreshExport() {
  const inc = $("exportExpl").checked;
  const box = $("exportText");
  $("exportCopy").disabled = $("exportMd").disabled = $("exportJson").disabled = true;
  box.value = "Building export…";
  $("exportStatus").textContent = "";
  EXPORT = await buildExport(inc, (m) => { $("exportStatus").textContent = m; });
  $("exportStatus").textContent = "";
  box.value = EXPORT.md;
  $("exportCopy").disabled = $("exportMd").disabled = $("exportJson").disabled = false;
}
function wireExport() {
  if (!$("exportBtn")) return;
  $("exportBtn").onclick = () => { openModal("exportModal"); refreshExport(); };
  $("exportExpl").onchange = refreshExport;
  $("exportCopy").onclick = async () => {
    try {
      await navigator.clipboard.writeText($("exportText").value);
      $("exportCopy").textContent = "Copied ✓";
    } catch (e) {
      $("exportText").select();
      document.execCommand("copy");
      $("exportCopy").textContent = "Copied ✓";
    }
    setTimeout(() => { $("exportCopy").textContent = "Copy"; }, 1500);
  };
  $("exportMd").onclick = () => EXPORT && downloadText(exportBaseName() + ".md", EXPORT.md, "text/markdown");
  $("exportJson").onclick = () => EXPORT &&
    downloadText(exportBaseName() + ".json", JSON.stringify(EXPORT.json, null, 2), "application/json");
}

/* ------------------------------------------------------------------ */
document.addEventListener("DOMContentLoaded", () => {
  wireDrop("drop-q", "txt-q", "file-q");
  wireDrop("drop-a", "txt-a", "file-a");
  $("go").addEventListener("click", startExam);
});
