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

Both signals are operator-list + text-layer visible; no rendering needed.

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
   (`BACKGROUND_TEXT_DENSITY_MIN_CHARS`) at ≥ 0.7× the page's own per-area
   char density (`BACKGROUND_TEXT_DENSITY_RATIO`) is a backdrop the text is
   printed over. A real raster figure is text-free inside (its labels are
   pixels) save for a caption, which the char floor absorbs. Field
   calibration (Discovery doc): every text-backed panel scored 0.98–2.1×,
   every genuine photo/chart/scan ≤ 0.39× (worst case: a scanned table page
   with legend text over its region). The threshold is biased high because
   this demotion *removes* a figure — the costly direction — so only clearly
   text-backed boxes fire.

## Consequences

- The corpus doc's attach set falls 18 → 12; all seven graded-decoration
  pages drop, every real photo/chart/scan stays, and the two crop-union
  victims now crop to their actual figure (the left-margin photo, a solar
  photo beside a dark text panel).
- One page *gains* an attachment: a unique image that previously merged into
  a demoted full-bleed component now stands alone (a styled commitments
  table's backdrop at 0.54× density — sparse table text reads less dense
  than prose). Judged acceptable: the attachment frames a real styled table.
- Accepted risk (same direction as ADR 0007's G3b): a genuine figure
  deliberately repeated on two pages, or two real figures sharing exact
  intrinsic dims across pages, demotes as furniture and its pages may not
  attach at all. Across the graded corpus every exact-dims cross-page repeat
  was decoration.
- A convergence-flagged text page (`0.48`, threshold `0.5`) still attaches:
  it carries a committee org-chart whose structure is positional, and the
  0.5 threshold's calibration band (ADR 0005 wiring) confirms soup at
  ≤ 0.49. Left alone deliberately; revisit only with new corpus evidence.
