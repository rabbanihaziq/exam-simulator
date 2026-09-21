#!/usr/bin/env python3
"""Add an invisible OCR text layer to an image-only (flat screenshot) exam PDF.

Some self-assessment share PDFs are one screenshot per page with no text layer
(just a ~25 character "t.me" watermark).  The parsers in this repo look for
"Item N of 50", the "A)" choice tokens and "Correct Answer: X" in the PDF text,
so they see nothing at all in those files.

This tool OCRs each page and writes the words back as *invisible* text
(render_mode 3) positioned over the pixels they came from, so the unmodified
parsers -- and the browser's own text selection -- work on the result.

    python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Questions.pdf"
    python tools/ocr_layer/ocr_pdf.py in.pdf out.pdf --engine tesseract --jobs 8
    python tools/ocr_layer/ocr_pdf.py in.pdf --check

Engines:
  vision     Apple Vision (macOS only, needs pyobjc-framework-Vision/-Quartz).
             Best quality; includes a repair pass for the lines Vision merges.
  tesseract  The `tesseract` CLI (cross platform, works on Windows).
  auto       vision when it imports, else tesseract.

Everything else -- the token cleanups, the baseline snapping, the width-fitted
font sizes and the ToUnicode patch -- is shared by both engines.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import csv
import io
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time

import fitz  # PyMuPDF


# --------------------------------------------------------------------------- #
# Fonts
# --------------------------------------------------------------------------- #

MAC_ARIAL = "/System/Library/Fonts/Supplemental/Arial.ttf"


def pick_font() -> tuple[str, str | None]:
    """(fontname, fontfile).  Arial on macOS, PyMuPDF's built-in Helvetica else.

    Both are metrically compatible enough for the width-fitted sizes used here.
    The built-in "helv" is a base-14 font: PyMuPDF writes no ToUnicode stream
    for it, so the soft-hyphen / no-break-space patch below simply finds
    nothing to patch (the text already extracts as U+002D and U+0020).
    """
    if os.path.exists(MAC_ARIAL):
        return "ocr", MAC_ARIAL
    return "helv", None


# --------------------------------------------------------------------------- #
# Page images
# --------------------------------------------------------------------------- #

def page_image(page: fitz.Page, out_path_noext: str, dpi: int,
               grayscale: bool = False):
    """Write one page's OCR input image.

    A share-PDF page is a single embedded screenshot: extract it at its native
    resolution (2666x1499 in these files) rather than re-rendering, which is
    both faster and sharper.  Anything else (no image, or several) is rendered
    at `dpi`.

    `grayscale` converts to luminance first.  This matters a lot for Tesseract:
    on the colour screenshots it silently drops whole regions -- a yellow
    highlighted choice row, the blue "Correct Answer: X" line -- and recovers
    them all once the image is a plain grey PNG (147 -> 241 words on one
    Form 7 answer page).  Vision reads the colour original fine.

    Returns (path, W, H, rect) where rect is the PDF-space rectangle the image
    covers, used to map image pixels back to points.
    """
    imgs = page.get_images(full=True)
    if len(imgs) == 1:
        xref = imgs[0][0]
        rects = page.get_image_rects(xref)
        if len(rects) == 1:
            info = page.parent.extract_image(xref)
            if grayscale:
                from PIL import Image
                path = f"{out_path_noext}.png"
                with Image.open(io.BytesIO(info["image"])) as im:
                    im.convert("L").save(path)
            else:
                path = f"{out_path_noext}.{info['ext']}"
                with open(path, "wb") as fh:
                    fh.write(info["image"])
            return path, info["width"], info["height"], rects[0]

    pix = (page.get_pixmap(dpi=dpi, colorspace=fitz.csGRAY) if grayscale
           else page.get_pixmap(dpi=dpi))
    path = f"{out_path_noext}.png"
    pix.save(path)
    return path, pix.width, pix.height, page.rect


# --------------------------------------------------------------------------- #
# Engine: Apple Vision
# --------------------------------------------------------------------------- #

def vision_available() -> bool:
    if platform.system() != "Darwin":
        return False
    try:
        import Vision  # noqa: F401
        import Quartz  # noqa: F401
        import Foundation  # noqa: F401
    except Exception:
        return False
    return True


def vision_ocr(path: str, correction: bool = True):
    """(W, H, lines) from Apple Vision.  lines: {text, box, conf, words}."""
    import Vision
    import Quartz
    import Foundation

    url = Foundation.NSURL.fileURLWithPath_(path)
    src = Quartz.CGImageSourceCreateWithURL(url, None)
    img = Quartz.CGImageSourceCreateImageAtIndex(src, 0, None)
    W = Quartz.CGImageGetWidth(img)
    H = Quartz.CGImageGetHeight(img)
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
    req.setUsesLanguageCorrection_(correction)
    req.setRecognitionLanguages_(["en-US"])
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(img, None)
    ok, err = handler.performRequests_error_([req], None)
    if not ok:
        raise RuntimeError(err)

    lines = []
    for obs in req.results():
        cand = obs.topCandidates_(1)[0]
        text = cand.string()
        bb = obs.boundingBox()
        lx0 = bb.origin.x * W
        ly1 = (1 - bb.origin.y) * H
        lx1 = lx0 + bb.size.width * W
        ly0 = ly1 - bb.size.height * H
        words = []
        for m in re.finditer(r"\S+", text):
            rng = Foundation.NSMakeRange(m.start(), len(m.group()))
            box, _e = cand.boundingBoxForRange_error_(rng, None)
            if box is None:
                words.append((m.group(), None))
                continue
            b = box.boundingBox()
            x0 = b.origin.x * W
            y1 = (1 - b.origin.y) * H
            x1 = x0 + b.size.width * W
            y0 = y1 - b.size.height * H
            words.append((m.group(),
                          [round(x0, 1), round(y0, 1), round(x1, 1), round(y1, 1)]))
        lines.append({
            "text": text,
            "box": [round(lx0, 1), round(ly0, 1), round(lx1, 1), round(ly1, 1)],
            "conf": float(cand.confidence()),
            "words": words,
        })
    lines.sort(key=lambda l: (l["box"][1], l["box"][0]))
    return W, H, lines


def vision_repair(path: str, W: int, H: int, lines: list, verbose: bool = False):
    """Re-OCR the lines Vision mis-segmented.

    Vision happily merges two adjacent stem lines into one garbage box.  Those
    show up as low confidence or as a box roughly twice the median line height;
    re-OCR a 2x-scaled crop of each and splice the result back in, dropping any
    re-read line that overlaps a line we already trust.
    """
    from PIL import Image

    top, bot = 0.10 * H, 0.934 * H
    hs = [l["box"][3] - l["box"][1] for l in lines if top < l["box"][1] < bot]
    med = statistics.median(hs) if hs else 0.023 * H
    bad = [i for i, l in enumerate(lines)
           if top < l["box"][1] < bot
           and (l["conf"] < 0.7 or (l["box"][3] - l["box"][1]) > 1.6 * med)]
    if not bad:
        return lines

    im = Image.open(path)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    newlines = []
    try:
        for i, l in enumerate(lines):
            if i not in bad:
                newlines.append(l)
                continue
            x0, y0, x1, y1 = l["box"]
            pad = 12
            cx0, cy0 = max(0, int(x0 - pad)), max(0, int(y0 - pad))
            crop = im.crop((cx0, cy0, min(im.width, int(x1 + pad)),
                            min(im.height, int(y1 + pad))))
            if crop.width < 2 or crop.height < 2:
                newlines.append(l)
                continue
            crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
            crop.save(tmp.name)
            _w, _h, sub = vision_ocr(tmp.name)
            for s in sub:
                s["box"] = [round(v / 2 + (cx0 if k % 2 == 0 else cy0), 1)
                            for k, v in enumerate(s["box"])]
                s["words"] = [
                    (t, [round(v / 2 + (cx0 if k % 2 == 0 else cy0), 1)
                         for k, v in enumerate(b)] if b else None)
                    for t, b in s["words"]
                ]
                s["repaired"] = True
            if verbose:
                print(f"    repair conf={l['conf']:.2f} {l['text'][:50]!r} -> "
                      f"{[s['text'][:40] for s in sub]}")
            newlines.extend(sub)
    finally:
        os.unlink(tmp.name)

    def overlaps(a, b):
        ax0, ay0, ax1, ay1 = a["box"]
        bx0, by0, bx1, by1 = b["box"]
        vy = min(ay1, by1) - max(ay0, by0)
        vx = min(ax1, bx1) - max(ax0, bx0)
        return (vy > 0.5 * min(ay1 - ay0, by1 - by0)
                and vx > 0.3 * min(ax1 - ax0, bx1 - bx0))

    keep = [l for l in newlines if not l.get("repaired")]
    for r in sorted((l for l in newlines if l.get("repaired")),
                    key=lambda l: -len(l["text"])):
        if not any(overlaps(r, o) for o in keep):
            keep.append(r)
    keep.sort(key=lambda l: (l["box"][1], l["box"][0]))
    return keep


# --------------------------------------------------------------------------- #
# Engine: Tesseract CLI
# --------------------------------------------------------------------------- #

WIN_TESSERACT = [
    r"C:\Program Files\Tesseract-OCR\tesseract.exe",
    r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
]
NIX_TESSERACT = [
    "/opt/homebrew/bin/tesseract",
    "/usr/local/bin/tesseract",
    "/usr/bin/tesseract",
]

# Confidence floor for tesseract words.  Choice letters sit next to the radio
# circle and often score badly, but they are exactly what the parsers key on,
# so they are never dropped.
MIN_CONF = 25.0
_KEEP_ALWAYS = re.compile(r"^[A-J]\)?$")


def find_tesseract(explicit: str | None = None) -> str:
    if explicit:
        if os.path.exists(explicit) or shutil.which(explicit):
            return explicit
        raise SystemExit(f"tesseract not found at {explicit!r}")
    found = shutil.which("tesseract")
    if found:
        return found
    for cand in (WIN_TESSERACT if os.name == "nt" else NIX_TESSERACT):
        if os.path.exists(cand):
            return cand
    raise SystemExit(
        "tesseract binary not found.  Install it (macOS: `brew install "
        "tesseract`; Windows: the UB-Mannheim installer) or pass "
        "--tesseract-bin <path>."
    )


def tesseract_ocr(path: str, binary: str, psm: int = 3, lang: str = "eng"):
    """(W, H, lines) from the tesseract CLI, in the same shape Vision returns.

    `tesseract <img> - --psm N tsv` writes a TSV of word boxes to stdout with
    block/paragraph/line numbers; those group the words into visual lines, so
    the tesseract path needs no equivalent of the Vision repair pass.
    """
    env = dict(os.environ)
    env.setdefault("OMP_THREAD_LIMIT", "1")  # we parallelise over pages instead
    proc = subprocess.run(
        [binary, path, "-", "--psm", str(psm), "-l", lang, "tsv"],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"tesseract failed on {path}: {proc.stderr.decode('utf-8', 'replace')[:400]}"
        )

    rows = list(csv.DictReader(
        io.StringIO(proc.stdout.decode("utf-8", "replace")),
        delimiter="\t", quoting=csv.QUOTE_NONE,
    ))

    W = H = 0
    grouped: dict[tuple, list] = {}
    order: list[tuple] = []
    for r in rows:
        try:
            level = int(r["level"])
        except (TypeError, ValueError):
            continue
        if level == 1:  # page box
            W, H = int(r["width"]), int(r["height"])
            continue
        if level != 5:
            continue
        text = (r["text"] or "").strip()
        if not text:
            continue
        conf = float(r["conf"])
        if conf < MIN_CONF and not _KEEP_ALWAYS.match(text):
            continue
        x0, y0 = float(r["left"]), float(r["top"])
        box = [round(x0, 1), round(y0, 1),
               round(x0 + float(r["width"]), 1), round(y0 + float(r["height"]), 1)]
        key = (int(r["block_num"]), int(r["par_num"]), int(r["line_num"]))
        if key not in grouped:
            grouped[key] = []
            order.append(key)
        grouped[key].append((text, box, conf))

    if not W or not H:
        from PIL import Image
        with Image.open(path) as im:
            W, H = im.size

    lines = []
    for key in order:
        words = grouped[key]
        lines.append({
            "text": " ".join(t for t, _b, _c in words),
            "box": [min(b[0] for _t, b, _c in words),
                    min(b[1] for _t, b, _c in words),
                    max(b[2] for _t, b, _c in words),
                    max(b[3] for _t, b, _c in words)],
            "conf": sum(c for _t, _b, c in words) / len(words) / 100.0,
            "words": [(t, b) for t, b, _c in words],
        })
    lines.sort(key=lambda l: (l["box"][1], l["box"][0]))
    return W, H, lines


def header_fallback(path: str, W: int, H: int, ocr_fn):
    """Re-OCR just the "Exam Section : Item N of 50" strip.

    Both parsers group an item's several scroll screenshots by that header, so
    a page that loses it is a page whose content gets orphaned.  Two things
    make whole-page OCR lose it: layout analysis occasionally swallows the
    strip, and some share PDFs were captured with the browser chrome in dark
    mode -- white text on a dark bar, which Tesseract does not binarise.  So
    OCR a 2x crop of the strip on its own, and if that fails, again inverted.

    Returns a line dict in image-pixel coordinates, or None.
    """
    from PIL import Image, ImageOps

    x0, y0 = 0, int(0.02 * H)
    x1, y1 = int(0.40 * W), int(0.12 * H)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    tmp.close()
    try:
        with Image.open(path) as im:
            base = im.crop((x0, y0, x1, y1)).convert("L")
        base = base.resize((base.width * 2, base.height * 2), Image.LANCZOS)
        for crop in (base, ImageOps.invert(base)):
            crop.save(tmp.name)
            _w, _h, lines = ocr_fn(tmp.name)
            for line in lines:
                if not HEADER_RE.search(line["text"]):
                    continue
                words = [(t, [round(b[0] / 2 + x0, 1), round(b[1] / 2 + y0, 1),
                              round(b[2] / 2 + x0, 1), round(b[3] / 2 + y0, 1)])
                         for t, b in line["words"] if b is not None]
                if not words:
                    continue
                return {
                    "text": line["text"],
                    "box": [min(b[0] for _t, b in words),
                            min(b[1] for _t, b in words),
                            max(b[2] for _t, b in words),
                            max(b[3] for _t, b in words)],
                    "conf": line["conf"],
                    "words": words,
                }
    finally:
        os.unlink(tmp.name)
    return None


# --------------------------------------------------------------------------- #
# Text-layer construction (shared by both engines)
# --------------------------------------------------------------------------- #

# Two share formats, two page headers: the NBME client prints
# "Exam Section : Item 7 of 50", the app the ObGyn forms come from prints
# "Question 7 Of 50 (03:41)". Either one names the item the page belongs to.
# The space can be lost by OCR ("Question 35Of Of 50"), so it is optional.
HEADER_RE = re.compile(r"(?:Item|Question)\s*(\d+)\s*[Oo]f\b")
LETTER = re.compile(r"^[A-J]\)$")
# The answer key prints a red X before a wrongly answered item's number; OCR
# reads it as one of these.
MARKERS = ("X", "x", "\u00d7", "%", "*", "\u2713", "\u221a", "'", '"')


def clean_line_tokens(line: dict, hdr: str | None, med_h: float,
                      top: float, bot: float, stats: dict):
    """Per-OCR-line cleanups.  Returns a token list, or None to drop the line."""
    lh = line["box"][3] - line["box"][1]
    if (top < line["box"][1] < bot and lh < 0.65 * med_h
            and len(line["text"].split()) >= 3):
        # A line the scroll screenshot sliced in half: unreadable, and it would
        # only add garbage between the real lines.
        stats["cutoff"] += 1
        return None

    toks = [(t, b) for t, b in line["words"] if b is not None]

    # "B" + ")" -> "B)"
    merged, i = [], 0
    while i < len(toks):
        t, b = toks[i]
        if re.fullmatch(r"[A-J]", t) and i + 1 < len(toks) and toks[i + 1][0] == ")":
            b2 = toks[i + 1][1]
            merged.append((t + ")", [b[0], min(b[1], b2[1]), b2[2], max(b[3], b2[3])]))
            i += 2
            continue
        merged.append((t, b))
        i += 1
    toks = merged

    # radio circle glued to the letter: "(A)" -> "A)"; stray punctuation
    # inside the token: "F.)" -> "F)"
    toks = [(re.sub(r"^[(\[]?([A-J])[.,;:'’]?\)$", r"\1)", t), b)
            for t, b in toks]

    # radio circle read as a letter and fused with the choice letter:
    # "BE)" -> "E)", "OA)" -> "A)".  Only near the start of a line that has no
    # clean choice token yet, and only a single junk character.
    if not any(LETTER.match(t) for t, _b in toks[:3]):
        for k in range(min(3, len(toks))):
            t, b = toks[k]
            m = re.fullmatch(r"[^A-Za-z0-9]?[A-Za-z]?([A-J])\)", t)
            if m and len(t) > 2:
                # keep the right edge; the dropped glyph sat on the left
                nb = [b[2] - (b[2] - b[0]) * 2.0 / len(t), b[1], b[2], b[3]]
                toks[k] = (m.group(1) + ")", nb)
                break

    # red X / check marker before an item number on answer pages
    if len(toks) >= 2 and toks[0][0] in MARKERS and re.fullmatch(r"\d{1,2}\.?", toks[1][0]):
        toks = toks[1:]

    # "31" at the start of the stem -> "31." (the parser's item-number anchor)
    if toks and hdr and toks[0][0] == hdr and len(toks) > 1:
        toks[0] = (hdr + ".", toks[0][1])

    # radio-circle artifacts ("*", "O", "J", "(") before a choice letter
    li = next((k for k, (t, _) in enumerate(toks) if LETTER.match(t)), None)
    if li is not None and li <= 2:
        stats["dropped"] += li
        toks = toks[li:]

    toks = [(t, b) for t, b in toks if re.search(r"[A-Za-z0-9]", t)]
    return toks or None


def build_layer(doc: fitz.Document, records: list[dict], out: str,
                fontname: str, fontfile: str | None) -> dict:
    """Write the invisible text layer onto `doc` and save it to `out`.

    records[i] = {"W","H","rect","lines"} for page i.
    """
    font = fitz.Font(fontfile=fontfile) if fontfile else fitz.Font(fontname)
    stats = {"pages": 0, "words": 0, "dropped": 0, "cutoff": 0, "unencodable": 0}

    for pno, page in enumerate(doc):
        rec = records[pno]
        W, H = rec["W"], rec["H"]
        R = rec["rect"]
        sx, sy = R.width / W, R.height / H
        pr = page.rect
        if fontfile:
            page.insert_font(fontname=fontname, fontfile=fontfile)

        # Ignore the chrome bands top and bottom when sizing lines.
        top, bot = 0.10 * H, 0.934 * H
        hs = [l["box"][3] - l["box"][1] for l in rec["lines"]
              if top < l["box"][1] < bot]
        med_h = statistics.median(hs) if hs else 0.023 * H

        # The "Item N of 50" header is the only thing tying an item's several
        # scroll screenshots together, so it must reach the text layer.
        hdr = None
        for l in rec["lines"]:
            m = HEADER_RE.search(l["text"])
            if m:
                hdr = m.group(1)
                break

        # -- pass 1: clean tokens per OCR line ------------------------------ #
        rows = []  # (tokens, y0, y1) in image pixels
        for line in rec["lines"]:
            toks = clean_line_tokens(line, hdr, med_h, top, bot, stats)
            if not toks:
                continue
            rows.append((toks, min(b[1] for _t, b in toks),
                         max(b[3] for _t, b in toks)))

        # -- pass 2: snap segments of one visual line to a single baseline --- #
        rows.sort(key=lambda r: (r[1] + r[2]) / 2)
        groups = []
        for r in rows:
            c = (r[1] + r[2]) / 2
            if groups and abs(c - groups[-1]["c"]) < 0.4 * med_h:
                g = groups[-1]
                g["rows"].append(r)
                g["c"] = sum((x[1] + x[2]) / 2 for x in g["rows"]) / len(g["rows"])
            else:
                groups.append({"c": c, "rows": [r]})

        # -- pass 3: emit invisible text ------------------------------------ #
        for g in groups:
            cy_pt = R.y0 + g["c"] * sy
            fss = []
            for toks, _ly0, _ly1 in g["rows"]:
                for t, b in toks:
                    tl = font.text_length(t, fontsize=1)
                    if tl > 0:
                        fss.append((b[2] - b[0]) * sx / tl)
            if not fss:
                continue
            fs_line = sorted(fss)[len(fss) // 2]
            # baseline from the line's vertical centre (Arial cap 0.716, desc 0.21)
            base_pt = cy_pt + (0.716 - 0.21) / 2 * fs_line
            for toks, _ly0, _ly1 in g["rows"]:
                for t, b in toks:
                    x_pt = R.x0 + b[0] * sx
                    tl = font.text_length(t, fontsize=1)
                    # Font size is fitted to each word's own OCR box width, so
                    # word heights vary; anything matching words to a line must
                    # use the baseline, not the box centre.
                    fs = (b[2] - b[0]) * sx / tl if tl > 0 else fs_line
                    fs = max(fs_line * 0.7, min(fs_line * 1.4, fs))
                    if base_pt < 0 or base_pt - fs > pr.height or x_pt > pr.width:
                        continue  # off-page (cropped chrome)
                    if any(not font.has_glyph(ord(c)) for c in t):
                        t = "".join(c if font.has_glyph(ord(c)) else "?" for c in t)
                        stats["unencodable"] += 1
                    page.insert_text((x_pt, base_pt), t + " ", fontsize=fs,
                                     fontname=fontname, fontfile=fontfile,
                                     render_mode=3)
                    stats["words"] += 1
        stats["pages"] += 1

    doc.save(out, garbage=3, deflate=True)
    doc.close()
    stats["cmap_patched"] = patch_tounicode(out)
    return stats


def patch_tounicode(path: str) -> int:
    """Map Arial's hyphen and space glyphs back to U+002D / U+0020.

    PyMuPDF writes ToUnicode entries of U+00AD (soft hyphen) and U+00A0
    (no-break space) for Arial.  pdf.js then draws invisible hyphens, and the
    NBSP word gaps defeat the literal spaces in both parsers' regexes -- which
    is what used to make "Item N of 50" unreadable.  A base-14 font such as
    "helv" gets no ToUnicode stream at all, so this is then a no-op.
    """
    doc = fitz.open(path)
    n = 0
    for xref in range(1, doc.xref_length()):
        tu = doc.xref_get_key(xref, "ToUnicode")
        if tu[0] != "xref":
            continue
        tx = int(tu[1].split()[0])
        cm = doc.xref_stream(tx)
        if cm and re.search(rb"<00[aA][dD]>|<00[aA]0>", cm):
            cm2 = re.sub(rb"(<[0-9a-fA-F]{4}> )<00[aA][dD]>", rb"\1<002d>", cm)
            cm2 = re.sub(rb"(<[0-9a-fA-F]{4}> )<00[aA]0>", rb"\1<0020>", cm2)
            doc.update_stream(tx, cm2)
            n += 1
    doc.save(path + ".tmp", garbage=1, deflate=True)
    doc.close()
    os.replace(path + ".tmp", path)
    return n


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #

def check(path: str, pages: int = 5) -> bool:
    """Report how much real text the PDF already has.  True = needs OCR."""
    doc = fitz.open(path)
    n = min(pages, len(doc))
    counts = [len(doc[i].get_text().strip()) for i in range(n)]
    doc.close()
    worst = max(counts) if counts else 0
    print(f"{os.path.basename(path)}: chars of text on the first {n} "
          f"pages = {counts}")
    if worst < 200:
        print("  -> image-only: needs an OCR text layer (run this tool on it).")
        return True
    print("  -> already has a text layer: feed it to the simulator as is.")
    return False


def default_output(inp: str) -> str:
    root, ext = os.path.splitext(inp)
    return f"{root} (OCR){ext}"


def run(inp: str, out: str, engine: str, dpi: int, jobs: int,
        tesseract_bin: str | None, psm: int, lang: str, verbose: bool) -> dict:
    t0 = time.time()
    doc = fitz.open(inp)
    npages = len(doc)
    fontname, fontfile = pick_font()
    print(f"{os.path.basename(inp)}: {npages} pages, engine={engine}, "
          f"font={fontfile or fontname}")

    binary = find_tesseract(tesseract_bin) if engine == "tesseract" else None

    with tempfile.TemporaryDirectory(prefix="ocr_layer_") as tmp:
        t_ex = time.time()
        pages = []
        for pno in range(npages):
            pages.append(page_image(doc[pno], os.path.join(tmp, f"p{pno:04d}"),
                                    dpi, grayscale=(engine == "tesseract")))
        print(f"  extracted {npages} page images in {time.time() - t_ex:.1f}s "
              f"({pages[0][1]}x{pages[0][2]})")

        t_ocr = time.time()
        records: list[dict | None] = [None] * npages
        if engine == "vision":
            def page_ocr(path):
                W, H, lines = vision_ocr(path)
                return W, H, vision_repair(path, W, H, lines, verbose=verbose)
            hdr_fn = vision_ocr
        else:
            def page_ocr(path):
                return tesseract_ocr(path, binary, psm=psm, lang=lang)
            # psm 6 = "one uniform block": the header strip also catches the
            # URL bar above it, so a single-line mode is wrong here.
            def hdr_fn(path):
                return tesseract_ocr(path, binary, psm=6, lang=lang)

        def work(pno):
            path = pages[pno][0]
            W, H, lines = page_ocr(path)
            if not any(HEADER_RE.search(l["text"]) for l in lines):
                extra = header_fallback(path, W, H, hdr_fn)
                if extra is not None:
                    lines.append(extra)
                    lines.sort(key=lambda l: (l["box"][1], l["box"][0]))
            return pno, (W, H, lines)

        nworkers = 1 if engine == "vision" else jobs
        with concurrent.futures.ThreadPoolExecutor(max_workers=nworkers) as ex:
            done = 0
            for pno, (W, H, lines) in ex.map(work, range(npages)):
                records[pno] = {"W": W, "H": H, "rect": pages[pno][3],
                                "lines": lines}
                done += 1
                if done % 20 == 0 or done == npages:
                    print(f"  ocr {done}/{npages}", flush=True)
        t_ocr = time.time() - t_ocr

        nohdr = [i for i, r in enumerate(records)
                 if not any(HEADER_RE.search(l["text"]) for l in r["lines"])]
        if nohdr:
            print(f"  WARNING: no \"Item N of 50\"/\"Question N Of 50\" header on "
                  f"pages {nohdr} -- "
                  f"those pages cannot be stitched to an item")

        stats = build_layer(doc, records, out, fontname, fontfile)

    stats["ocr_seconds"] = round(t_ocr, 1)
    stats["total_seconds"] = round(time.time() - t0, 1)
    print(f"  {stats}")
    print(f"  wrote {out}")
    return stats


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        prog="ocr_pdf.py",
        description="Add an invisible OCR text layer to an image-only exam PDF.",
    )
    ap.add_argument("input", help="the image-only PDF")
    ap.add_argument("output", nargs="?",
                    help='output PDF (default: the input with a " (OCR)" suffix)')
    ap.add_argument("--engine", choices=("auto", "vision", "tesseract"),
                    default="auto",
                    help="auto = Apple Vision on macOS when pyobjc imports, "
                         "else tesseract")
    ap.add_argument("--dpi", type=int, default=200,
                    help="render dpi for pages with no single embedded image "
                         "(default 200)")
    ap.add_argument("--jobs", "-j", type=int, default=0,
                    help="parallel tesseract workers (default: CPU count)")
    ap.add_argument("--check", action="store_true",
                    help="only report whether the PDF needs OCR")
    ap.add_argument("--tesseract-bin", default=None,
                    help="path to the tesseract binary")
    ap.add_argument("--psm", type=int, default=3, help="tesseract page-seg mode")
    ap.add_argument("--lang", default="eng", help="tesseract language (default eng)")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    if not os.path.exists(args.input):
        ap.error(f"no such file: {args.input}")

    if args.check:
        check(args.input)
        return 0

    engine = args.engine
    if engine == "auto":
        engine = "vision" if vision_available() else "tesseract"
        print(f"engine auto -> {engine}")
    elif engine == "vision" and not vision_available():
        ap.error("Vision is unavailable here (macOS + pyobjc-framework-Vision "
                 "and pyobjc-framework-Quartz required)")

    out = args.output or default_output(args.input)
    if os.path.abspath(out) == os.path.abspath(args.input):
        ap.error("refusing to overwrite the input PDF")
    jobs = args.jobs or (os.cpu_count() or 4)

    run(args.input, out, engine, args.dpi, jobs, args.tesseract_bin,
        args.psm, args.lang, args.verbose)
    return 0


if __name__ == "__main__":
    sys.exit(main())
