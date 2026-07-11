// Standalone raster XObject gate — the "PDF hard case" slice of
// extract-and-reference (SPEC M3). Decides, from a page's operator list
// alone, whether the page's figure content IS a single embedded raster image
// (a photo/diagram XObject worth decoding at native resolution) as opposed to
// a vector chart that merely paints raster fragments (gradient strips, map
// tiles) or page furniture (logos, letterheads).
//
// The asymmetry that shapes every threshold here: a false positive decodes
// the raster INSTEAD of crop-rendering the page, silently dropping any vector
// chart painted around it — the SPEC §6 "quietly make answers worse" risk. A
// false negative just leaves a photo on the existing render-crop path,
// arriving slightly softer. So every gate biases toward "no": the crop path
// stays the correctness baseline, and decode is an opportunistic upgrade.
//
// Pure (no pdf.js/chrome imports) so it unit-tests in Node. pdf-figures.js
// maps the op names below through pdfjsLib.OPS and feeds the raw
// fnArray/argsArray; scripts/inspect-pdf.mjs does the same for QA sweeps.

// Ops that paint vector graphics. In pdf.js v4+ the paint verb (fill/stroke/…)
// rides inside constructPath's args, so constructPath itself is the signal;
// the bare verbs are kept for older/other builds where they appear standalone.
// Over-counting (e.g. a clip-only path) only biases toward the crop path —
// the safe direction.
export const VECTOR_PAINT_OP_NAMES = [
  "constructPath",
  "fill",
  "eoFill",
  "stroke",
  "closeStroke",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
  "shadingFill",
];

// Raster ops that CAN'T be decoded standalone (inline images arrive as
// imgData in the op args, masks are 1-bit stencils) — a figure-sized one
// means the page's visual content isn't a single decodable XObject, so the
// page falls back to the crop path rather than risk losing it.
export const NON_DECODABLE_IMAGE_OP_NAMES = [
  "paintInlineImageXObject",
  "paintInlineImageXObjectGroup",
  "paintImageMaskXObject",
];

// paintImageXObjectRepeat tiles one image at many positions — wallpaper,
// borders, texture fills. Its presence marks the page as decorated, never as
// a single-photo page.
export const REPEAT_IMAGE_OP_NAMES = ["paintImageXObjectRepeat"];

// An image op smaller than this on the page (pt, both edges) is an icon /
// logo / bullet, not a figure. Shared with pdf-figures.js's crop-box union so
// the two paths agree on what "figure-sized" means.
export const MIN_IMAGE_EDGE_PT = 30;

// Intrinsic-pixel gates, applied when the op args carry the image's real
// dimensions (pdf.js v6 emits [objId, w, h]; absent in other builds — then
// the decoder re-checks against the resolved object, which is authoritative):
// a CTM box says "big on the page", intrinsic dims say "actually carries
// pixels". A 2×256 gradient strip stretched across half the page passes every
// CTM test and fails this one, decisively.
export const MIN_INTRINSIC_PX = 128;
export const MAX_INTRINSIC_ASPECT = 8;

// A significant figure must also occupy a real fraction of the page. This is
// the gate intrinsic pixels can't provide: modern logo assets ship at retina
// resolution (a 1601×609px logo painted 118×41pt — 1% of the page — passes
// every pixel test), but decoration never claims real page area. Field data:
// logos land at ~1–2% of the page, genuine chart/photo figures at 8%+, so 5%
// splits them with margin on both sides. Tune against the graded corpus.
export const MIN_FIGURE_PAGE_FRACTION = 0.05;

// Raster dominance: a true photo page paints at most a handful of vector ops
// (a border rule, a caption underline); a vector chart paints dozens to
// hundreds (axes, gridlines, bars). Count-based so it needs no path geometry
// and no pdf.js-version-dependent bounds.
export const MAX_VECTOR_PAINT_OPS = 8;

