# ADR 0006 — Extract-and-reference: figures as sibling attachments, PDFs as a mini-PDF

- **Status:** Accepted
- **Date:** 2026-07-06

## Context

Converting a text-plus-figures document to Markdown drops the figures — the
core "never silently degrade" tension (ARCHITECTURE §5 strategy 1 planned
attaching real figures next to the `.md`). Three constraints shaped the
implementation: chat surfaces cap image attachments per message (claude.ai
~5); PDF charts are usually vector drawings with **no embedded image to
extract**; and a figure the model can't tie back to its place in the text is
nearly worthless (the association must survive platform re-rendering).

## Decision

A **"Convert + attach figures"** choice on the ambiguous prompt:

- **Zip formats (PPTX/DOCX):** media entries extract directly (free via
  JSZip), junk-filtered by size, capped; overflow past the site's image limit
  combines into one **labeled contact-sheet PNG** (captions drawn into the
  pixels).
- **PDFs:** rebuild the upload as a **chart-pages-only mini-PDF** — one
  *document* attachment, exempt from image caps, platform-rendered at full
  fidelity. Pages crop to the figure region when the operator-list geometry
  allows (image-paint transforms give bounding boxes); otherwise whole-page
  vector copies. Fallbacks: crops → whole pages → PNG renders; the upload is
  never blocked.
- **Anchoring, triple-redundant:** omission markers in the text carry page
  references, every mini-PDF page is stamped "document page N" in its content,
  and the `.md` ends with a footer mapping attachment pages to document pages.
  All three speak the document's **printed page labels** (PDF label table via
  `getPageLabels()`) — physical index 17 of the WHO report is printed "7", and
  the document's own TOC and cross-references use "7".
- **Honest accounting:** reattached pages are netted out of the token-savings
  estimate at full per-page cost (under-promising, since crops cost less).

## Consequences

An 88-page report with 11 chart pages becomes cheap Markdown plus an 11-page
visual appendix, and the model can resolve "the figure on page 7" to the right
attachment page. Costs: pdf-lib joins the bundle; the mini-PDF's pages still
carry platform image cost (by design — those are the figures worth paying
for). Still open: figure *descriptions* (companion VLM), standalone raster
XObject extraction, and confidence-gating corrupt chart-region tables.
