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

// --- Tiled/full-bleed art reassembly (the Discovery-report false positives) --
// Design tools export large placed art as SEVERAL abutting raster tiles, often
// hanging past the page edges (the crop box clips them). Judged one tile at a
// time, every gate below misreads the artwork: each tile bleeds only 1–2 edges
// (the demotion needs 3), claims a plausible page fraction, and carries enough
// pixels to pass the intrinsic tests — so a decorative backdrop sliced into a
// 2×2 grid scores as four significant figures. The fix is geometric: clamp
// each box to the page view (off-page paint is invisible, and a clamped edge
// IS a bleeding edge), then merge boxes that abut or overlap into one
// component and judge the component. Two abutting boxes merge only when
// NEITHER contains the other: tiles partition their artwork, while a genuine
// figure painted ON TOP of full-bleed background art sits inside the
// background's box — merging that pair would demote the figure along with its
// backdrop (the "quietly make answers worse" direction).
export const FIGURE_TILE_GAP_PT = 3;

// Box clamped to the page view, or null when nothing of it is on-page.
export function clampBoxToView(box, view) {
  if (!view) return box;
  const [vx0, vy0, vx1, vy1] = view;
  const c = {
    x0: Math.max(box.x0, vx0),
    y0: Math.max(box.y0, vy0),
    x1: Math.min(box.x1, vx1),
    y1: Math.min(box.y1, vy1),
  };
  return c.x1 > c.x0 && c.y1 > c.y0 ? c : null;
}

// Does a (clamped) box cover at least REPEATED_IMAGE_KEEP_PAGE_FRACTION of the
// page? Only answerable with page geometry — without a view, no dominance
// claim, so the census applies unchanged.
function dominatesPage(box, view) {
  if (!view) return false;
  const [vx0, vy0, vx1, vy1] = view;
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  if (!(pageArea > 0)) return false;
  const boxAreaPt = (box.x1 - box.x0) * (box.y1 - box.y0);
  return boxAreaPt / pageArea >= REPEATED_IMAGE_KEEP_PAGE_FRACTION;
}

const boxesTouch = (a, b) =>
  a.x0 <= b.x1 + FIGURE_TILE_GAP_PT &&
  b.x0 <= a.x1 + FIGURE_TILE_GAP_PT &&
  a.y0 <= b.y1 + FIGURE_TILE_GAP_PT &&
  b.y0 <= a.y1 + FIGURE_TILE_GAP_PT;

const boxContains = (a, b) =>
  a.x0 <= b.x0 + FIGURE_TILE_GAP_PT &&
  a.y0 <= b.y0 + FIGURE_TILE_GAP_PT &&
  a.x1 >= b.x1 - FIGURE_TILE_GAP_PT &&
  a.y1 >= b.y1 - FIGURE_TILE_GAP_PT;

const shouldMerge = (a, b) =>
  boxesTouch(a, b) && !boxContains(a, b) && !boxContains(b, a);

