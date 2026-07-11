# ADR 0009 — Background art is not a figure; colored-symbol charts are

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

A corporate climate report (the `private-novel` corpus doc) broke the figure
flow in both directions at once:

1. **Six decorative stock photos attached.** Full-bleed section-divider art
   and cover photos passed every ADR 0008 significance gate — figure-sized,
   page-claiming, real pixels, sane aspect — so the charts PDF was six pages
   of scenery whose overlaid text was already on the text layer. "Big enough
   to be a figure" is necessary but not sufficient.

2. **The document's real charts attached nothing.** Two risk matrices encode
   their values as colored vector symbols (green square / yellow hexagon /
   red circle; a sector×scenario heatmap). The text layer carries the headers
   and row labels — so column convergence scores fine (0.68/0.84, above the
   0.5 flattened threshold) — while every data cell is an invisible vector
   fill. No raster paints, so no image signal either. The emitted Markdown
   was a half-empty table with nothing telling the model that values are
   missing.

Both misses are operator-list-visible; neither needs rendering or decoding.

## Decision

1. **Demote background art from significance** (`isBackgroundImage`,
   raster-gate.js), on two geometric signals, either sufficient:
   - **Full bleed:** the image box reaches within 6 pt of ≥ 3 page edges.
     Design software places decoration on the trim box; content figures live
     inside the margins (axis labels and captions need the room). Corpus
     field data: every decorative photo bled 3–4 edges, every genuine figure
     (WHO charts, scanned figures, invoice logos) bled ≤ 2.
   - **Text printed over the image:** ≥ 85 % of the page's text-layer chars
     (min 50) sit inside the image box. A real raster figure carries its
     labels as pixels; an image *under* the page's text is a backdrop.

   The demotion applies wherever significance does — the ambiguity trigger,
   `selectChartPages` membership, and the decode gate — via an optional
   `{ view, textPoints }` argument threaded from `analyzePdf` (both inputs
   were already in hand; callers without geometry keep old behavior).

2. **Read colored vector fills as a chart signal** (`hasVectorChartFills`).
   The same op walk now replays `setFillRGBColor` through save/restore and
   counts fill ops executed under a chromatic color, bucketed by hue (60°
   buckets, chroma ≥ 40 so neutrals never count). A page with **≥ 12 colored
   fills across ≥ 3 hue buckets (≥ 2 fills each)** is a vector symbol chart:
   categorical palettes are multi-hue by design, while brand decoration —
   however busy — recolors in one hue family. Corpus calibration: symbol
   charts scored 24–92 fills in 3–4 buckets; the busiest non-chart page
   scored 163 fills in ONE bucket, and no non-chart page reached 3 buckets.
   Hue diversity, not volume, carries the gate.

   Such pages join the figures flow as **flattened** pages (the attachment is
   the only faithful copy of their values) and their Markdown gains a visible
   note (`appendVectorChartNote`) promising the attached figure — same
   invariant as the omitted-chart-table marker.

## Consequences

- The climate report now attaches exactly its two symbol-chart pages instead
  of six photos; the chart-heavy corpus doc gains two vector-only infographic
  pages (previously invisible — they displace two raster-photo pages past the
  20-page cap, the intended ranking); clean-text, table-heavy, messy-scan and
  public-famous corpus verdicts and attach sets are unchanged.
- A multi-hue decorative page (illustrated cover art with ≥ 12 fills in ≥ 3
  hues) would false-positive into one extra attached page — the cheap
  direction; the asymmetry mirrors ADR 0007: a missed symbol chart loses the
  document's only copy of its data.
- Photographic half-page stock images that respect margins still pass
  significance (nothing at the operator level distinguishes them from a
  meaningful photo); separating photo from diagram content needs decoded
  pixels and stays out of scope here.