// A page whose figure content spreads over more decodable rasters than this
// is a collage/tiled-map case — the crop path's union box frames those
// correctly; decode handles only the single-figure page (v1).
export const MAX_DECODABLE_RASTERS = 1;

// --- Background/decoration demotion (the MSIM-report false positives) -------
// A raster that reaches within this many pt of a page edge "bleeds" that
// edge. Design software places full-bleed art exactly on (or 1pt past) the
// trim box, so a small tolerance absorbs the jitter without ever reaching a
// margin (real report margins are 20pt+).
export const BLEED_EDGE_TOL_PT = 6;
// Bleeding this many page edges marks the image as a design element — banner
// photos, section-divider art, full-page covers. Content figures live inside
// the margins (axis labels, captions and body text need the room), so they
// bleed 0 edges; a generous hero image may bleed 2 (top + one side). Field
// data (MSIM climate report): every decorative photo bled 3–4 edges, every
// genuine corpus figure (WHO charts, scanned figures, invoice logos) bled ≤2.
export const BACKGROUND_MIN_BLEED_EDGES = 3;
// Text-under-image demotion: when at least this fraction of the page's
// text-layer characters sit INSIDE the image's box, the image is a backdrop
// the text is printed over (cover pages, section dividers), not a figure. A
// real raster figure carries its labels as pixels — the text layer around it
// stays outside the box save for a stray caption.
export const BACKGROUND_TEXT_FRACTION = 0.85;
// Below this many text chars the overlap fraction is noise (a bare page
// number centered on a full-page photo shouldn't demote it — the bleed gate
// judges those). Matches classify.js's MIN_TEXT_CHARS_PER_PAGE.
export const BACKGROUND_MIN_TEXT_CHARS = 50;

// --- Vector-chart fill signal (the MSIM risk-matrix false negative) ---------
// A chart that encodes its values as colored symbols (risk matrices, heatmap
// grids, harvey balls) reaches the text layer as headers and row labels with
// EMPTY data cells — nothing convergence or the raster gates can see. What
// the operator list does see: many small vector fills in several distinct
// hues (the categorical palette). Decoration never looks like this — brand
// accents recolor rules and bands in ONE hue family, and covers use a few
// large blocks. Field calibration (7-doc corpus): symbol charts scored 24–92
// colored fills across 3–4 hue buckets; the busiest non-chart page scored 163
// fills in ONE hue bucket, and no non-chart page reached 3 buckets with ≥2
// fills each. The hue-diversity requirement, not the count, carries the gate.
export const VECTOR_CHART_MIN_COLORED_FILLS = 12;
export const VECTOR_CHART_MIN_HUES = 3;
export const VECTOR_CHART_MIN_FILLS_PER_HUE = 2;
// A fill color is "categorical" (chart-palette material) only when clearly
// chromatic: max(r,g,b) − min(r,g,b) above this keeps black text, gray rules
// and near-white bands out of the hue counts.
export const MIN_CHROMA = 40;
// Hue circle is split into this many buckets (60° each) — coarse enough that
// jittered shades of one brand color share a bucket, fine enough that a
// green/yellow/red palette lands in three.
export const HUE_BUCKETS = 6;

// Vector ops that FILL (paint area with the current fill color). A subset of
// VECTOR_PAINT_OP_NAMES: stroke-only ops don't apply the fill color, and
// shadingFill uses its own pattern. constructPath is included because v4+
// packs the paint verb inside it — over-counting a stroke-only or clip-only
// path only inflates counts on pages that are already vector-heavy.
export const FILL_PAINT_OP_NAMES = [
  "constructPath",
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
];

