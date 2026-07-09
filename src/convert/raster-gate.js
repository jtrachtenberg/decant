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

// Raster dominance: a true photo page paints at most a handful of vector ops
// (a border rule, a caption underline); a vector chart paints dozens to
// hundreds (axes, gridlines, bars). Count-based so it needs no path geometry
// and no pdf.js-version-dependent bounds.
export const MAX_VECTOR_PAINT_OPS = 8;

// A page whose figure content spreads over more decodable rasters than this
// is a collage/tiled-map case — the crop path's union box frames those
// correctly; decode handles only the single-figure page (v1).
export const MAX_DECODABLE_RASTERS = 1;

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
//   otherFigureImages: count of figure-sized non-decodable raster paints
//   repeats:        count of image-tiling ops
//   vectorPaintOps: count of vector paint ops
// }
export function scanPageOps(fnArray, argsArray, ops) {
  const vectorOps = opSet(VECTOR_PAINT_OP_NAMES, ops);
  const nonDecodable = opSet(NON_DECODABLE_IMAGE_OP_NAMES, ops);
  const repeatOps = opSet(REPEAT_IMAGE_OP_NAMES, ops);

  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const scan = { xobjects: [], otherFigureImages: 0, repeats: 0, vectorPaintOps: 0 };

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    if (fn === ops.save) stack.push(ctm);
    else if (fn === ops.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === ops.transform) ctm = composeTransform(argsArray[i], ctm);
    else if (fn === ops.paintImageXObject) {
      const args = argsArray[i] ?? [];
      scan.xobjects.push({
        objId: typeof args[0] === "string" ? args[0] : null,
        w: typeof args[1] === "number" ? args[1] : null,
        h: typeof args[2] === "number" ? args[2] : null,
        box: unitSquareBox(ctm),
      });
    } else if (nonDecodable.has(fn)) {
      if (figureSized(unitSquareBox(ctm))) scan.otherFigureImages++;
    } else if (repeatOps.has(fn)) {
      scan.repeats++;
    } else if (vectorOps.has(fn)) {
      scan.vectorPaintOps++;
    }
  }
  return scan;
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
export function decodeCandidate(scan) {
  if (scan.vectorPaintOps > MAX_VECTOR_PAINT_OPS) return null;
  if (scan.repeats > 0) return null;
  if (scan.otherFigureImages > 0) return null;

  const qualifying = scan.xobjects.filter((x) => {
    if (!x.objId || !figureSized(x.box)) return false;
    if (x.w != null && x.h != null) {
      if (Math.min(x.w, x.h) < MIN_INTRINSIC_PX) return false;
      if (Math.max(x.w, x.h) / Math.min(x.w, x.h) > MAX_INTRINSIC_ASPECT)
        return false;
    }
    return true;
  });
  return qualifying.length === MAX_DECODABLE_RASTERS ? qualifying[0] : null;
}
