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

import difflib
import re
from dataclasses import dataclass, field, asdict

import fitz  # PyMuPDF
import numpy as np


# --------------------------------------------------------------------------- #
# Text helpers
# --------------------------------------------------------------------------- #

def _norm(s: str) -> str:
    """Aggressively normalise text for fuzzy comparison."""
    s = re.sub(r"Exam Section.*?Self-Assessment", " ", s, flags=re.S)
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def _stem_key(text: str) -> str:
    """Extract a normalised question-stem fingerprint from raw page text."""
    # Drop everything up to and including the leading "N." item number.
    t = re.sub(r"^.*?\n\s*\d+\s*[.)]\s", " ", text, count=1, flags=re.S)
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
    q_page: int
    img_w: int
    img_h: int
    choices: list = field(default_factory=list)     # list[Choice]
    words: list = field(default_factory=list)        # [[x0,y0,x1,y1], ...] normalised
    correct: str | None = None
    answer_available: bool = False
    a_page: int | None = None                        # page index in answers pdf


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
        self._crop: dict[int, tuple[int, int]] = {}  # q_page -> (top,bottom) px

    # -- answer key indexing ------------------------------------------------ #

    def _index_answers(self):
        """Map item number -> (page_index, correct_letter, stem_key)."""
        by_item: dict[int, tuple[int, str, str]] = {}
        pages = []
        for i in range(len(self.adoc)):
            t = self.adoc[i].get_text()
            letter = _correct_letter(t)
            if letter is None:
                continue  # spillover/continuation page with no answer marker
            num = _item_number(t, None)
            pages.append((i, num, letter, _stem_key(t)))
            if num is not None and num not in by_item:
                by_item[num] = (i, letter, _stem_key(t))
        self._answer_pages = pages
        self._answer_by_item = by_item

    def _resolve_answer(self, item_no: int, q_stem: str):
        """
        Return (page_index, letter, confidence) for a question, or
        (None, None, 0.0) if the answer key has no matching page.

        Strategy: trust the header item number when its page's stem also
        agrees with the question stem; otherwise fall back to the best
        stem match across all answer pages. Require a real similarity so a
        genuinely missing item stays unmatched.
        """
        best_page = best_letter = None
        best_ratio = 0.0
        # candidate 1: same item number in the answer key
        cand = self._answer_by_item.get(item_no)
        if cand:
            pi, letter, akey = cand
            r = difflib.SequenceMatcher(None, q_stem, akey).ratio()
            best_page, best_letter, best_ratio = pi, letter, r
        # candidate 2: best stem match anywhere (handles header OCR errors)
        for pi, num, letter, akey in self._answer_pages:
            r = difflib.SequenceMatcher(None, q_stem, akey).ratio()
            if r > best_ratio:
                best_page, best_letter, best_ratio = pi, letter, r
        if best_ratio < 0.55:
            return None, None, best_ratio
        return best_page, best_letter, best_ratio

    # -- question parsing --------------------------------------------------- #

    def _parse_question_page(self, pno: int) -> Item:
        page = self.qdoc[pno]
        pix = page.get_pixmap(dpi=self.dpi)
        arr = np.frombuffer(pix.samples, dtype=np.uint8).reshape(
            pix.height, pix.width, pix.n
        )
        if pix.n == 4:
            arr = arr[:, :, :3]
        top, bottom = _content_band(arr)
        self._crop[pno] = (top, bottom)
        cw, ch = pix.width, bottom - top

        words = page.get_text("words")

        # locate choice letters (A) B) ... up to J)
        letter_boxes = {}
        for w in words:
            m = re.match(r"^([A-J])\)$", w[4])
            if not m:
                continue
            L = m.group(1)
            bx = [w[0] * self.zoom, w[1] * self.zoom, w[2] * self.zoom, w[3] * self.zoom]
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
            x0, y0, x1, y1 = [c * self.zoom for c in w[:4]]
            if y0 < top or y1 > bottom:
                continue
            if not re.search(r"[A-Za-z0-9]", w[4]):
                continue
            wb.append([round(x0 / cw, 5), round((y0 - top) / ch, 5),
                       round(x1 / cw, 5), round((y1 - top) / ch, 5), w[4]])

        return Item(item=pno + 1, q_page=pno, img_w=cw, img_h=ch,
                    choices=choices, words=wb)

    # -- public ------------------------------------------------------------- #

    def parse(self) -> list[Item]:
        self._index_answers()
        n = len(self.qdoc)
        items = []
        for pno in range(n):
            it = self._parse_question_page(pno)
            q_stem = _stem_key(self.qdoc[pno].get_text())
            a_page, letter, conf = self._resolve_answer(it.item, q_stem)
            if a_page is not None:
                it.a_page = a_page
                it.correct = letter
                it.answer_available = True
            items.append(it)
        self.items = items
        return items

    def question_png(self, pno: int) -> bytes:
        """Rendered, content-cropped question image as PNG bytes."""
        if pno not in self._q_pix_cache:
            page = self.qdoc[pno]
            pix = page.get_pixmap(dpi=self.dpi)
            top, bottom = self._crop.get(pno, (0, pix.height))
            clip = fitz.Rect(0, top / self.zoom, pix.width / self.zoom,
                             bottom / self.zoom)
            pix2 = page.get_pixmap(dpi=self.dpi, clip=clip)
            self._q_pix_cache[pno] = pix2.tobytes("png")
        return self._q_pix_cache[pno]

    def answer_png(self, a_page: int) -> bytes:
        """Full answer-key page image (already contains highlight + explanation)."""
        if a_page not in self._a_pix_cache:
            self._a_pix_cache[a_page] = self.adoc[a_page].get_pixmap(
                dpi=self.dpi).tobytes("png")
        return self._a_pix_cache[a_page]

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