// setFillRGBColor arg → [r,g,b] 0–255, or null when unparseable. pdf.js v6
// passes a CSS hex string ("#199050"); older builds pass component numbers.
export function parseFillRGB(args) {
  const a = args ?? [];
  if (typeof a[0] === "string") {
    const m = /^#([0-9a-f]{6})$/i.exec(a[0]);
    if (!m) return null;
    const v = parseInt(m[1], 16);
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
  }
  if (a.length >= 3 && a.every((x) => typeof x === "number")) {
    // Components either 0–1 floats or 0–255 ints; a max ≤ 1 says floats.
    const scale = Math.max(a[0], a[1], a[2]) <= 1 ? 255 : 1;
    return [a[0] * scale, a[1] * scale, a[2] * scale].map((x) =>
      Math.max(0, Math.min(255, Math.round(x)))
    );
  }
  return null;
}

// Hue bucket (0..HUE_BUCKETS-1) of a chromatic color, or null for
// black/gray/white/near-neutral (chroma below MIN_CHROMA).
export function hueBucket(rgb) {
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn < MIN_CHROMA) return null;
  let h;
  if (mx === r) h = ((g - b) / (mx - mn)) % 6;
  else if (mx === g) h = (b - r) / (mx - mn) + 2;
  else h = (r - g) / (mx - mn) + 4;
  return Math.floor(((h * 60 + 360) % 360) / (360 / HUE_BUCKETS));
}

// --- 2×3 matrix helpers (PDF's row-vector convention) ------------------------
// composed = apply m, then n. Shared with pdf-figures.js's CTM replay.
export const composeTransform = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
export const applyTransform = (m, x, y) => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

// Axis-aligned box of the unit square through a CTM — where an image op
// paints in user space.
function unitSquareBox(ctm) {
  const corners = [
    applyTransform(ctm, 0, 0),
    applyTransform(ctm, 1, 0),
    applyTransform(ctm, 0, 1),
    applyTransform(ctm, 1, 1),
  ];
  const xs = corners.map((c) => c[0]);
  const ys = corners.map((c) => c[1]);
  return {
    x0: Math.min(...xs),
    y0: Math.min(...ys),
    x1: Math.max(...xs),
    y1: Math.max(...ys),
  };
}

const figureSized = (box) =>
  box.x1 - box.x0 >= MIN_IMAGE_EDGE_PT && box.y1 - box.y0 >= MIN_IMAGE_EDGE_PT;

// Map a name list through an OPS table, dropping names the build doesn't
// define (a Set containing undefined can never match an fnArray entry, but
// dropping keeps intent explicit).
const opSet = (names, ops) =>
  new Set(names.map((n) => ops[n]).filter((v) => v !== undefined));

