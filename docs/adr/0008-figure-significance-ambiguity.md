# ADR 0008 — A single significant figure earns the ambiguous prompt

- **Status:** Accepted
- **Date:** 2026-07-09

## Context

Classification treated a document as *ambiguous* (surface the Convert /
attach-figures / original choice) only at `MIN_CHART_PAGES_FOR_AMBIGUOUS = 2`
image-bearing text pages. The threshold exists to suppress prompt fatigue
from incidental images — letterhead logos, header rules — and that goal is
sound. But page *count* is a poor proxy for figure *significance*: a genuine
one-page chart-and-text brief was silently flattened to text (the user never
got the choice), while two pages of logos would have prompted. Whether a
lone real chart rides along is a user decision, not ours to default away.

The blocker had been cost: classification is the cheap pass that runs on
every drop, and "is this image a real figure?" seemed to require the heavy
extraction pass. ADR 0007's gate dissolved that: the operator-list walk
classification already performs carries the CTM box (on-page size) and, in
pdf.js v6, each image's intrinsic pixel dimensions — significance is one
extra pure walk over arrays already in hand. Zero new pdf.js calls.

## Decision

1. **One definition of "real figure."** The significance predicate
   (figure-sized CTM box ≥ 30 pt; **on-page footprint ≥ 5 % of the page
   area**; when intrinsic dims are known, ≥ 128 px short edge and aspect
   ≤ 8:1) is extracted from the decode gate into `significantRasters` /
   `pageHasSignificantImage` (raster-gate.js) and shared by both consumers.
   A logo, gradient strip, or icon fails the ambiguity trigger and the
   decode gate for the same reasons, tested once. Figure-sized,
   page-claiming inline images and masks count as significant (visual
   content) even though they aren't decodable.

   *The footprint gate was added same-day from a field false-positive*: a
   Gmail payment-confirmation PDF whose green header logo shipped as a
   1601×609 px retina asset painted at 118×41 pt. Big real pixels, sane
   aspect — every pixel gate passes; modern logo assets defeat intrinsic
   resolution as a decoration signal. What decoration never claims is page
   area: field logos land at ~1–2 % of the page, genuine chart/photo
   figures at 8 %+, so `MIN_FIGURE_PAGE_FRACTION = 0.05` splits them with
   margin on both sides (tunable against the graded corpus). Callers pass
   the page area from `page.view`; without geometry the gate is skipped.

2. **Additive trigger, not replacement.** `chartPages ≥ 2 → ambiguous`
   stays untouched; new rule: *any chart page with `figureImages ≥ 1` also
   → ambiguous*, under the distinct reason **`text-with-figure`** so the
   graded-confidence corpus runs can grade the new trigger separately.
   Monotone by construction — nothing that prompted before stops prompting
   (the WHO document is provably unaffected). The tempting inverse — using
   significance to *silence* multi-page logo documents — is deferred until
   corpus evidence: removing prompts is the risky direction.

3. **Back-compat by shape.** `perPage` entries without a `figureImages`
   field behave exactly as before; producers opt in (inbrowser.js computes
   it from the same operator list it was already fetching, and
   `extrapolateImages` nearest-fills it on sampled large documents alongside
   the image count).

## Consequences

- A one-page PDF with a real chart/photo now prompts; a one-page PDF with a
  letterhead logo still converts quietly. `inspect-pdf.mjs` prints an `f`
  flag per significant page for corpus sweeps.
- The ambiguous prompt inherits everything downstream unchanged: the figures
  choice, the mini-PDF, the ADR 0007 decode path, ambiguous-default
  persistence.
- Slightly more prompting overall, all of it on documents where text-only
  conversion would have dropped a real figure — which is the "never silently
  degrade" spine, applied to the case the page-count proxy missed.
