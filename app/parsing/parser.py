"""
self-assessment PDF parser.

Turns a "questions" PDF and an "answer key" PDF (the format exported by the
common self-assessment shares) into a structured exam:

  - Each question page is rendered to an image, cropped to the content area
    (the blue header/footer chrome is stripped so the app can draw its own
    live chrome around a crisp question image).
  - Word bounding boxes are extracted so the browser can implement exam-style
    click-and-drag text highlighting on top of the image.
  - Choice rows + radio-circle positions are located so answers can be
    selected directly on the image.
  - The correct answer letter + the full answer/explanation page image are
    pulled from the answer key, matched to each question by item number with a
    text-similarity cross-check. Items that have no match in the answer key
    (a real gap in some source PDFs) are flagged `answer_available == False`
    and excluded from scoring.

Nothing here is specific to a single form; it works on any PDF in this layout.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, asdict

import fitz  # PyMuPDF
import numpy as np

from . import stitch


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

def _norm(s: str) -> str:
    """Aggressively normalise text for fuzzy comparison."""
    # OCR'd text layers separate words with U+00A0, which defeats the
    # literal spaces in the chrome pattern below.
    s = s.replace("\u00a0", " ")
    s = re.sub(r"Exam Section.*?Self-Assessment", " ", s, flags=re.S)
    # the other share format's header: "Question 7 Of 50 (03:41)". The timer
    # differs between a question page and its answer page, so it has to go
    # before the two stems are compared.
    s = re.sub(r"Question\s*\d+\s*[Oo]f\s*\d+\s*\(?[\d:]*\)?", " ", s)
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


# The answer key prints a red X before a wrongly answered item's number, and
# OCR'd pages can carry other marker glyphs there.
_ITEM_MARK = re.compile(r"^.*?\n[^\S\n]*(?:[Xx\u00d7*\u2713\u221a]\s*)?\d+\s*[.)]\s",
                        re.S)


def _stem_key(text: str) -> str:
    """Extract a normalised question-stem fingerprint from raw page text."""
    # Drop everything up to and including the leading "N." item number.
    t = _ITEM_MARK.sub(" ", text, count=1)
    # Stop at the first answer choice or the answer-key marker.
    t = re.split(r"\n\s*[A-Z]\)|Correct\s*Answer", t)[0]
    return _norm(t)[:350]


# Two share formats, two page headers: the NBME client prints
# "Exam Section : Item 7 of 50", the app the ObGyn forms come from prints
# "Question 7 Of 50 (03:41)". Either one names the item the page belongs to.
# The space can be lost by OCR ("Question 35Of Of 50"), so it is optional.
_HEADER_ITEM = re.compile(r"(?:Item|Question)\s*(\d+)\s*[Oo]f\b")


def _item_number(text: str, fallback: int | None) -> int | None:
    """Best-effort item number from a page (header, then body, then fallback)."""
    m = _HEADER_ITEM.search(text)
    if m:
        return int(m.group(1))
    m = re.search(r"(?:^|\n)\s*(\d+)\s*[.)]\s+[A-Z(]", text)
    if m:
        return int(m.group(1))
    return fallback


def _text_from_words(words: list[dict]) -> str:
    """Rebuild page text from positioned words, one visual line per line.

    Needed only for items stitched from several screenshots, where no single
    PDF page holds the whole stem; single-page items keep the PDF's own text.
    """
    if not words:
        return ""
    heights = sorted(w["y1"] - w["y0"] for w in words)
    tol = heights[len(heights) // 2] * 0.6
    lines: list[list[dict]] = []
    for w in sorted(words, key=lambda w: ((w["y0"] + w["y1"]) / 2, w["x0"])):
        cy = (w["y0"] + w["y1"]) / 2
        if lines and abs(cy - lines[-1][0]["_cy"]) <= tol:
            lines[-1].append(w)
        else:
            lines.append([w])
        lines[-1][0].setdefault("_cy", cy)
    return "\n".join(
        " ".join(w["text"] for w in sorted(ln, key=lambda w: w["x0"]))
        for ln in lines
    )


def _bigrams(s: str) -> dict[str, int]:
    d: dict[str, int] = {}
    for i in range(len(s) - 1):
        d[s[i:i + 2]] = d.get(s[i:i + 2], 0) + 1
    return d


def _similarity(a: str, b: str) -> float:
    """Dice coefficient over character bigrams.

    Replaces difflib.SequenceMatcher, whose autojunk heuristic silently
    discards common characters in strings longer than 200 and then scores
    genuinely matching 350-character stems near zero. docs/parser.js scores
    the same way, so both parsers accept or reject the same matches.
    """
    A, B = _bigrams(a), _bigrams(b)
    total = sum(A.values()) + sum(B.values())
    if not total:
        return 0.0
    shared = sum(min(n, B.get(g, 0)) for g, n in A.items())
    return 2 * shared / total


# The key's lead line normally reads "Correct Answer: G.", but the colon is a
# glyph of its own and some exports lose it: Surgery 3 item 24 prints
# "Correct Answer G." and the item came out with no key at all. The separator
# is therefore optional, which means the pattern must refuse
# "Incorrect Answers: A, B, C" on its own merits -- once by what precedes
# "Correct" and once by the plural "Answers" -- and must take a letter that
# stands alone, never the initial of the next word.
_CORRECT_ANSWER = re.compile(
    r"(?:^|[^A-Za-z])Correct\s*Answer(?!s)\s*[:.\u2013\u2014-]?\s*([A-Z])(?![A-Za-z])"
)


def _correct_letter(text: str) -> str | None:
    m = _CORRECT_ANSWER.search(text)
    return m.group(1) if m else None


# --------------------------------------------------------------------------- #
# Image / geometry helpers
# --------------------------------------------------------------------------- #

def _content_band(arr: np.ndarray) -> tuple[int, int]:
    """
    Find the vertical content band by locating the dark-blue header and
    footer bars. Returns (top, bottom) pixel rows of the content region.
    """
    h = arr.shape[0]
    r = arr[:, :, 0].astype(int)
    g = arr[:, :, 1].astype(int)
    b = arr[:, :, 2].astype(int)
    # The chrome bars are dark navy: blue dominant, all channels fairly dark.
    blue = (b > 55) & (b < 170) & (b > r + 18) & (b > g + 8) & (r < 100)
    frac = blue.mean(axis=1)
    dark_rows = np.where(frac > 0.45)[0]

    top = 0
    bottom = h
    if len(dark_rows):
        top_band = dark_rows[dark_rows < h * 0.22]
        bot_band = dark_rows[dark_rows > h * 0.78]
        if len(top_band):
            top = int(top_band.max()) + 1
        if len(bot_band):
            bottom = int(bot_band.min())
        else:
            # A capture pasted onto a larger sheet leaves white below it, so
            # the footer bar stops well short of the page bottom: Surgery
            # Form 2's sits at 0.70-0.75 of page height on every page, under
            # the 0.78 cut, and the whole footer ("Next / Lab Values / Review
            # / Help / Pause") was landing inside the last choice on 45 of its
            # 48 text-mode items. Fall back to the last run of navy rows,
            # which is the footer whatever height it sits at -- but only below
            # the middle of the page, so a dark figure in the content area is
            # never mistaken for one.
            # The footer is not one solid run: the seal watermark lightens its
            # middle, so it breaks into two bands a few rows apart, and taking
            # the last of them would cut inside the footer and leave its
            # labels in the item. Join runs closer together than a twentieth
            # of the page, far below the content-to-footer distance.
            gap = max(4, h * 0.05)
            breaks = np.where(np.diff(dark_rows) > gap)[0]
            foot_start = int(dark_rows[breaks[-1] + 1]) if len(breaks) else int(dark_rows[0])
            if foot_start > h * 0.5 and foot_start > top:
                bottom = foot_start
    if top == 0 and bottom == h:
        # No navy bars at all: the ObGyn share app draws its header and its
        # toolbar as flat light-grey strips on a white page. The content is
        # what is white, so walk in from each edge while the rows are not --
        # which steps over the toolbar's coloured icons, where a rule looking
        # for grey rows alone stops short and leaves "Define" in the stem.
        white = ((r >= 253) & (g >= 253) & (b >= 253)).mean(axis=1)
        y = 0
        while y < h * 0.22 and white[y] <= 0.6:
            y += 1
        top = y
        y = h - 1
        while y > h * 0.78 and white[y] <= 0.6:
            y -= 1
        bottom = y + 1
    # Safety padding so nothing important is clipped.
    top = max(0, top)
    bottom = min(h, bottom)
    if bottom - top < h * 0.3:  # detection failed; fall back to whole page
        return 0, h
    return top, bottom


def _png_bytes(arr: np.ndarray) -> bytes:
    """Encode an RGB pixel array as PNG."""
    arr = np.ascontiguousarray(arr)
    pix = fitz.Pixmap(fitz.csRGB, arr.shape[1], arr.shape[0], arr.tobytes(), False)
    return pix.tobytes("png")


def _choice_columns(ordered, cw: float) -> list[list[int]]:
    """Group the choice labels into columns, left to right.

    Answer choices are not always one column: a ten-choice item prints A to E
    down the left half and F to J down the right, a seventeen-choice one runs
    A to I left and J to Q right.  Jitter within one column is a few pixels
    (the labels are right-aligned, so "I)" starts further right than "M)"),
    while the step to the next column is most of the page.  Members come back
    in reading order down their own column.
    """
    thr = max(cw * 0.08, 40)
    cols: list[list[int]] = []
    last_x = None
    for i in sorted(range(len(ordered)), key=lambda i: ordered[i][1][0]):
        x0 = ordered[i][1][0]
        if last_x is None or x0 - last_x > thr:
            cols.append([])
        last_x = x0
        cols[-1].append(i)
    for m in cols:
        m.sort(key=lambda i: ordered[i][1][1])
    return cols


# The unticked radio circle, as OCR reads it: "O", "(O", "(OO", "\u00a9", "()"...
_LABEL_JUNK = re.compile(r"^[O0Qo\u00a9\u00ae\u2022()\[\]{}.,_|\-\u2013\u2014]{1,4}$")


def _choice_run(words: list[dict], top: float, bottom: float,
                pattern: str, line_initial: bool = False
                ) -> list[tuple[str, list[float]]]:
    """The contiguous run of choice labels A, B, C, ... on one page.

    `pattern` spells a label: "A)" on the NBME client, "A." on the app the
    ObGyn forms come from. Only the topmost occurrence of each letter counts,
    and never one above choice A's own line -- "37.0C (98.6F)" in a vitals
    table hands us an "F)" token a third of a page above the real choices, and
    a phantom F both invents a sixth choice and puts the run out of reading
    order. A second column's first label shares A's line, so a line of slack
    is allowed.
    """
    rx = re.compile(pattern)
    cands: dict[str, list[list[float]]] = {}
    for w in words:
        # the O of a choice label comes out of some text layers as a zero
        # (the same glyph the radio circles use)
        m = rx.match(w["text"])
        if not m:
            continue
        # A label opens its row. Only the radio circle, when OCR read it as a
        # token of its own, may sit to its left. Without this a choice ending
        # in "...vitamin E." would be read as the next choice in the run --
        # which is why the bracketed spelling, unambiguous on its own, does
        # not ask for it (a two-column grid's right-hand labels share a row
        # with the left's).
        if line_initial:
            cy = (w["y0"] + w["y1"]) / 2
            tol = (w["y1"] - w["y0"]) * 0.5
            left = [o for o in words if o is not w
                    and abs((o["y0"] + o["y1"]) / 2 - cy) <= tol
                    and o["x1"] <= w["x0"] + 2]
            if not all(_LABEL_JUNK.match(o["text"]) for o in left):
                continue
        L = "O" if m.group(1) == "0" else m.group(1)
        bx = [w["x0"], w["y0"], w["x1"], w["y1"]]
        # an unticked radio circle read as part of the label ("OA.", "OI.")
        # -- keep the right edge, since the circle sits in the part dropped
        if len(w["text"]) > 2:
            bx[0] = bx[2] - (bx[2] - bx[0]) * 2.0 / len(w["text"])
        if bx[1] < top or bx[3] > bottom:
            continue
        cands.setdefault(L, []).append(bx)
    for lst in cands.values():
        lst.sort(key=lambda b: b[1])
    letter_boxes = {}
    if "A" in cands:
        a0 = cands["A"][0]
        floor = a0[1] - (a0[3] - a0[1])
        for L, lst in cands.items():
            for bx in lst:
                if bx[1] >= floor:
                    letter_boxes[L] = bx
                    break
    ordered = []
    expect = ord("A")
    while chr(expect) in letter_boxes:
        ordered.append((chr(expect), letter_boxes[chr(expect)]))
        expect += 1
    return ordered


def _line_groups(words: list[dict]) -> list[dict]:
    """Cluster positioned words into visual lines, top to bottom.

    Same clustering docs/parser.js does before it reflows a page, kept here so
    both parsers see the same lines when they decide where the stem is.
    """
    if not words:
        return []
    ws = sorted(words, key=lambda w: ((w["y0"] + w["y1"]) / 2, w["x0"]))
    heights = sorted(w["y1"] - w["y0"] for w in ws)
    tol = max(heights[len(heights) // 2] * 0.5, 2.0)
    lines: list[dict] = []
    for w in ws:
        cy = (w["y0"] + w["y1"]) / 2
        if lines and abs(cy - lines[-1]["cy"]) <= tol:
            lines[-1]["words"].append(w)
        else:
            lines.append({"cy": cy, "words": [w]})
    for ln in lines:
        ln["words"].sort(key=lambda w: w["x0"])
        ln["x0"] = min(w["x0"] for w in ln["words"])
        ln["x1"] = max(w["x1"] for w in ln["words"])
        ln["y0"] = min(w["y0"] for w in ln["words"])
        ln["y1"] = max(w["y1"] for w in ln["words"])
    return lines


def _stem_below_choices(words, ordered, bottom: float):
    """The first stem line printed BELOW the answer choices, or None.

    A matching set ("For each patient with a limp, select the most likely
    diagnosis.") prints its shared lead-in, then the whole lettered list, and
    only then the patient's vignette, so the page is choices-then-stem. Reading
    it as stem-then-choices gives the item no stem and hands the vignette to
    the last choice, whose band runs to the foot of the page.

    A wrapped continuation line of the last choice is indented to the choice
    text, while stem prose starts at the page's left margin, left of even the
    choice letters -- that is what tells the two apart. A line of button
    glyphs above the footer bar is not stem text either, so the block found
    has to be a real paragraph's worth of words.
    """
    if not ordered:
        return None
    label_left = min(bx[0] for _, bx in ordered)
    last = max((bx for _, bx in ordered), key=lambda b: (b[1] + b[3]) / 2)
    floor = (last[1] + last[3]) / 2 + (last[3] - last[1]) * 0.5
    below = [w for w in words
             if (w["y0"] + w["y1"]) / 2 > floor and w["y1"] <= bottom
             and re.search(r"[A-Za-z0-9]", w["text"])]
    if not below:
        return None
    lines = _line_groups(below)
    for i, ln in enumerate(lines):
        if ln["x0"] >= label_left - 4:
            continue
        wordy = sum(1 for L in lines[i:] for w in L["words"]
                    if re.search(r"[A-Za-z]{3,}", w["text"]))
        return ln if wordy >= 10 else None
    return None


def _radio_for_letter(arr: np.ndarray, lbox: tuple[float, float, float, float]):
    """
    Given a choice-letter bounding box in image pixels, locate the radio
    circle to its left. Returns (cx, cy, radius) in image pixels.
    """
    x0, y0, x1, y1 = lbox
    lh = y1 - y0
    scan_left = max(0, int(x0 - lh * 2.4))
    band = arr[int(y0):int(y1), scan_left:int(x0)]
    cx = x0 - lh * 0.95
    cy = (y0 + y1) / 2
    rad = lh * 0.45
    if band.size:
        gray = band.mean(axis=2)
        ys, xs = np.where(gray < 175)
        if len(xs) > 4:
            gx0, gx1 = xs.min() + scan_left, xs.max() + scan_left
            gy0, gy1 = ys.min() + int(y0), ys.max() + int(y0)
            cx = (gx0 + gx1) / 2
            cy = (gy0 + gy1) / 2
            rad = max(gx1 - gx0, gy1 - gy0) / 2
    return cx, cy, rad


# --------------------------------------------------------------------------- #
# Data model
# --------------------------------------------------------------------------- #

@dataclass
class Choice:
    letter: str
    row: list           # [x0, y0, x1, y1] normalised 0..1 to content image
    radio: list         # [cx, cy, r] normalised (x by width, y by height, r by height)


@dataclass
class Item:
    item: int
    q_page: int                                      # first page of the item
    img_w: int
    img_h: int
    choices: list = field(default_factory=list)     # list[Choice]
    words: list = field(default_factory=list)        # [[x0,y0,x1,y1], ...] normalised
    correct: str | None = None
    answer_available: bool = False
    a_page: int | None = None                        # first answer page
    q_pages: list = field(default_factory=list)      # every screenshot of the item
    a_pages: list = field(default_factory=list)      # every screenshot of its answer


# --------------------------------------------------------------------------- #
# Main parser
# --------------------------------------------------------------------------- #

class ExamParser:
    def __init__(self, questions_pdf: str, answers_pdf: str | None,
                 dpi: int = 132):
        self.qdoc = fitz.open(questions_pdf)
        # An answer key is optional: a form whose key has not been shared yet
        # still makes a usable practice sitting, with every item flagged as
        # having no key and left out of the score.
        self.adoc = fitz.open(answers_pdf) if answers_pdf else None
        self.dpi = dpi
        self.zoom = dpi / 72.0
        self.items: list[Item] = []
        self._q_pix_cache: dict[int, bytes] = {}
        self._a_pix_cache: dict[int, bytes] = {}
        self._crop: dict[int, tuple[int, int]] = {}  # item index -> (top,bottom) px
        self._q_render: dict[int, tuple] = {}
        self._a_render: dict[int, tuple] = {}
        self._q_groups: list[list[int]] = []
        self._a_groups: list[list[int]] = []

    # -- page rendering / grouping ------------------------------------------ #

    def _page(self, doc, cache: dict, pno: int):
        """(pixels, content band) for one page, rendered once."""
        if pno not in cache:
            pix = doc[pno].get_pixmap(dpi=self.dpi)
            arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
                pix.height, pix.width, pix.n
            )
            if pix.n == 4:
                arr = arr[:, :, :3]
            arr = np.ascontiguousarray(arr)
            cache[pno] = (arr, _content_band(arr))
        return cache[pno]

    def _words(self, doc, pno: int) -> list[dict]:
        """Page words in rendered-pixel coordinates."""
        return [{"x0": w[0] * self.zoom, "y0": w[1] * self.zoom,
                 "x1": w[2] * self.zoom, "y1": w[3] * self.zoom, "text": w[4]}
                for w in doc[pno].get_text("words")]

    def _groups(self, doc) -> list[list[int]]:
        """Pages of the document, grouped into one group per item.

        A page that names no item and carries next to no text is not part of
        any item: ObGyn Form 9's export contains a 1004x30 strip (a Touch Bar
        screenshot caught by the capture), which would otherwise become an
        item of its own and shift every item after it by one.
        """
        pages, nums = [], []
        for p in range(len(doc)):
            t = doc[p].get_text()
            n = _item_number(t, None)
            if n is None and len(re.findall(r"[A-Za-z]{2,}", t)) < 10:
                continue
            pages.append(p)
            nums.append(n)
        return [[pages[i] for i in g] for g in stitch.group_pages(nums)]

    def _stitched(self, doc, cache: dict, group: list[int]):
        """Composite image, merged words and content band for one item.

        A one-page group returns that page untouched, so forms with one page
        per item follow exactly the same path as before.
        """
        arrs, bands, words = [], [], []
        for p in group:
            arr, band = self._page(doc, cache, p)
            arrs.append(arr)
            bands.append(band)
            words.append(self._words(doc, p))
        offsets = []
        for i in range(1, len(group)):
            d = stitch.offset_from_text(
                stitch.build_anchors(words[i - 1], *bands[i - 1]),
                stitch.build_anchors(words[i], *bands[i]),
            )
            if d is None:
                raise ValueError(
                    f"pages {group[i - 1]} and {group[i]} carry the same item "
                    f"number but share no text to align on"
                )
            offsets.append(stitch.refine_offset(
                arrs[i - 1], arrs[i], bands[i - 1], bands[i], d))
        img, shifts, spans = stitch.compose(arrs, bands, offsets)
        top = bands[0][0]
        bottom = top + spans[-1][1]
        merged = []
        for i, (ws, sh, (lo, hi)) in enumerate(zip(words, shifts, spans)):
            for w in ws:
                cy = (w["y0"] + w["y1"]) / 2 + sh
                # each shot owns the document rows it was cut to contribute;
                # the chrome bars come from the first and last shot
                if not (top + lo <= cy < top + hi
                        or (i == 0 and cy < top)
                        or (i == len(words) - 1 and cy >= bottom)):
                    continue
                merged.append({**w, "y0": w["y0"] + sh, "y1": w["y1"] + sh})
        merged.sort(key=lambda w: (round(w["y0"]), w["x0"]))
        # The seam is an integer row but the offset between two shots can be
        # fractional, so a line can land just either side of it and survive
        # twice. Drop a word that repeats another at the same place.
        seen: dict[tuple, float] = {}
        deduped = []
        for w in merged:
            key = (w["text"], round(w["x0"] / 2))
            cy = (w["y0"] + w["y1"]) / 2
            if key in seen and abs(seen[key] - cy) < (w["y1"] - w["y0"]) * 0.6:
                continue
            seen[key] = cy
            deduped.append(w)
        merged = deduped
        text = (doc[group[0]].get_text() if len(group) == 1
                else _text_from_words(merged))
        return img, merged, (top, bottom), text

    # -- answer key indexing ------------------------------------------------ #

    def _index_answers(self):
        """Map item number -> (group_index, correct_letter, stem_key).

        An item's answer can span several screenshots; they are grouped by
        header item number, so the letter and the stem are taken from the
        whole group rather than from whichever shot happened to come first.
        """
        if self.adoc is None:
            self._a_groups = []
            self._answer_pages = []
            self._answer_by_item = {}
            return
        self._a_groups = self._groups(self.adoc)
        by_item: dict[int, tuple[int, str, str]] = {}
        cands = []
        for gi, group in enumerate(self._a_groups):
            # Match on each marked page's own stem, as an unstitched key does,
            # but resolve to the group so the whole answer is rendered.
            for pno in group:
                t = self.adoc[pno].get_text()
                letter = _correct_letter(t)
                if letter is None:
                    continue  # continuation shot with no answer marker
                num = _item_number(t, None)
                key = _stem_key(t)
                cands.append((gi, num, letter, key))
                if num is not None and num not in by_item:
                    by_item[num] = (gi, letter, key)
        self._answer_pages = cands
        self._answer_by_item = by_item

    def _resolve_answer(self, item_no: int, q_stem: str):
        """
        Return (group_index, letter, confidence) for a question, or
        (None, None, 0.0) if the answer key has no matching group.

        Strategy: trust the header item number when its page's stem also
        agrees with the question stem; otherwise fall back to the best
        stem match across all answer pages. Failing both, fall back to the
        header item number alone — an item whose answer was captured in
        several screenshots can have its stem split across them, leaving no
        single page similar enough to the question, while its printed item
        number is unambiguous. Only an item the key never mentions stays
        unmatched.
        """
        best_page = best_letter = None
        best_ratio = 0.0
        # candidate 1: same item number in the answer key
        cand = self._answer_by_item.get(item_no)
        if cand:
            pi, letter, akey = cand
            r = _similarity(q_stem, akey)
            best_page, best_letter, best_ratio = pi, letter, r
        # candidate 2: best stem match anywhere (handles header OCR errors)
        for pi, num, letter, akey in self._answer_pages:
            r = _similarity(q_stem, akey)
            if r > best_ratio:
                best_page, best_letter, best_ratio = pi, letter, r
        # Dice needs a higher bar than difflib's 0.55: true matches are
        # near-identical (~0.9), unrelated stems sharing medical vocabulary
        # reach ~0.6.
        if best_ratio < 0.75:
            if cand:
                pi, letter, _ = cand
                return pi, letter, best_ratio
            return None, None, best_ratio
        return best_page, best_letter, best_ratio

    # -- question parsing --------------------------------------------------- #

    def _parse_item(self, idx: int, group: list[int]) -> Item:
        arr, words, (top, bottom), text = self._stitched(
            self.qdoc, self._q_render, group)
        self._crop[idx] = (top, bottom)
        cw, ch = arr.shape[1], bottom - top

        # locate choice letters: "A)" on the NBME client, "A." on the app the
        # ObGyn forms come from, either of them with the radio circle fused
        # onto the front. The second pass accepts both spellings, because the
        # OCR repair can rewrite a dotted page's clean labels and leave the
        # fused ones behind, and it is taken only when it finds more labels
        # than the unambiguous bracketed pass did.
        ordered = _choice_run(words, top, bottom, r"^([A-Z0])\)$")
        loose = _choice_run(words, top, bottom,
                            r"^[O0Qo\u00a9\u00ae\u2022(\[]?([A-Z])[.)]$",
                            line_initial=True)
        if len(loose) > len(ordered):
            ordered = loose

        radios = [_radio_for_letter(arr, bx) for _, bx in ordered]
        cols = _choice_columns(ordered, cw)
        # a matching set prints its choices above the vignette; the bottom
        # choice's row must stop where that stem text starts
        stem_line = _stem_below_choices(words, ordered, bottom)
        body_top = stem_line["y0"] - 2 if stem_line else None
        col_of = {}
        for ci, members in enumerate(cols):
            for i in members:
                col_of[i] = ci
        col_left = [min(radios[i][0] - radios[i][2] * 1.6 for i in m) for m in cols]
        col_right = [col_left[ci + 1] - 4 if ci + 1 < len(cols) else cw * 0.99
                     for ci in range(len(cols))]

        choices = []
        for idx, (L, bx) in enumerate(ordered):
            cx, cy, rad = radios[idx]
            members = cols[col_of[idx]]
            pos = members.index(idx)
            nbx = ordered[members[pos + 1]][1] if pos + 1 < len(members) else None
            # row vertical span: from this letter to the next one DOWN ITS OWN
            # COLUMN — with A to E left and F to J right, the next letter after
            # E is back at the top of the page and the row came out negative
            row_top = bx[1] - rad * 0.6
            if nbx is not None:
                row_bot = nbx[1] - rad * 0.6
            else:
                row_bot = bx[3] + (bx[3] - bx[1]) * 1.4
            if body_top is not None:
                row_bot = min(row_bot, body_top)
            row_left = cx - rad * 1.6
            row_right = col_right[col_of[idx]]
            row = [row_left / cw, (row_top - top) / ch,
                   row_right / cw, (row_bot - top) / ch]
            radio = [cx / cw, (cy - top) / ch, rad / ch]
            choices.append(Choice(L, [round(v, 5) for v in row],
                                  [round(v, 5) for v in radio]))

        # word boxes + text for the selectable text layer (content area only,
        # skip pure-symbol noise). fitz returns words in reading order
        # (block/line/word), which the client relies on for native selection.
        wb = []
        for w in words:
            x0, y0, x1, y1 = w["x0"], w["y0"], w["x1"], w["y1"]
            if y0 < top or y1 > bottom:
                continue
            if not re.search(r"[A-Za-z0-9]", w["text"]):
                continue
            wb.append([round(x0 / cw, 5), round((y0 - top) / ch, 5),
                       round(x1 / cw, 5), round((y1 - top) / ch, 5), w["text"]])

        item_no = _item_number(text, idx + 1)
        return Item(item=item_no, q_page=group[0], img_w=cw, img_h=ch,
                    choices=choices, words=wb, q_pages=list(group))

    # -- public ------------------------------------------------------------- #

    def parse(self) -> list[Item]:
        self._index_answers()
        self._q_groups = self._groups(self.qdoc)
        items = []
        for idx, group in enumerate(self._q_groups):
            it = self._parse_item(idx, group)
            _, _, _, text = self._stitched(self.qdoc, self._q_render, group)
            a_group, letter, conf = self._resolve_answer(it.item, _stem_key(text))
            if a_group is not None:
                it.a_pages = list(self._a_groups[a_group])
                it.a_page = it.a_pages[0]
                it.correct = letter
                it.answer_available = True
            items.append(it)
        self.items = items
        return items

    def question_png(self, idx: int) -> bytes:
        """Rendered, content-cropped question image as PNG bytes."""
        if idx not in self._q_pix_cache:
            arr, _, (top, bottom), _ = self._stitched(
                self.qdoc, self._q_render, self._q_groups[idx])
            self._q_pix_cache[idx] = _png_bytes(arr[top:bottom])
        return self._q_pix_cache[idx]

    def answer_png(self, idx: int) -> bytes:
        """Full answer image (already contains highlight + explanation)."""
        if idx not in self._a_pix_cache:
            group = self.items[idx].a_pages
            arr, _, _, _ = self._stitched(self.adoc, self._a_render, group)
            self._a_pix_cache[idx] = _png_bytes(arr)
        return self._a_pix_cache[idx]

    def title(self) -> str:
        try:
            t = self.qdoc[0].get_text()
            m = re.search(r"\n([A-Z][A-Za-z ]+Self-Assessment)", t)
            if m:
                return m.group(1).strip()
        except Exception:
            pass
        return "Self-Assessment"

    def to_dict(self) -> dict:
        return {
            "count": len(self.items),
            "title": self.title(),
            "items": [
                {
                    "item": it.item,
                    "img_w": it.img_w,
                    "img_h": it.img_h,
                    "aspect": round(it.img_h / it.img_w, 5) if it.img_w else 1,
                    "choices": [asdict(c) for c in it.choices],
                    "words": it.words,
                    "correct": it.correct,
                    "answer_available": it.answer_available,
                    "has_answer_image": it.a_page is not None,
                }
                for it in self.items
            ],
        }