// Walk a page's operator list, replaying save/restore/transform to know the
// CTM at each paint op (same replay as pdf-figures.js figureBoxUserSpace).
//
//   fnArray/argsArray: from page.getOperatorList()
//   ops:               the build's OPS name→number table (or a test fake)
//
// Returns {
//   xobjects:       [{ objId, w, h, box }]  — every paintImageXObject, with
//                   intrinsic dims when the args carry them (else null)
//   otherImageBoxes: boxes of non-decodable raster paints (inline/mask)
//   otherFigureImages: how many of those are figure-sized (decode disqualifier)
//   repeats:        count of image-tiling ops
//   vectorPaintOps: count of vector paint ops
//   coloredFills:   fill-paint ops executed under a chromatic fill color
//   coloredFillHues: per-hue-bucket counts of those fills (HUE_BUCKETS long)
// }
export function scanPageOps(fnArray, argsArray, ops) {
  const vectorOps = opSet(VECTOR_PAINT_OP_NAMES, ops);
  const fillOps = opSet(FILL_PAINT_OP_NAMES, ops);
  const nonDecodable = opSet(NON_DECODABLE_IMAGE_OP_NAMES, ops);
  const repeatOps = opSet(REPEAT_IMAGE_OP_NAMES, ops);

  let ctm = [1, 0, 0, 1, 0, 0];
  // Fill color rides the graphics state alongside the CTM, so save/restore
  // stacks both together.
  let fillHue = null;
  const stack = [];
  const scan = {
    xobjects: [],
    otherImageBoxes: [],
    otherFigureImages: 0,
    repeats: 0,
    vectorPaintOps: 0,
    coloredFills: 0,
    coloredFillHues: new Array(HUE_BUCKETS).fill(0),
  };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) stack.push([ctm, fillHue]);
    else if (fn === ops.restore)
      [ctm, fillHue] = stack.pop() ?? [[1, 0, 0, 1, 0, 0], null];
    else if (fn === ops.transform) ctm = composeTransform(argsArray[i], ctm);
    else if (fn === ops.setFillRGBColor)
      fillHue = hueBucket(parseFillRGB(argsArray[i]));
    else if (fn === ops.paintImageXObject) {
      const args = argsArray[i] ?? [];
      scan.xobjects.push({
        objId: typeof args[0] === "string" ? args[0] : null,
        w: typeof args[1] === "number" ? args[1] : null,
        h: typeof args[2] === "number" ? args[2] : null,
        box: unitSquareBox(ctm),
      });
    } else if (nonDecodable.has(fn)) {
      const box = unitSquareBox(ctm);
      scan.otherImageBoxes.push(box);
      if (figureSized(box)) scan.otherFigureImages++;
    } else if (repeatOps.has(fn)) {
      scan.repeats++;
    } else if (vectorOps.has(fn)) {
      scan.vectorPaintOps++;
      if (fillOps.has(fn) && fillHue != null) {
        scan.coloredFills++;
        scan.coloredFillHues[fillHue]++;
      }
    }
  }
  return scan;
}

// Does the page's vector paint read as a symbol/heatmap chart — the flattened
// figure whose data cells never reach the text layer? Many chromatic fills
// across several distinct hues is the fingerprint of a categorical palette;
// see the constants above for the calibration. Pages passing this join the
// figures flow as flattened charts (the attachment is the only faithful copy
// of their values).
export function hasVectorChartFills(scan) {
  if (!scan || (scan.coloredFills ?? 0) < VECTOR_CHART_MIN_COLORED_FILLS)
    return false;
  const hues = (scan.coloredFillHues ?? []).filter(
    (c) => c >= VECTOR_CHART_MIN_FILLS_PER_HUE
  ).length;
  return hues >= VECTOR_CHART_MIN_HUES;
}

const boxArea = (box) => (box.x1 - box.x0) * (box.y1 - box.y0);

// Does a box claim enough of the page to be a figure rather than decoration?
// pageArea null/absent skips the check (callers without page geometry).
const claimsPageArea = (box, pageArea) =>
  pageArea == null || boxArea(box) >= MIN_FIGURE_PAGE_FRACTION * pageArea;

// How many page edges the box bleeds (reaches within BLEED_EDGE_TOL_PT of).
// `view` is the page's [x0, y0, x1, y1] box (pdf.js page.view).
export function bleedEdgeCount(box, view) {
  const [vx0, vy0, vx1, vy1] = view;
  let edges = 0;
  if (box.x0 <= vx0 + BLEED_EDGE_TOL_PT) edges++;
  if (box.x1 >= vx1 - BLEED_EDGE_TOL_PT) edges++;
  if (box.y0 <= vy0 + BLEED_EDGE_TOL_PT) edges++;
  if (box.y1 >= vy1 - BLEED_EDGE_TOL_PT) edges++;
  return edges;
}

