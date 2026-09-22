#!/usr/bin/env python3
"""
Rewrite a prose "answers & explanations" PDF into the answer-key format the
parser expects.

Surgery Forms 1 and 2 are not shared as NBME answer screenshots. Their keys are
someone's written explanation list -- a continuous document, several items to a
page, no "Correct Answer:" anywhere:

    1. A) Appropriate in view of the medical necessity to remove the appendix
    2. A) Aldosteronoma
       - Hyperaldosteronism -> hypokalemia

The parser indexes a key by page: it needs one page per item, each naming its
item in the header and carrying a "Correct Answer: X" line, or it finds no key
at all and the whole form comes back unscored. This splits the list on its item
numbers and prints it back in that shape, explanation and all -- which also
makes a better review page than a real NBME key, since these come with written
explanations.

    python3 tools/make_key_pdf.py "1A.pdf" "1A_key.pdf"
    python3 tools/make_key_pdf.py "2A.pdf" "2A_key.pdf" --items 50

Pass --title to change the line under the header (default "Surgery
Self-Assessment"). The output is text, not images, so the parser reads it
directly and never sends it to OCR.
"""

from __future__ import annotations

import argparse
import re
import sys

import fitz

# The line that opens an item: "7. C" or "7. C)", at the start of a line. The
# letter has to stand alone -- "7. Cholecystitis" is prose, not a key line.
_ITEM = re.compile(r"(?:^|\n)[^\S\n]*(\d{1,2})\.[^\S\n]*([A-Z])(?=[\).\s])")

# macOS ships this and it covers the arrows, bullets and Greek the
# explanations use; Helvetica would drop them. Subset on save.
_FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

PAGE_W, PAGE_H = 612, 792
MARGIN = 58
SIZE = 10.5
LEAD = 15          # line spacing inside a paragraph
PARA = 24          # gap between paragraphs: the parser splits on > 1.55x the
                   # median gap, so this has to clear 15 * 1.55 = 23.3


def parse_items(doc: fitz.Document) -> list[tuple[int, str, str]]:
    """(item number, correct letter, explanation body) for every item found."""
    text = "\n".join(p.get_text() for p in doc)
    text = text.replace("﻿", "")            # the source is full of these
    marks = list(_ITEM.finditer(text))
    out = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end]
        body = body.lstrip(").  \t")        # drop the rest of "7. C)"
        out.append((int(m.group(1)), m.group(2), body.strip()))
    return out


def paragraphs(body: str) -> list[str]:
    """Explanation text as paragraphs, with each bullet on its own.

    The source wraps mid-sentence at the page width, so a hard newline is not a
    paragraph break: join everything and split on the bullets instead.
    """
    flat = re.sub(r"\s*\n\s*", " ", body).strip()
    parts = [p.strip(" \t") for p in re.split(r"(?=[•·])", flat)]
    return [re.sub(r"\s{2,}", " ", p) for p in parts if p.strip()]


def wrap(text: str, font: fitz.Font, width: float) -> list[str]:
    lines, cur = [], ""
    for word in text.split(" "):
        trial = f"{cur} {word}".strip()
        if cur and font.text_length(trial, SIZE) > width:
            lines.append(cur)
            cur = word
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines or [""]


def build(items, total, title, out_path):
    doc = fitz.open()
    font = fitz.Font(fontfile=_FONT)
    width = PAGE_W - 2 * MARGIN

    for num, letter, body in items:
        blocks = [[f"Correct Answer: {letter}."]]
        for para in paragraphs(body):
            blocks.append(wrap(para, font, width))

        page = None
        y = 0.0

        def new_page():
            nonlocal page, y
            page = doc.new_page(width=PAGE_W, height=PAGE_H)
            page.insert_font(fontname="AU", fontfile=_FONT)
            y = MARGIN
            # The header names the item; the parser reads the number from it.
            for line in (f"Exam Section : Item {num} of {total}",
                         "National Board of Medical Examiners",
                         title):
                page.insert_text((MARGIN, y), line, fontname="AU", fontsize=SIZE)
                y += LEAD
            y += PARA

        new_page()
        for bi, block in enumerate(blocks):
            if bi:
                y += PARA - LEAD
            if y + len(block) * LEAD > PAGE_H - MARGIN:
                new_page()                       # same header: one item, two pages
            for line in block:
                page.insert_text((MARGIN, y), line, fontname="AU", fontsize=SIZE)
                y += LEAD

    try:
        doc.subset_fonts()
    except Exception:
        pass
    doc.save(out_path, garbage=4, deflate=True)
    return doc.page_count


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", help="the prose answers/explanations PDF")
    ap.add_argument("out", help="answer-key PDF to write")
    ap.add_argument("--items", type=int, default=50, help="items on the form")
    ap.add_argument("--title", default="Surgery Self-Assessment")
    args = ap.parse_args()

    doc = fitz.open(args.source)
    items = parse_items(doc)
    nums = [n for n, _, _ in items]
    missing = [i for i in range(1, args.items + 1) if i not in nums]
    dupes = sorted({n for n in nums if nums.count(n) > 1})

    pages = build(items, args.items, args.title, args.out)
    print(f"{args.source}: {len(items)} items -> {args.out} ({pages} pages)")
    print("letters: " + "".join(l for _, l, _ in items))
    if missing:
        print(f"WARNING: no key line found for items {missing}", file=sys.stderr)
    if dupes:
        print(f"WARNING: item numbers seen more than once: {dupes}", file=sys.stderr)


if __name__ == "__main__":
    main()
