# Parser harness

Runs `docs/parser.js` in headless Chrome against real PDFs and dumps everything
needed to diff a parser change and to look at what it actually produced.

## Run

```sh
cd "<repo>"
npm install --prefix tests/harness          # once: puppeteer-core
node tests/harness/run.mjs "<questions.pdf>" "<answers.pdf>" <outdir>
```

`HARNESS_PORT=8766` picks another port (default 8765) so two runs can overlap.
`HARNESS_PROFILE=<dir>` reuses a Chrome profile instead of a throwaway one, so a
second run of an image-only PDF is served from the parser's IndexedDB OCR cache
(that is how the cold/warm OCR numbers below were measured).
Chrome is expected at `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.

## What it does

1. Serves the repo on `127.0.0.1:8765`. pdf.js is an ES module, so it cannot be
   loaded from `file://`.
2. Serves a synthesised test page at `/docs/__harness.html` — nothing is written
   into `docs/`. The page boots pdf.js and `parser.js` exactly the way
   `docs/index.html` does, and carries a minimal copy of `exam.js`'s
   `renderQuestionHtml` (stem paragraphs, inline figures, choices) plus the
   matching rules from `exam.css`.
3. Fetches both PDFs and calls
   `window.parseExam(qBytes, aBytes, onProgress, { keepPageImages: true })`.
   `keepPageImages` makes the parser keep the cropped page render even for items
   that parsed as text, so the preview can show both sides.

## Output

| file | contents |
|---|---|
| `items.json` | per item: `item`, `correct`, `answer_available`, `q_pages`, `a_pages`, `mode` (`text`/`image`), stem paragraphs, choice texts, the answer-key explanation size (`answer_info`), and for every figure block `y`, `x0f`, `wf`, `fr` and the pixel rect `px` = `[x0,y0,x1,y1]`; plus the document-level `ocr` stats (pages, cache hits, header-strip fallbacks) when the parser had to OCR |
| `item<N>_fig<k>.png` | every figure crop the parser produced |
| `item<N>.png` | side-by-side preview at 900 px per pane: left = the original content-area page render, right = the text-mode HTML render |
| `summary.txt` | item/keyed/text-mode/figure counts, wall-clock parse time, a one-line-per-item table, and anything the page logged to the console |
| `progress.txt` | every `onProgress(label, frac)` the parse emitted |

## Selection test

```sh
node tests/harness/select.mjs "<questions.pdf>" "<answers.pdf>" 6,8,14
```

Loads the real exam page (`docs/index.html`), parses the PDFs, boots the exam
and clicks — with Chrome's own mouse — the centre of every listed item's
choice radios in turn, asserting the exam recorded the letter that was
clicked. Each item is driven twice, once through the reflowed text choices and
once through the positioned overlay rows (the image-mode path, forced by
clearing `content`). It also checks that every `row` rect has positive area,
that no row contains another choice's radio centre, and that rows sharing a
column don't overlap. Exits non-zero on any failure. This is the regression
test for two-column choice grids.

## Diffing a change

Keep a baseline directory, rerun into a second directory, then compare
`items.json` (item numbers, keys, `answer_available` must not move) and open the
previews for the items whose stem, choices or figure set changed.

## Reference timings

MacBook, Chrome headless, 4 OCR workers.

| input | pages (Q/A) | parse |
|---|---|---|
| Surgery 6 — real text layer | 50 / 50 | 6.0 s |
| Surgery 7 — Vision-OCR'd layer | 50 / 106 | 3.7 s |
| Surgery 8 — Vision-OCR'd layer, 3 stitched items | 53 / 103 | 4.1 s |
| Surgery 7 raw — in-browser OCR, cold | 50 / 106 | 122.4 s |
| Surgery 7 raw — OCR from the IndexedDB cache | 50 / 106 | 2.4 s |
| Surgery 8 raw — in-browser OCR, cold | 53 / 103 | 130.9 s |
| Surgery 8 raw — OCR from the IndexedDB cache | 53 / 103 | 2.9 s |

All seven runs produce 50 items, 50 keyed, 50 in text mode, and an
answer-key explanation for every item.

Image-only PDFs are recognised in the browser with tesseract.js, which
dominates the wall clock (about 0.8 s per page across four workers). The parser
caches the recognised words per page in IndexedDB keyed on the file's SHA-256,
so a second run of the same files costs no more than a text PDF. A fresh
profile — the default — is always a cold run.