// Does the box read as a background/decoration rather than a figure?
//   view       (optional [x0,y0,x1,y1]) — full-bleed design elements demote
//   textPoints (optional [{x, y, chars}]) — one entry per text item, at its
//              anchor point with its non-whitespace char count. An image that
//              CONTAINS (almost all of) the page's text is a backdrop the
//              text is printed over, never a figure — a real raster figure
//              carries its labels as pixels, not as a text layer on top.
// Both signals are per-box and callers may pass either, both, or neither
// (absent inputs skip their check — old behavior).
export function isBackgroundImage(box, { view = null, textPoints = null } = {}) {
  if (view && bleedEdgeCount(box, view) >= BACKGROUND_MIN_BLEED_EDGES) {
    return true;
  }
  if (textPoints && textPoints.length) {
    let total = 0;
    let inBox = 0;
    for (const p of textPoints) {
      total += p.chars;
      if (p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1) {
        inBox += p.chars;
      }
    }
    if (
      total >= BACKGROUND_MIN_TEXT_CHARS &&
      inBox / total >= BACKGROUND_TEXT_FRACTION
    ) {
      return true;
    }
  }
  return false;
}

// The XObjects that read as real figures: figure-sized on the page (CTM box),
// claiming a real fraction of the page (`pageArea`, pt² — pass it whenever
// page geometry is in hand: retina-resolution logo assets defeat the pixel
// gates and only footprint separates them), AND, when the op args carry
// intrinsic dims, actually pixel-bearing with a sane aspect. This is the one
// definition of "significant figure" — the decode gate builds on it below,
// and classification uses it to decide whether an image is worth surfacing
// the ambiguous prompt for: a logo/strip/icon fails here for the same
// reasons in both places.
//
// `opts` ({ view, textPoints }, both optional) enables the background
// demotion: full-bleed design art and under-text backdrops are decoration no
// matter how big they are (the MSIM-report stock photos passed every size
// gate). Callers without the geometry omit it — old behavior.
export function significantRasters(scan, pageArea = null, opts = {}) {
  return scan.xobjects.filter((x) => {
    if (!figureSized(x.box)) return false;
    if (!claimsPageArea(x.box, pageArea)) return false;
    if (isBackgroundImage(x.box, opts)) return false;
    if (x.w != null && x.h != null) {
      if (Math.min(x.w, x.h) < MIN_INTRINSIC_PX) return false;
      if (Math.max(x.w, x.h) / Math.min(x.w, x.h) > MAX_INTRINSIC_ASPECT)
        return false;
    }
    return true;
  });
}

// How many of the page's images read as real figures (as opposed to
// decoration)? Figure-sized, page-claiming inline images and masks count too
// — they're visual content even though they can't be decoded standalone.
export function countSignificantImages(scan, pageArea = null, opts = {}) {
  const inlineFigures = scan.otherImageBoxes.filter(
    (b) =>
      figureSized(b) && claimsPageArea(b, pageArea) && !isBackgroundImage(b, opts)
  ).length;
  return inlineFigures + significantRasters(scan, pageArea, opts).length;
}

export function pageHasSignificantImage(scan, pageArea = null, opts = {}) {
  return countSignificantImages(scan, pageArea, opts) > 0;
}

// The single decodable raster the page's figure content amounts to, or null
// when the page should stay on the crop path. Gates (all must hold):
//   G1 size:  CTM box figure-sized AND intrinsic dims (when known) real
//   G2 shape: intrinsic aspect sane (no banners/strips)
//   G4 raster dominance: negligible vector paint on the page
//   G5 single figure: exactly one qualifying raster
// plus disqualifiers: any figure-sized non-decodable raster, any tiling op.
// (G3, cross-page repetition, needs document scope — the decoder applies it
// via the g_ global-cache prefix and a dims fingerprint across pages.)
export function decodeCandidate(scan, pageArea = null, opts = {}) {
  if (scan.vectorPaintOps > MAX_VECTOR_PAINT_OPS) return null;
  if (scan.repeats > 0) return null;
  if (scan.otherFigureImages > 0) return null;

  // G1/G2 via the shared significance filter (page-area gate included when
  // geometry is passed, background demotion when `opts` carries view/text
  // geometry), plus a resolvable object id.
  const qualifying = significantRasters(scan, pageArea, opts).filter(
    (x) => x.objId
  );
  return qualifying.length === MAX_DECODABLE_RASTERS ? qualifying[0] : null;
}
