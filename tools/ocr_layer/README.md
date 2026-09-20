# OCR text layer for image-only (flat screenshot) exam PDFs

Some self-assessment share PDFs are **one screenshot per page with no text
layer** — the only text in the whole file is a ~25 character `t.me` watermark.
The parsers look for `Item N of 50`, the `A)` choice tokens and
`Correct Answer: X` in the PDF text, so on those files they find nothing: no
items, no choices, no key.

`ocr_pdf.py` OCRs each page and writes the words back as **invisible text**
(`render_mode 3`) positioned over the pixels they came from. The output is an
ordinary PDF that the unmodified parsers — and the browser's own text
selection and highlighting — read normally.

## When you need this

- **You probably don't.** The web app at
  <https://rabbanihaziq.github.io/exam-simulator/> now OCRs image-only PDFs in
  the browser, automatically. Just drop the raw PDFs in.
- **Use this tool** for the offline paths: the Windows exe, the local Flask
  app, `app/parsing/parser.py` in a script — or if the in-browser OCR fails or
  is too slow on your machine and you would rather pre-bake the text layer
  once and reuse the OCR'd PDFs.

## Check first

Only image-only PDFs need this.

```
python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Questions.pdf" --check
```

It prints the characters of text on the first few pages. A few dozen (the
watermark) means image-only. A few thousand means the file already has a text
layer — feed it to the simulator as is.

## Install

**macOS**

```bash
./.venv/bin/pip install -r tools/ocr_layer/requirements.txt
```

That pulls in `pyobjc-framework-Vision`, so `--engine auto` uses Apple Vision,
which needs nothing else installed. For the tesseract engine as well:
`brew install tesseract`.

**Windows**

1. Install Tesseract: the UB-Mannheim build,
   <https://github.com/UB-Mannheim/tesseract/wiki>. Accept the default path
   `C:\Program Files\Tesseract-OCR\` and keep the English language data — the
   tool looks there, and on `PATH`, by itself. Anywhere else, pass
   `--tesseract-bin "D:\path\to\tesseract.exe"`.
2. `pip install -r tools\ocr_layer\requirements.txt` (the pyobjc lines are
   skipped automatically off macOS).

## Run

```bash
# questions and answers, one at a time; default output adds " (OCR)"
python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Questions.pdf"
python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Answers.pdf"
#   -> "Surgery 7 - Questions (OCR).pdf", "Surgery 7 - Answers (OCR).pdf"

# explicit output, tesseract, 8 pages at a time
python tools/ocr_layer/ocr_pdf.py in.pdf out.pdf --engine tesseract --jobs 8
```

| option | what it does |
| --- | --- |
| `--engine auto\|vision\|tesseract` | `auto` = Apple Vision when pyobjc imports on macOS, else tesseract |
| `--jobs N` | parallel tesseract workers (default: CPU count). Vision runs one page at a time |
| `--dpi N` | render dpi for a page with no single embedded image (default 200). Pages that *are* one screenshot are OCR'd at the screenshot's own resolution, 2666x1499 in these files |
| `--check` | report whether the PDF needs OCR, then exit |
| `--tesseract-bin PATH` | where the tesseract binary is |
| `--psm N`, `--lang` | passed to tesseract (default `3`, `eng`) |

Then feed both OCR'd PDFs to the app, or check them directly:

```python
from app.parsing.parser import ExamParser
items = ExamParser(q_ocr_pdf, a_ocr_pdf).parse()
print(len(items), [it.item for it in items if not it.answer_available])
print(" ".join(f"{it.item}{it.correct}" for it in items))
```

Measured on a 14-core Apple-silicon Mac. Form 7 (50 question pages,
106 answer pages): tesseract `--jobs 8` 12s + 90s, Vision 22s + 128s. Form 8
(53 + 103 pages): tesseract `--jobs 8` 13s + 67s. All three parsed to 50
items with all 50 keyed, the same answer key and the same per-item choice
letters as the hand-built Vision files they were checked against.

## How it works

1. Pull each page's embedded screenshot out at its native resolution (or
   render the page at `--dpi` if the page is not a single image).
2. OCR it: Apple Vision, or `tesseract <img> - --psm 3 tsv`, whose TSV gives
   word boxes, confidences and block/paragraph/line numbers. Both engines are
   normalised to the same per-line shape
   `{text, box, conf, words: [(text, box)]}`, so everything downstream is
   shared.
3. Clean up the tokens (below), snap each visual line to one baseline, fit
   each word's font size to its OCR box width, and draw it invisibly.
4. Patch the ToUnicode CMap and save.

## Gotchas this tool handles (do not remove them)

- **`Item N of 50` must reach the text layer.** It is the only thing tying an
  item's several scroll screenshots together — both `app/parsing/parser.py`
  and `docs/parser.js` group pages by it. If a page's whole-page OCR misses
  the header, the tool re-OCRs just that strip on its own and warns if it
  still cannot find it.
- **Dark chrome.** Some share PDFs were captured with the browser chrome in
  dark mode — white header text on a dark bar — and whole-page OCR loses the
  header on every one of those pages (35 of the 106 pages of Form 7's answer
  key). Re-OCR'ing the strip on its own recovers them; if that still fails,
  the tool tries once more with the crop inverted.
- **Grayscale before Tesseract.** On the *colour* screenshots Tesseract
  silently drops whole regions — a yellow highlighted choice row, the blue
  `Correct Answer: X` line. Converting the page to plain luminance first
  recovered 147 -> 241 words on one Form 7 answer page. Vision reads the
  colour original fine.
- **`A` + `)` merged** into `A)`, and `(A)` rewritten to `A)`.
- **Radio-circle artifacts.** The empty radio circle OCRs as a token
  (`•`, `O`, `J`, `(`, `©`) before the choice letter; up to two such leading
  tokens are dropped. It also fuses into the letter (`BE)` -> `E)`) and picks
  up stray punctuation (`F.)` -> `F)`).
- **The red X wrong-answer marker** printed before an item number on answer
  pages is dropped, and `31` at the start of a stem becomes `31.`, which is
  what the parser's item-number anchor matches.
- **Clipped lines are dropped.** A scroll screenshot slices the first or last
  line in half; OCR of the surviving half is garbage, so lines shorter than
  0.65 of the page's median line height are left out.
- **Width-fitted font sizes.** Each word's size comes from its own OCR box
  width, so word boxes have inconsistent heights. Anything matching words to
  a line must use the **baseline**, not the box centre.
- **Invisible text** is `render_mode=3`, so the original pixels are all you
  see.
- **The ToUnicode patch.** PyMuPDF maps Arial's hyphen glyph to U+00AD (soft
  hyphen) and its space glyph to U+00A0 (no-break space). pdf.js then draws
  invisible hyphens, and the NBSP word gaps defeat the literal spaces in both
  parsers' regexes — this is what used to make `Item N of 50` unreadable. The
  tool maps them back to U+002D and U+0020 in the saved file.
- **Vision's mis-segmentation repair.** Vision merges adjacent stem lines into
  one garbage box; low-confidence or double-height boxes are re-OCR'd from a
  2x crop and deduplicated against the lines already trusted. Tesseract is
  line based and does not need this; instead it drops words below confidence
  25, except choice-letter tokens, which sit next to the radio circle and
  often score badly.
- **Fonts.** macOS uses `/System/Library/Fonts/Supplemental/Arial.ttf`.
  Elsewhere the tool falls back to PyMuPDF's built-in `helv`, a base-14 font
  that gets no ToUnicode stream at all — so the patch above finds nothing to
  patch and is simply unnecessary there; the text already extracts with plain
  U+002D and U+0020.