// Merge view-clamped raster boxes into connected components. `members` are
// [{ box, xobject|null }] — xobject carries the scan entry (objId, intrinsic
// dims) so decode gating can still reason per-XObject. Merging goes by the
// MEMBER boxes (not the growing union), so a component can't leak across a
// gap via its own bounding box. Cross-page repeated images (isRepeatedImage —
// background art, letterheads) are dropped before merging: they aren't figure
// material, and keeping them would glue their footprint onto any real figure
// they abut.
export function figureComponents(scan, view = null, repeatedDims = null) {
  const members = [];
  for (const x of scan.xobjects) {
    const box = clampBoxToView(x.box, view);
    if (!box) continue;
    // Drop cross-page repeated images (furniture) before merging — UNLESS the
    // image dominates the page, which furniture never does (a scanned page vs.
    // a reused logo/strip; see REPEATED_IMAGE_KEEP_PAGE_FRACTION). A kept
    // full-bleed decoration is still demoted by the background gates below.
    if (isRepeatedImage(x, repeatedDims) && !dominatesPage(box, view)) continue;
    members.push({ box, xobject: x });
  }
  for (const b of scan.otherImageBoxes) {
    const box = clampBoxToView(b, view);
    if (box) members.push({ box, xobject: null });
  }

  const comps = [];
  for (const m of members) {
    const homes = comps.filter((c) =>
      c.members.some((o) => shouldMerge(o.box, m.box))
    );
    if (!homes.length) {
      comps.push({ members: [m] });
      continue;
    }
    const [home, ...rest] = homes;
    home.members.push(m);
    for (const r of rest) {
      home.members.push(...r.members);
      comps.splice(comps.indexOf(r), 1);
    }
  }
  return comps.map((c) => ({
    x0: Math.min(...c.members.map((m) => m.box.x0)),
    y0: Math.min(...c.members.map((m) => m.box.y0)),
    x1: Math.max(...c.members.map((m) => m.box.x1)),
    y1: Math.max(...c.members.map((m) => m.box.y1)),
    members: c.members,
  }));
}

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
// Text-density demotion (the Discovery-report callout-box false positives):
// design tools back text panels with subtle texture/gradient IMAGES — a
// rounded callout box, a "principles" card column — and the text printed over
// them reaches the text layer at normal body density. The whole-page
// BACKGROUND_TEXT_FRACTION check never sees these (each panel holds 10–20% of
// the page's text, nowhere near 85%), but density does: a box whose interior
// carries text at a comparable per-area rate to the page overall is a text
// backdrop, while a real raster figure is text-free inside (its labels are
// pixels) save for a stray caption. Field calibration (6-doc corpus sweep):
// text-backed panels scored 0.54–2.1× the page's density, every genuine
// photo/chart/scan ≤0.39× (worst keepers: a scanned-table region at 0.39, a
// solar photo at 0.17). 0.5 sits in the gap; the demotion REMOVES a figure
// (the costly direction), so the char floor below carries the safety margin —
// the CERN chart pages whose annotation text reads at 1.2–1.4× density hold
// only 130–160 chars and never reach the floor.
export const BACKGROUND_TEXT_DENSITY_RATIO = 0.5;
// Density floor: a caption or a chart's own annotations inside a figure box
// are at most a couple hundred chars — the calibrated text-backed panels held
// 306–1134. This floor, not the ratio, is what keeps label-dense real charts
// (CERN pp6–7) out of the demotion.
export const BACKGROUND_TEXT_DENSITY_MIN_CHARS = 250;

// --- Flattening-debris components (the Discovery scenario-page wave art) ----
// Transparency flattening exports soft/gradient artwork as DOZENS of
// overlapping raster slabs — one page painted 249 XObjects into a 617×92pt
// band. Merged, they read as a single significant component that no other
// gate can see through (the union is figure-sized, page-claiming, text-free).
// The tell is paint overlap: debris members RE-COVER the same region over and
// over (member-area sum ≈ 53× the component box), while every legitimate
// multi-paint composition PARTITIONS its footprint — ADR 0010 art tiles,
// strip-sliced photos and double-painted images all measure ≤ 1.7×. 4 splits
// the two populations with more than 2× margin on either side.
export const DEBRIS_OVERLAP_RATIO = 4;

// --- Cross-page repeated-image demotion (the Discovery contents-page FPs) ---
// The decode gate's G3 insight (ADR 0007) applied to significance itself: an
// image painted on several pages is furniture — background art sets, gradient
// strips, letterheads — never a content figure. Two forms, both per-XObject:
// a `g_`-prefixed objId is pdf.js's own global cache saying it saw the object
// on ≥2 pages, and a document-level intrinsic-dims census (built by
// analyzePdf / inspect-pdf over the scanned pages, carried on the summary as
// repeatedImageDims) catches the FIRST page such an image paints on, where
// the id is still page-local. Judged per member BEFORE component merging, so
// a decoration tile can't glue itself to a real figure. Accepted risk: a
// genuine figure deliberately repeated on two pages demotes too — across the
// graded corpus every exact-dims cross-page repeat was decoration, and the
// photos this could cost grade as marginal attachments anyway.
export const REPEATED_DIMS_MIN_PAGES = 2;

