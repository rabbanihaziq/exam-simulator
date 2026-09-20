# Self-Assessment Exam Simulator

Turns a self-assessment **questions PDF** and its **answer-key PDF** into a
faithful, exam-style testing interface — take the exam blind, then review your
answers against the key with a % score.

It works with any self-assessment exported in the standard page-per-item
layout; nothing is hard-coded to a single form. You supply your own PDFs.

## Use it in your browser (easiest)

**<https://rabbanihaziq.github.io/exam-simulator/>**

Everything runs client-side: the PDFs are parsed by your browser on your own
computer and are never uploaded anywhere. Works on Windows, macOS, anything
with a modern browser (Chrome recommended).

## What it does

- **Looks like the real thing** — the actual page images are shown, so every
  clinical photo, ultrasound, tracing, graph, and lab table appears exactly as
  exported. The header/footer chrome is rebuilt as live, working controls.
- **Take the exam** — click through items, select answers (click a choice, or
  press `A`–`J` / `1`–`9`), a live countdown timer, **Mark** items for review.
- **Highlight like a browser** — select text with your mouse to lay down
  yellow highlights; click a highlight to remove it, or clear the item from
  **Settings**. Click the "ab" glyph beside a choice (or right-click it) to
  strike it out.
- **Lab Values** — a reference panel docked beside the question (Serum,
  Cerebrospinal, Blood, Urine and BMI) with search and an SI-units toggle,
  laid out like the real exam client.
- **Calculator**, **Notes**, and a **Question Status** sidebar (answered /
  marked / no-key) that mirrors the real NBME layout.
- **Submit → review** — **End Block** scores you against the answer key and
  shows each item's answer-key page (correct answer + full explanation) with a
  *Your answer vs Correct* banner and a **% correct**.
- Progress is saved in the browser per exam file, so a refresh — or coming
  back later and re-selecting the same PDF — resumes where you left off.
- **Export results** — after scoring, the review bar has an **Export results**
  button: a Markdown table of every item (your answer, the key, right/wrong/
  skipped, marked) plus each question's text and choices, and optionally the
  answer-key explanation for every item. **Copy** it straight into an AI chat
  ("here are my misses, find the pattern"), or download it as `.md` / `.json`.
  Nothing leaves your browser until you paste or download.

## Notes

- If the answer-key PDF is missing an item (some exports are), that item is
  clearly flagged, shown as "not in answer key," and left out of the score
  denominator so your percentage stays honest.
- Correct answers are matched to questions by item number with a text
  similarity cross-check, so an occasional glitch in a page header won't
  mis-score you.

## Image-only (flat screenshot) PDFs

Some share PDFs are one screenshot per page with no text layer at all, so
there is nothing for a parser to read — no item headers, no choices, no key.

- **In the browser**, this is handled for you: the web app recognises an
  image-only PDF and OCRs it on the spot. Just drop the raw files in.
- **Offline** (the Windows app, the Flask app, `app/parsing/parser.py`), run
  the PDFs through `tools/ocr_layer/ocr_pdf.py` first. It writes an invisible
  text layer over the screenshots, and the rest of the pipeline then works
  unchanged:

  ```bash
  python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Questions.pdf"   # -> "... (OCR).pdf"
  python tools/ocr_layer/ocr_pdf.py "Surgery 7 - Answers.pdf"
  ```

  `--check` tells you whether a given PDF needs it at all. See
  [tools/ocr_layer/README.md](tools/ocr_layer/README.md) for install steps
  (Apple Vision on macOS, Tesseract on Windows) and the full option list.

## Offline / local versions

- **Windows**: download the prebuilt app from
  [Releases](../../releases/latest) — no install needed.
- **macOS / local dev**: run the Flask version:

  ```bash
  python3 -m venv .venv
  ./.venv/bin/pip install -r app/requirements.txt
  ./.venv/bin/python app/app.py
  ```

  Then open <http://127.0.0.1:5000> (it opens automatically).

## How it's built

- `docs/` — the static web app (GitHub Pages). `docs/parser.js` parses the
  PDFs entirely in the browser with PDF.js: pages render to a canvas, the
  chrome bars and answer radio circles are located by pixel analysis, word
  positions feed a native-selection text layer, and answers are fuzzy-matched
  to questions by stem similarity.
- `app/parsing/parser.py` — the original Python parser (PyMuPDF), same
  algorithm; the reference implementation.
- `app/app.py` — small Flask server for local use: upload, parse, serve page
  images + a JSON exam model.
- `.github/workflows/build-windows.yml` — builds the Windows exe on every
  push and publishes it to the "latest" release.
