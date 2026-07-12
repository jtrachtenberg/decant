# ADR 0015 — Cross-page repeated images and text-backed panels are not figures

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

The Discovery climate report (the `table-heavy` decantCC corpus doc) attached
18 figure pages, and graded QA judged 7 of them pure decoration — pages whose
only "figures" were design furniture with all information already on the text
layer:

1. **Reused background-art sets.** The document decorates its section pages
   from four image sets (a 3×1243 gradient strip on 15 pages; four-image
   composition sets on 8, 6 and 2 pages). Each placement passed every
   significance gate — figure-sized, page-claiming, real pixels, ≤ 2 bleed
   edges, under the 85 % whole-page text-over threshold — so the contents/nav
   page, two section pages and two body pages attached for their wallpaper.
   The decode gate already knew better: ADR 0007's G3 treats cross-page
   repetition (pdf.js's `g_` global-cache ids, a dims fingerprint) as
   letterhead territory. Classification never got that signal.

2. **Text-backed panel textures.** Design tools back callout boxes and card
   columns with subtle texture/gradient *images*; the panel text is real text
   printed over them. Each panel holds 10–20 % of the page's text — nowhere
   near the ADR 0009 whole-page 85 % fraction — so five pages attached for
   what were literally paragraphs' backgrounds, and on two more pages a panel
   inflated the crop union until the crop fell back to a whole-page copy
   (a left-margin photo page shipped as the full page with all its text).

A second graded round on the same document added three more misses: a
transparency-flattener wave-art region painted as 249 overlapping raster
slabs (no size/bleed/text gate can see through the merged union); a purely
textual committee org-chart attached by the Tier 2 convergence flag alone
(0.48 — every word already in the Markdown); and the two vector-symbol-chart
pages cropping to full page width, which on this landscape slide layout
means the prose column and nav rail ride along (on one page the width pushed
the crop past the whole-page fallback entirely).

All signals are operator-list + text-layer visible; no rendering needed.

## Decision

1. **Demote cross-page repeated images from significance**
   (`isRepeatedImage`, raster-gate.js), per XObject, *before* component
   merging (a decoration tile must not glue its footprint onto a real figure
   it abuts). Two forms, either sufficient:
   - a `g_`-prefixed objId — pdf.js's own global image cache, which promotes
     an object it sees referenced from ≥ 2 pages;
   - an intrinsic-dims fingerprint (`WxH`) that a document-level census saw
     on ≥ 2 scanned pages (`REPEATED_DIMS_MIN_PAGES`). The census is built in
     analyzePdf's furniture pass (sampled like every image scan), rides the
     summary as `repeatedImageDims`, and is passed back into every figure
     path (crop framing, box export, decode gating) so they demote exactly
     what classification demoted. The census catches the *first* page a
     reused image paints on, where its id is still page-local; `g_` catches
     later pages even outside a sampled census.

2. **Demote text-backed panels by text density** (`isBackgroundImage`,
   raster-gate.js): an image box holding ≥ 250 text-layer chars
   (`BACKGROUND_TEXT_DENSITY_MIN_CHARS`) at ≥ 0.5× the page's own per-area
   char density (`BACKGROUND_TEXT_DENSITY_RATIO`) is a backdrop the text is
   printed over. A real raster figure is text-free inside (its labels are
   pixels) save for a caption. Six-doc corpus calibration: text-backed
   panels scored 0.54–2.1×, every genuine photo/chart/scan ≤ 0.39× (worst:
   a scanned-table region at 0.39, a photo at 0.17). The *char floor*, not
   the ratio, carries the safety margin — the CERN chart pages whose own
   annotations read at 1.2–1.4× density hold only 130–160 chars and never
   reach it. This demotion removes figures (the costly direction), so both
   knobs err toward keeping.

3. **Demote flattening debris by paint overlap**
   (`DEBRIS_OVERLAP_RATIO`, raster-gate.js): a multi-member component whose
   member-area sum re-covers its own box ≥ 4× is transparency-flattener
   output (one Discovery page painted 249 overlapping slabs of wave art —
   53×), never a placed figure. Every legitimate multi-paint composition
   *partitions* its footprint: ADR 0010 art tiles, strip-sliced photos and
   double-paints all measured ≤ 1.71× across the corpus — more than 2×
   margin on both sides of the threshold.

4. **Honor the convergence flag only with visual evidence**
   (`flattenedWithEvidence`, classify.js): a convergence-flagged page joins
   the figures flow only when the page paints ≥ 1 raster image or shows the
   vector-chart fill signal. Low convergence alone can be an ornate but
   purely textual layout (a committee org-chart of boxes at scattered x
   positions scored 0.48) whose every word is already in the Markdown.
   Calibration intact: both WHO/CERN flagged chart pages carry evidence
   (5 raster images; colored fills). Unscanned pages on sampled large docs
   keep the old behavior — no evidence either way.

5. **Crop vector-chart bands to their panel on landscape pages**
   (pdf-figures.js `paddedFigureBox`): the band crop's x-range is the fills'
   own extent + pad on landscape pages, full page width on portrait.
   Portrait is document flow — row/end labels sit far outside the fills
   (MSIM's row labels start 118 pt left of the first symbol; CERN's donut
   is flanked by value labels) and full width is the only safe frame.
   Landscape is a slide-style layout whose chart lives in its own panel
   between parallel side streams (a prose column, a nav rail) that duplicate
   nothing of the chart; every corpus band page sorts cleanly by
   orientation.

## Consequences

- The corpus doc's attach set falls 18 → 10; all graded-decoration pages
  drop, every real photo/chart/scan stays, the two crop-union victims crop
  to their actual figure (a left-margin photo, a solar photo beside a dark
  text panel), and both landscape chart pages crop to their panel minus the
  prose column and nav rail (one was previously a whole-page copy).
- Accepted risk (same direction as ADR 0007's G3b): a genuine figure
  deliberately repeated on two pages, or two real figures sharing exact
  intrinsic dims across pages, demotes as furniture and its pages may not
  attach at all. Across the graded corpus every exact-dims cross-page repeat
  was decoration.
- Known residual: one page's scenario-card region pairs a large flattened
  wave-art image with card-header text at 0.32× density — between the
  keeper band (≤ 0.17 after furniture stripping) and the demotion threshold
  (0.5, panels ≥ 0.54). It still attaches with a tighter crop. Splitting at
  ~0.25 would catch it but leaves no margin over the scanned-table keeper
  at 0.39 measured pre-stripping; revisit with more graded corpus data.
- A latent inconsistency noted, not fixed: classification measures text
  density against furniture-stripped text, the figure paths against raw
  text (furniture keys don't ride the summary). The ratios differ by
  ≤ 0.05 on every corpus page — harmless today.
