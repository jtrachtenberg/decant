# ADR 0021 — Repeated-fill census: page furniture must not read as a vector chart

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

ADR 0009 gave flattened vector charts a detector: a page whose paint shows
many chromatic fills spread over several hue buckets is a symbol chart whose
data never reaches the text layer, so it joins the figures flow. The gate
(`hasVectorChartFills`) is 12+ colored fills across 3+ hue buckets with 2+
fills each, calibrated on a 7-document corpus whose note records that "no
non-chart page reached 3 buckets with ≥2 fills each".

An 88-page WHO statistics report breaks that assumption outright. Its page
template paints a chromatic element — 15 fills across 5 hue buckets — on
nearly every page. That clears the gate on decoration alone, with no chart
present and no raster on the page at all:

```
pageCount             88
flattenedPageNumbers  81      ← 81 of 88 pages flagged
totalImages           19
```

The damage is not the flag itself but what it does to the cap. All 81 land in
the same rank tier of `selectChartPages`, whose stable sort fills each tier
front-first, so the 20-page budget is spent on whatever comes first in the
document: the cover, then the roman-numeral front matter, then pages 1–15.
The real charts — pages 28, 33 and 43 in the same document's known-good
output from before ADR 0009 landed — never got considered. The attachment
went from a faithful copy of the document's figures to a copy of its table of
contents.

The existing repeated-IMAGE census (ADR 0015, `repeatedImageDims`) already
demotes exactly this class of decoration for raster. Vector fills had no
equivalent.

## Decision

Census colored-fill geometry across the document, the same shape as the
raster census, and discount furniture before applying the gate.

- **`fillSignature(hue, box)`** — a fill's identity: hue bucket plus its
  user-space box rounded to the point. Furniture paints the same shapes at
  the same coordinates on every page; chart data never lands identically
  twice, because bars, symbols and heat cells move with their values.
- **The census** is built in `analyzePdf`'s existing first pass, beside
  `dimsPages`, and consumed by every page's judgment in the second — so it is
  complete before any page is judged, exactly like the raster census.
- **`REPEATED_FILL_MIN_PAGES = 3`**, deliberately a page less eager than the
  raster census's 2. An exact intrinsic-dims image repeat is decoration
  essentially always; a fill signature can repeat innocently, since a
  two-page figure's legend swatches sit at identical coordinates on both.
  Three still catches furniture, which repeats document-wide rather than
  twice.
- **`hasVectorChartFills(scan, repeatedFills)`** subtracts only fills it can
  positively identify. A bare fill verb paints without geometry (see
  `scanPageOps`), so unboxed fills stay counted rather than be guessed at,
  which makes the censused gate strictly more conservative than none.

The gate's own arithmetic now goes through `huesQualify`, already used for
per-cluster checks in `vectorChartBox`, so the page and its crop cannot
disagree about what qualifies.

## Consequences

On the WHO report, flagged pages fall 81 → 17 and the attachment changes from
the cover plus front matter to charts spread across the whole document —
pages 28, 33 and 43 among them, restoring the pre-ADR-0009 selection.

Re-checked across the full validation corpus, every other document's
selection is **byte-identical**: chart-heavy, clean-text, messy-scan,
private-novel, public-famous and table-heavy all attach exactly the pages
they did before. The census is inert on documents without repeating
chromatic furniture, which is the intended blast radius.

**Residual.** The cover page still attaches: it carries 50 fills across 3
hues, clears the gate, and — being a one-off — has no repeating signature for
the census to catch. Demoting it would need a cover heuristic, and page 1 can
legitimately hold a chart, so it is left alone. One decorative page inside a
20-page budget is a far smaller cost than the six it used to spend.

**Not done.** `selectChartPages` still fills each rank tier front-first, so a
future false-positive class near the front of a document could starve real
figures the same way. Ranking the cap by figure value instead would harden
that, but with the false positives gone no corpus document is starved today,
and the change would alter chart-heavy's currently-correct selection for no
measured gain. Left for when a document demonstrates the need.