// Exception to the dims census: a repeated image that DOMINATES its page is
// content, not furniture. A scanned document page's raster fills most of the
// sheet, and distinct scans routinely share the scanner's exact auto-crop
// pixel dimensions — so a scanned annex trips the dims census on genuine
// pages (messy-scan corpus: 56–64% footprint scans demoted as "decoration").
// Furniture the census legitimately kills — logos, gradient strips, letter-
// heads, contents-page thumbnails — never claims this much page area (those
// sit at a few percent). A repeated image big enough to clear this bar that
// is ACTUALLY full-bleed decoration is still caught downstream by the
// bleed/text-density gates in significantFigureComponents, so keeping it here
// only defers the decision, never forces a decoration through.
// NOTE: relaxes ADR-0009 — re-run the Discovery contents-page corpus to
// confirm those FPs stay demoted (their thumbnails sit well under this bar).
export const REPEATED_IMAGE_KEEP_PAGE_FRACTION = 0.4;

// One fingerprint definition for census builders and the membership check.
export const imageDimsKey = (w, h) => `${w}x${h}`;

// Is this scan xobject a cross-page repeated image (page furniture)?
// `repeatedDims` is the document census (Set of imageDimsKey strings) or
// null/absent when the caller has no document scope — then only the g_
// global-cache prefix can answer.
export function isRepeatedImage(xobject, repeatedDims = null) {
  if (!xobject) return false;
  if (xobject.objId?.startsWith("g_")) return true;
  return !!(
    repeatedDims &&
    xobject.w != null &&
    xobject.h != null &&
    repeatedDims.has(imageDimsKey(xobject.w, xobject.h))
  );
}

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
// packs the paint verb inside its args — the scan reads that verb (args[0])
// and counts the path only when it's one of the bare fill verbs below.
export const FILL_PAINT_OP_NAMES = [
  "constructPath",
  "fill",
  "eoFill",
  "fillStroke",
  "eoFillStroke",
  "closeFillStroke",
  "closeEOFillStroke",
];

// Vertical clustering distance for the chart-band box (vectorChartBox): two
// colored fills whose boxes are within this gap belong to the same figure.
// One inch separates a chart's rows/legend (a few pt apart) from stray brand
// accents elsewhere on the page (headers, sidebars — hundreds of pt away).
export const VECTOR_CHART_CLUSTER_GAP_PT = 72;

// getTextContent items → the { x, y, chars } anchor points the background
// demotion consumes (isBackgroundImage textPoints). One definition so every
// caller (classification, crop framing, decode gating, the Node inspector)
// judges text-over-image identically.
export function textPointsFromItems(items) {
  return (items ?? []).map((it) => ({
    x: it.transform[4],
    y: it.transform[5],
    chars: (it.str?.match(/\S/g) ?? []).length,
  }));
}

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
//   coloredFillBoxes: [{ hue, box }] user-space boxes of those fills, when
//                   the op carries path bounds (v4+ constructPath minMax —
//                   bare fill verbs have no geometry and record no box)
// }
export function scanPageOps(fnArray, argsArray, ops) {
  const vectorOps = opSet(VECTOR_PAINT_OP_NAMES, ops);
  // Bare fill verbs (constructPath handled separately — its args[0] carries
  // the packed paint verb, matched against this same set).
  const fillVerbs = opSet(
    FILL_PAINT_OP_NAMES.filter((n) => n !== "constructPath"),
    ops
  );
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
    coloredFillBoxes: [],
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
      if (fillHue == null) continue;
      if (fn === ops.constructPath) {
        // v4+ packed path: args = [paintVerb, pathData, minMax]. Count only
        // fill verbs (a stroked grid under a lingering fill color is not a
        // symbol), and keep the path bounds through the CTM for the chart
        // band box.
        const a = argsArray[i] ?? [];
        if (!fillVerbs.has(a[0])) continue;
        scan.coloredFills++;
        scan.coloredFillHues[fillHue]++;
        const mm = a[2];
        if (mm && mm.length === 4) {
          scan.coloredFillBoxes.push({
            hue: fillHue,
            box: minMaxBoxThroughCtm(mm, ctm),
          });
        }
      } else if (fillVerbs.has(fn)) {
        // Bare fill verb (older builds): counts, but carries no geometry.
        scan.coloredFills++;
        scan.coloredFillHues[fillHue]++;
      }
    }
  }
  return scan;
}

