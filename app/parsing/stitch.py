"""Reassemble items captured as several scroll screenshots.

Some share PDFs put one item on one page. Others (Surgery 8, 2026-09-19)
capture a single item as two or three overlapping scroll shots: the first
shows the exhibit but clips the answer choices, a later one shows every
choice but clips the top of the exhibit. Pages then outnumber items, and a
parser that numbers items by page index shifts every later item and mis-keys
the exam.

The pages of one item are consecutive and all carry the same "Item N of M"
header, so they can be grouped by that header and painted back into a single
tall page: header bar from the first shot, the union of the content, footer
bar from the last.

Forms whose items already occupy one page each produce groups of one and take
the identity path through every function here.
"""

from __future__ import annotations

import numpy as np

# Text shorter than this repeats too often across a page to anchor an offset.
_MIN_ANCHOR_LEN = 5
# How far the pixel search may move the text-derived offset, in px.
_REFINE_RADIUS = 8
# Column stride for the pixel comparisons (speed; text is far wider than 4px).
_STRIDE = 4


def group_pages(item_numbers: list[int | None]) -> list[list[int]]:
    """Consecutive pages sharing one header item number become one group."""
    groups: list[list[int]] = []
    for p, num in enumerate(item_numbers):
        if (groups and num is not None
                and item_numbers[groups[-1][-1]] == num):
            groups[-1].append(p)
        else:
            groups.append([p])
    return groups


def offset_from_text(anchors_a: dict[str, float], anchors_b: dict[str, float]):
    """Rows B is scrolled past A, from text common to both shots.

    `anchors_*` map a content string to its single y-centre on that shot;
    strings appearing more than once on a shot must be dropped by the caller.
    """
    deltas = sorted(anchors_a[t] - anchors_b[t] for t in anchors_a.keys() & anchors_b.keys())
    if not deltas:
        return None
    med = deltas[len(deltas) // 2]
    agree = [d for d in deltas if abs(d - med) <= 6]
    return sum(agree) / len(agree) if agree else med


def build_anchors(words, top: float, bottom: float) -> dict[str, float]:
    """Content words long enough to anchor on, keyed by text, uniques only."""
    seen: dict[str, list[float]] = {}
    for w in words:
        if w["y0"] <= top or w["y1"] >= bottom:
            continue
        t = w["text"]
        if len(t) < _MIN_ANCHOR_LEN:
            continue
        seen.setdefault(t, []).append((w["y0"] + w["y1"]) / 2)
    return {t: ys[0] for t, ys in seen.items() if len(ys) == 1}


def _overlap_rows(band_a, band_b, d: int):
    """Document-row range both shots cover, given B scrolled `d` past A."""
    lo = max(0, d)
    hi = min(band_a[1] - band_a[0], band_b[1] - band_b[0] + d)
    return lo, hi


def _rows(arr, band, doc_lo, doc_hi, d=0):
    """The shot's pixel rows for a document-row range."""
    return arr[band[0] + doc_lo - d: band[0] + doc_hi - d, ::_STRIDE]


def refine_offset(arr_a, arr_b, band_a, band_b, d0: float) -> int:
    """Snap a text-derived offset to the exact row by comparing pixels.

    Text boxes are good to a few pixels; a seam is only invisible when the
    offset is exact, so search a small window for the best-matching shift.
    """
    best, best_score = int(round(d0)), None
    for d in range(int(round(d0)) - _REFINE_RADIUS, int(round(d0)) + _REFINE_RADIUS + 1):
        lo, hi = _overlap_rows(band_a, band_b, d)
        if hi - lo < 40:
            continue
        a = _rows(arr_a, band_a, lo, hi).astype(np.int16)
        b = _rows(arr_b, band_b, lo, hi, d).astype(np.int16)
        score = float(np.abs(a - b).mean())
        if best_score is None or score < best_score:
            best, best_score = d, score
    return best


def seam_row(arr_a, arr_b, band_a, band_b, d: int) -> int:
    """Document row to cut at: the row inside the overlap where the two shots
    agree most closely, which in practice is a blank row between text lines."""
    lo, hi = _overlap_rows(band_a, band_b, d)
    lo, hi = lo + 6, hi - 6
    if hi <= lo:
        return max(0, d)
    a = _rows(arr_a, band_a, lo, hi).astype(np.int16)
    b = _rows(arr_b, band_b, lo, hi, d).astype(np.int16)
    per_row = np.abs(a - b).mean(axis=(1, 2))
    # a blank row is also cheap to cut through: prefer low ink as a tie-break
    ink = 255 - a.mean(axis=(1, 2))
    score = per_row * 4 + ink * 0.02
    return int(lo + int(np.argmin(score)))


def plan(arrs, bands, offsets):
    """Where each shot's content lands in the stitched page.

    Returns (height, top, starts, spans): the composite height, the content
    top, each shot's first document row, and the document-row span each shot
    contributes (shots overlap; the spans partition the document).
    """
    starts = [0]
    for d in offsets:
        starts.append(starts[-1] + d)
    seams = [starts[i] + seam_row(arrs[i], arrs[i + 1], bands[i], bands[i + 1], offsets[i])
             for i in range(len(arrs) - 1)]
    doc_end = starts[-1] + (bands[-1][1] - bands[-1][0])
    bounds = [0] + seams + [doc_end]
    top = bands[0][0]
    height = top + doc_end + (arrs[-1].shape[0] - bands[-1][1])
    spans = [(bounds[i], bounds[i + 1]) for i in range(len(arrs))]
    return height, top, starts, spans


def compose(arrs, bands, offsets):
    """Paint the shots into one tall image.

    Returns (image, shifts, spans): `shifts` maps each shot's own pixel rows
    into the composite (add it), `spans` is the document-row range each shot
    contributes, so text can be merged without duplicating the overlap.
    A single shot is returned untouched.
    """
    if len(arrs) == 1:
        return arrs[0], [0], [(0, bands[0][1] - bands[0][0])]
    height, top, starts, spans = plan(arrs, bands, offsets)
    out = np.full((height, arrs[0].shape[1], arrs[0].shape[2]), 255, dtype=arrs[0].dtype)
    out[:top] = arrs[0][:top]                             # header bar, first shot
    out[top + spans[-1][1]:] = arrs[-1][bands[-1][1]:]    # footer bar, last shot
    shifts = []
    for arr, band, start, (lo, hi) in zip(arrs, bands, starts, spans):
        out[top + lo: top + hi] = arr[band[0] + lo - start: band[0] + hi - start]
        shifts.append(top + start - band[0])
    return out, shifts, spans
