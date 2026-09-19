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
    t = re.split(r"\n\s*[A-J]\)|Correct\s*Answer", t)[0]
    return _norm(t)[:350]


def _item_number(text: str, fallback: int | None) -> int | None:
    """Best-effort item number from a page (header, then body, then fallback)."""
    m = re.search(r"Item\s+(\d+)\s+of", text)
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


def _correct_letter(text: str) -> str | None:
    m = re.search(r"Correct\s*Answer:\s*([A-J])", text)
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
    def __init__(self, questions_pdf: str, answers_pdf: str, dpi: int = 132):
        self.qdoc = fitz.open(questions_pdf)
        self.adoc = fitz.open(answers_pdf)
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
        """Pages of the document, grouped into one group per item."""
        return stitch.group_pages(
            [_item_number(doc[p].get_text(), None) for p in range(len(doc))]
        )

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

        # locate choice letters (A) B) ... up to J)
        letter_boxes = {}
        for w in words:
            m = re.match(r"^([A-J])\)$", w["text"])
            if not m:
                continue
            L = m.group(1)
            bx = [w["x0"], w["y0"], w["x1"], w["y1"]]
            # keep the first (topmost) occurrence per letter within content
            if bx[1] < top or bx[3] > bottom:
                continue
            if L not in letter_boxes or bx[1] < letter_boxes[L][1]:
                letter_boxes[L] = bx

        # only keep a contiguous run A, B, C, ...
        ordered = []
        expect = ord("A")
        while chr(expect) in letter_boxes:
            ordered.append((chr(expect), letter_boxes[chr(expect)]))
            expect += 1

        choices = []
        for idx, (L, bx) in enumerate(ordered):
            cx, cy, rad = _radio_for_letter(arr, bx)
            # row vertical span: from this letter to the next choice letter
            row_top = bx[1] - rad * 0.6
            if idx + 1 < len(ordered):
                row_bot = ordered[idx + 1][1][1] - rad * 0.6
            else:
                row_bot = bx[3] + (bx[3] - bx[1]) * 1.4
            row_left = cx - rad * 1.6
            row_right = cw * 0.99
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