// Axis-aligned user-space box of a [minX, minY, maxX, maxY] bound through a
// CTM (transform all four corners; rotation-safe).
function minMaxBoxThroughCtm(mm, ctm) {
  const corners = [
    applyTransform(ctm, mm[0], mm[1]),
    applyTransform(ctm, mm[2], mm[1]),
    applyTransform(ctm, mm[0], mm[3]),
    applyTransform(ctm, mm[2], mm[3]),
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

// The multi-hue test hasVectorChartFills applies to the page, applied to one
// cluster's per-hue counts.
function huesQualify(hueCounts, fills) {
  if (fills < VECTOR_CHART_MIN_COLORED_FILLS) return false;
  return (
    hueCounts.filter((c) => c >= VECTOR_CHART_MIN_FILLS_PER_HUE).length >=
    VECTOR_CHART_MIN_HUES
  );
}

// User-space box of the page's vector symbol chart, or null when there isn't
// one the scan can point at confidently. The chart's symbols and legend
// swatches cluster tightly in y; stray chromatic accents (a colored header
// bar, sidebar icons) sit far away. Cluster the colored-fill boxes
// vertically, then require a single cluster to pass the SAME multi-hue gate
// the page did — only then is the box trustworthy enough to crop to. Any
// doubt (no geometry from older builds, accents diluting every cluster,
// a multi-chart page splitting the fills) returns null and the caller keeps
// the whole page — the correctness baseline, exactly as before this box
// existed. Callers should pad the result and widen it to the full page width:
// row labels, column headers and legend text sit left of / above the symbols,
// outside the fills' own bounds.
export function vectorChartBox(scan) {
  if (!hasVectorChartFills(scan)) return null;
  const boxes = scan.coloredFillBoxes ?? [];
  // Geometry must cover (essentially) all counted fills — a partial picture
  // could crop away the uncovered part of the chart.
  if (boxes.length < scan.coloredFills) return null;

  const sorted = [...boxes].sort((a, b) => a.box.y0 - b.box.y0);
  const clusters = [];
  for (const { hue, box } of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && box.y0 - last.y1 <= VECTOR_CHART_CLUSTER_GAP_PT) {
      last.x0 = Math.min(last.x0, box.x0);
      last.y0 = Math.min(last.y0, box.y0);
      last.x1 = Math.max(last.x1, box.x1);
      last.y1 = Math.max(last.y1, box.y1);
      last.fills++;
      last.hueCounts[hue]++;
    } else {
      const hueCounts = new Array(HUE_BUCKETS).fill(0);
      hueCounts[hue]++;
      clusters.push({ ...box, fills: 1, hueCounts });
    }
  }
  const qualifying = clusters.filter((c) => huesQualify(c.hueCounts, c.fills));
  if (qualifying.length !== 1) return null; // none, or ambiguous (two charts)
  const c = qualifying[0];
  return { x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
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
    // Text-density demotion: enough text INSIDE the box, at a per-area rate
    // comparable to the page's own, means the image is a panel the text is
    // printed over (see the constants above for the calibration). Needs the
    // page view for the area comparison.
    if (view && inBox >= BACKGROUND_TEXT_DENSITY_MIN_CHARS) {
      const [vx0, vy0, vx1, vy1] = view;
      const pageArea = (vx1 - vx0) * (vy1 - vy0);
      const area = (box.x1 - box.x0) * (box.y1 - box.y0);
      if (
        area > 0 &&
        pageArea > 0 &&
        inBox / area >= BACKGROUND_TEXT_DENSITY_RATIO * (total / pageArea)
      ) {
        return true;
      }
    }
  }
  return false;
}

// The raster components that read as real figures: figure-sized on the page,
// claiming a real fraction of the page (`pageArea`, pt² — pass it whenever
// page geometry is in hand: retina-resolution logo assets defeat the pixel
// gates and only footprint separates them), not demoted as background art,
// AND — for a component that is a single XObject with intrinsic dims in its
// args — actually pixel-bearing with a sane aspect. (A multi-tile component
// skips the intrinsic tests: each tile is a fragment of the placed artwork,
// so its own pixel dims say nothing about the whole.) This is the one
// definition of "significant figure" — the decode gate builds on it below,
// and classification uses it to decide whether an image is worth surfacing
// the ambiguous prompt for: a logo/strip/icon fails here for the same
// reasons in both places.
//
// `opts` ({ view, textPoints, repeatedDims }, all optional) enables the view
// clamp, the background/text-density demotions, and the cross-page repeated-
// image demotion: full-bleed design art, under-text backdrops and reused
// decoration sets are not figures no matter how big they are (the MSIM-report
// stock photos passed every size gate). Callers without the geometry omit it
// — no clamping, and only the size gates apply.
export function significantFigureComponents(scan, pageArea = null, opts = {}) {
  return figureComponents(
    scan,
    opts.view ?? null,
    opts.repeatedDims ?? null
  ).filter((c) => {
    if (!figureSized(c)) return false;
    if (!claimsPageArea(c, pageArea)) return false;
    if (isBackgroundImage(c, opts)) return false;
    // Flattening debris: many members re-painting the same region
    // (DEBRIS_OVERLAP_RATIO above). Legit compositions partition (~1×).
    if (c.members.length > 1) {
      const sum = c.members.reduce((s, m) => s + boxArea(m.box), 0);
      if (sum >= DEBRIS_OVERLAP_RATIO * boxArea(c)) return false;
    }
    const only = c.members.length === 1 ? c.members[0].xobject : null;
    if (only && only.w != null && only.h != null) {
      if (Math.min(only.w, only.h) < MIN_INTRINSIC_PX) return false;
      if (Math.max(only.w, only.h) / Math.min(only.w, only.h) >
          MAX_INTRINSIC_ASPECT)
        return false;
    }
    return true;
  });
}

// How many of the page's raster components read as real figures (as opposed
// to decoration)? Inline images and masks count too — they're visual content
// even though they can't be decoded standalone.
export function countSignificantImages(scan, pageArea = null, opts = {}) {
  return significantFigureComponents(scan, pageArea, opts).length;
}

export function pageHasSignificantImage(scan, pageArea = null, opts = {}) {
  return countSignificantImages(scan, pageArea, opts) > 0;
}

// The single decodable raster the page's figure content amounts to, or null
// when the page should stay on the crop path. Gates (all must hold):
//   G1 size:  CTM box figure-sized AND intrinsic dims (when known) real
//   G2 shape: intrinsic aspect sane (no banners/strips)
//   G4 raster dominance: negligible vector paint on the page
//   G5 single figure: exactly one significant component, and it IS one
//      XObject (a multi-tile component has no single object to decode)
// plus disqualifiers: any figure-sized non-decodable raster, any tiling op.
// (G3, cross-page repetition, needs document scope — the decoder applies it
// via the g_ global-cache prefix and a dims fingerprint across pages.)
export function decodeCandidate(scan, pageArea = null, opts = {}) {
  if (scan.vectorPaintOps > MAX_VECTOR_PAINT_OPS) return null;
  if (scan.repeats > 0) return null;
  if (scan.otherFigureImages > 0) return null;

  // G1/G2 via the shared significance filter (view clamp and background
  // demotion included when `opts` carries the geometry), plus a resolvable
  // object id. The returned box is the XObject's own unclamped paint box —
  // the decode path re-encodes the object's pixels, not a page region.
  const comps = significantFigureComponents(scan, pageArea, opts);
  if (comps.length !== MAX_DECODABLE_RASTERS) return null;
  const only = comps[0].members.length === 1 ? comps[0].members[0].xobject : null;
  return only?.objId ? only : null;
}
