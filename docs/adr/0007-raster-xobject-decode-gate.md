# ADR 0007 — Raster XObject decode: an opportunistic upgrade behind an asymmetric gate

- **Status:** Accepted
- **Date:** 2026-07-09

## Context

ADR 0006 ships PDF figures as a chart-pages mini-PDF whose pages are 2×
page-render crops. That is the right treatment for vector charts (the common
case: there is no image to extract — the chart *is* the page's drawing
operators). But for a page whose figure is a genuinely **embedded raster** — a
photo, a scanned diagram — the render-crop re-rasterizes an already-raster
image at page scale: original resolution lost, page background dragged in.
pdf.js holds the decoded bitmap in its object registry; SPEC M3 deferred
pulling it out as "the hard case."

The hard part is not the decoding. It is deciding **when the raster is the
content**: vector charts routinely paint raster fragments (gradient strips,
map tiles, texture fills), and documents are full of raster furniture (logos,
letterheads, wallpaper). Decoding the wrong image replaces the whole figure
region with a fragment of it.

## Decision

**Decode is an opportunistic fidelity upgrade over the crop path, never a
replacement for it** — because the two failure modes are wildly asymmetric:

- *False positive* (decode fires beside vector content): the vector chart is
  silently dropped from the mini-PDF page — the SPEC §6 "quietly make answers
  worse" failure, exactly.
- *False negative* (a real photo stays on the crop path): the photo arrives
  slightly softer. Barely a cost.

So every gate resolves ambiguity to "no," and the crop path remains the
correctness baseline. Concretely (`src/convert/raster-gate.js`, pure and
Node-tested; `extractPdfRasterFigures` in `pdf-figures.js` applies it):

1. **Size, twice** — the CTM box says "big on the page" (≥ 30 pt both edges);
   the intrinsic pixel dims say "actually carries pixels" (≥ 128 px short
   edge, aspect ≤ 8:1). A 2×256 gradient strip stretched across half the page
   passes every CTM test and fails the intrinsic one, decisively.
2. **Raster dominance** — > 8 vector-paint ops on the page → crop path. A
   photo page paints a border rule or two; a chart paints dozens–hundreds of
   fills. Count-based, so it needs no path geometry and survives pdf.js's
   packed-path format changes.
3. **Single figure** — exactly one qualifying raster; collages and tiled maps
   stay on the crop path, whose union box already frames them.
4. **No repetition** — a `g_`-prefixed objId (pdf.js's global image cache
   promotes images seen on ≥ 2 pages) or intrinsic dimensions recurring on
   another page mark furniture: logos and letterheads big enough to pass the
   size gates.
5. **Nothing non-decodable in figure position** — a figure-sized inline
   image, image mask, or any tiling op disqualifies the page outright.

Decoded figures are re-encoded as **JPEG** (white-backed, long edge capped at
2048) and ride the mini-PDF's existing crop slot (`{jpg|png, widthPt,
heightPt}`) — same one-attachment shape, same page stamps, same association
footer, same savings netting. No new UI: the feature is invisible except as
sharper figures.

Losing the caption/axis text the crop's 36 pt pad would have kept is safe by
construction: that text is page text, already present in the converted
Markdown. For vector charts the labels are *not* in the raster — which is
what gate 2 screens out.

## Consequences

- Photo-bearing chart pages land at native sharpness; vector-chart documents
  (WHO-style) are byte-for-byte unaffected — the gate never fires on them.
- The decode pass is render-free (`getOperatorList` + `objs.get`), so it is
  *tried* on Firefox too, where pdf.js canvas rendering hangs; only the JPEG
  re-encode touches (plain) OffscreenCanvas. If that fails in the sandbox it
  degrades to the vector CropBox path — needs the smoke-checklist probe.
- Two same-dimensioned photos on different pages both fall back to crops
  (fingerprint collision) — accepted: the safe direction, costing sharpness
  only.
- Threshold drift is observable before it bites: `inspect-pdf.mjs` prints a
  per-page `d` eligibility flag for corpus sweeps, and an OPS-name pin test
  fails loudly if a pdf.js upgrade renames an operator (which had already
  happened once: `IMAGE_OP_NAMES` shipped `"paintInlineImage"`, which resolves
  to `undefined` — inline images were silently uncounted until this branch
  fixed the name to `paintInlineImageXObject`).
