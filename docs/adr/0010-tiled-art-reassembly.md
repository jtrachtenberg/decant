# ADR 0010 — Judge raster figures as reassembled components, not paint ops

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

An interactive corporate report (the `table-heavy` corpus doc, a designed
36-page climate report) defeated the ADR 0009 background demotion on almost
every page. Its full-bleed background art is exported the way design tools
routinely export large placed images: **sliced into a grid of abutting raster
tiles**, each hanging past the page edges (the crop box clips the overhang,
so boxes carry negative coordinates and extents beyond the page view).

Judged one paint op at a time, every gate misreads the artwork:

- Each tile bleeds only 1–2 page edges — the demotion needs 3 — so a backdrop
  sliced 2×2 scores as **four significant figures**.
- Off-page extents make bleed counting meaningless (a box ending at x = −18
  never "reaches" the left edge it visually saturates).
- The text-over check dilutes the same way: each tile contains only a slice
  of the overlaid text.

Result: 30 of 35 text pages entered the figures flow, the 20-page attachment
cap filled with decorated text pages, and the crop union — which took ALL
figure-sized paints — framed background art, slicing body columns mid-word.
The same slicing also hid true figures elsewhere: the `chart-heavy` corpus
doc's photo-collage pages paint each photo small enough that no single tile
claims the 5 % page-area floor.

## Decision

**Clamp every raster box to the page view, merge abutting/overlapping boxes
into connected components, and run the ADR 0008/0009 significance gates on
the components** (`figureComponents` / `significantFigureComponents`,
raster-gate.js).

- **Clamp first** (`clampBoxToView`): off-page paint is invisible, and a
  clamped edge *is* a bleeding edge, which restores the bleed count's
  meaning for overhanging art.
- **Merge what touches within 3 pt** — tiles partition their artwork with
  ~2 pt seams, while genuinely separate figures keep real gutters (field
  data: ≥ 8 pt everywhere in the corpus).
- **Never merge containment**: a figure painted ON TOP of full-bleed
  background sits inside the backdrop's box; merging that pair would demote
  the figure along with its backdrop — the "quietly make answers worse"
  direction. The backdrop demotes alone; the contained figure is judged on
  its own.
- Intrinsic-pixel gates (ADR 0007 G1/G2) apply only to single-XObject
  components — a tile's own pixel dims say nothing about the whole.
- The decode gate (ADR 0007) now requires exactly one significant component
  that IS one XObject; a multi-tile component attaches via the crop path (no
  single object to decode). The decode pass also gained the same
  `{ view, textPoints }` geometry the significance call sees, so decode can
  never resurrect a page classification demoted.
- The **crop union is the union of significant components** (pdf-figures.js)
  instead of all figure-sized paints, so the crop frames what made the page
  attach — never the demoted backdrop around it.

## Consequences

- The interactive report drops from 30 figure pages to 16 + 5 flattened: the
  all-background pages stop attaching, and crops frame the hero photos /
  infographic bands instead of slicing text columns.
- The `chart-heavy` doc's six photo-collage pages (5–6 tiled photos each)
  become visible as figures — previously every tile individually failed the
  page-area floor. Its later single-photo pages stay figure pages but five
  fall past the unchanged 20-page cap in their favor (page-order tie-break).
- One new false positive in the report: a 5-tile decorative gradient card
  merges into a component big enough to attach (~one wasted band crop). The
  cheap direction, per the ADR 0007 asymmetry.
- clean-text, private-novel, messy-scan and public-famous corpus verdicts,
  flags and attach sets are unchanged by this mechanism.
