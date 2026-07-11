# ADR 0013 — Display bands: x-ordered cells, per-cluster span extraction, dominant-height emission

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

After ADR 0012 the Discovery report's 3–4-column pages read stream-by-stream,
but its p6 heading band was still garbage: a 34pt two-line section heading, an
8pt KEY legend, and 17pt R/S commitment letters all share baselines, and the
reconstruction had four independent failures there — each of which turned out
to be corpus-wide, not page-local:

1. **Arrival-order cells.** `linesFromGlyphs` built cells single-pass in
   y-then-x glyph order. Same-line glyphs whose baselines differ slightly
   (display type beside small type, superscripts, subscripts) arrive out of x
   order and spliced mid-line: `"SignatoryR"`, `"Sclimate change"` — and, all
   over the corpus, broken subscripts (`"CO -equivalent2"`, `"Nb Sn…3"`,
   `"H = … o"`) and out-of-order table rows (`"$ (xx,xxx) $ (xx,xxx)Net loss"`).
2. **Whole-row span treatment.** In `columnRegions`, ANY box touching the
   gutter made its whole row a full-width region. A hanging panel header
   outdented 11pt across its own gutter ("RELATED COMMITMENTS INCLUDE:")
   dragged a body-column line into one glued line; consecutive full-width
   rows (an intro paragraph) each became their own region, putting a
   paragraph break after every line.
3. **Max-height emission.** Heading detection keyed on `line.h` — the MAX
   glyph height — so two 17pt letters riding a 55-char entry emitted the
   whole entry as `# The UNEP FI Principles… R S`, and a lone letters row
   emitted as `# R S`.
4. **Interleaved display bands.** Even correctly ordered, the heading band
   emitted as `"Our position on KEY:"` / `"climate change R Reporting S
   Signatory"` — the headline spliced line-by-line into the side panel. No
   y-based grouping can separate them: the streams genuinely share baselines.

## Decision

The governing principle: **the converted document's consumer is an LLM, not
an eye**. An LLM builds meaning from token order alone, so positional
fidelity is worthless and stream integrity is everything — a margin label
spliced mid-sentence silently corrupts the claim it lands in (worse than an
omission, because nothing marks it), and a row binding (entry↔letters,
label↔value) that survives on paper by proximity dies in linearization
unless the tokens end up adjacent.

Six mechanisms, each guarded by the 6-doc corpus diff:

- **Two-phase line building** (`linesFromGlyphs`): assign glyphs to lines with
  the existing y-clustering, then sort each line's glyphs by x before forming
  cells. Word spacing is judged at the scale of the SMALLER adjacent glyph,
  not the line max, so display glyphs don't stretch the space threshold over
  small-type word gaps. Each cell records `domH` — its char-weighted dominant
  glyph height.
- **Per-cluster span extraction** (`columnRegions`): a row's boxes chain into
  horizontal clusters at the cell-splitting gap (COLUMN_GAP); only a cluster
  that crosses the gutter by half a median height on each side becomes
  full-width. Non-crossing clusters stay in their column streams — unless
  they read as tabular fragments (`isTabularCell`), which ride along as the
  crossing line's row data (a balance-sheet amount beside its long label;
  wrongly carrying a fragment glues one token, wrongly stranding it divorces
  a table column). Consecutive spanning rows accumulate into ONE region.
- **Dominant-height emission**: `modeHeight` votes per cell on `domH`, and
  heading detection compares the cell's `domH` — not the line max — to body
  height. A line of nothing but 1–2-char tokens (`R S`) is never a heading.
- **Display-band extraction** (`extractDisplayBands`, emission-time): a run of
  consecutive lines each holding a display-height heading cell AND body-height
  side cells is rewritten as the display cells (line by line, so the existing
  heading merge joins them) followed by the body cells. Gated on the band's
  first display cell starting with a capital/digit/quote: pages whose
  body-height mode collapses (2pt font metrics) make ordinary annotations
  clear the ratio, and a mid-clause lowercase fragment must not become a
  heading.
- **Symbol-rail re-attachment** (`mergeSymbolRails`, leaf prose regions): a
  symbol-only line whose baseline sits within the previous line's vertical
  band, starting past its right edge, is the same visual row — letters whose
  baseline offset pushed them past the line-grouping tolerance. Re-attached
  as trailing cells so the entry keeps its letters inline
  ("UN Global Compact R S"), preserving the row binding through
  linearization.
- **Marginalia extraction** (`extractMarginalia`, leaf prose regions): a
  prose line whose FIRST cell sits on the region's dominant start band while
  a short alphabetic LAST cell sits on a band almost nobody shares is a
  sentence with a margin label spliced in ("…emphasising real-world
  Maintaining"). The label is lifted out and appended after the region as its
  own block. Deliberately conservative: only 2-cell lines whose first cell is
  genuine running prose (≥30 chars), only in regions that are otherwise
  single-stream (≤25% multi-cell lines), at most 3 lines — a table header's
  fourth column (private-novel's "HOT HOUSE" scenario) and paired legend
  tokens ("ST MT") have the same weak-band fingerprint and must not be
  stripped.

## Alternatives rejected

- **Min-height same-line tolerance** (join lines at `min(h)` instead of
  `last.h * 0.5`): kills the heading vacuum but breaks subscripts into their
  own lines (`tCO₂e` → `tCO e` + `2`) and churned 500+ corpus lines.
- **Per-BOX span extraction** (no clustering): sliced single text lines whose
  glyph runs merely touch the gutter (`### Documents due by` /
  `### February 15…`) and shattered balance-sheet rows.
- **Flat 2×median span margin**: fixed the hanging header but broke the ToC —
  its "Page" column header crosses the gutter by 8pt and must stay full-width
  so the title/number columns pair via row correspondence.

## Consequences

- table-heavy p6 reads within a hair of the hand-fixed reference: heading
  recovered (`# Our position on climate change`), KEY legend separated,
  commitments entries keep their R/S letters, all three glue lines resolved.
- Corpus-wide: subscripts/superscripts assemble correctly, wrapped headings
  join into single heading blocks, fake symbol headings (`# R S`, `# UU`,
  `# 97`) demoted, section headings rescued from glue lines (`METRICS AND
  TARGETS`, `Income Statement`).
- Flattened-figure routing unchanged on 5 of 6 docs; on the messy scan two
  borderline pages (conv 0.4–0.5) trade places across the threshold — soup
  pages either way.
- Residuals on p6: col B's tail paragraph resumes after the panel block
  instead of before it (blank-line-delimited, so an LLM can re-stitch; the
  disambiguating geometry is not locally present — a floating first line
  with the identical shallow-crossing signature needs the opposite
  treatment), and a stray `*` footnote-anchor line (1 char of noise; the
  footnote's own text carries the association).
