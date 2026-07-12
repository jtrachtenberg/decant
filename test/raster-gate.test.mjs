// Unit tests for the standalone raster XObject gate (src/convert/raster-gate.js).
// Pure — each case is a synthetic operator list built against a fake OPS map,
// isolating the gate from pdf.js. The profiles it must separate:
//   - a single big photo XObject          → decode candidate
//   - a vector chart with a raster layer  → null (raster dominance)
//   - gradient strips / icons / logos     → null (intrinsic / CTM size)
//   - collages, tiled images, inline art  → null (single-figure, decodability)
// The asymmetry under test: a false "yes" silently drops vector chart content
// (SPEC §6), a false "no" only costs a photo some sharpness — so ambiguous
// cases must resolve to null.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanPageOps,
  decodeCandidate,
  significantFigureComponents,
  figureComponents,
  clampBoxToView,
  countSignificantImages,
  pageHasSignificantImage,
  MIN_FIGURE_PAGE_FRACTION,
  composeTransform,
  applyTransform,
  VECTOR_PAINT_OP_NAMES,
  NON_DECODABLE_IMAGE_OP_NAMES,
  REPEAT_IMAGE_OP_NAMES,
  FILL_PAINT_OP_NAMES,
  MIN_IMAGE_EDGE_PT,
  MIN_INTRINSIC_PX,
  MAX_INTRINSIC_ASPECT,
  MAX_VECTOR_PAINT_OPS,
  parseFillRGB,
  hueBucket,
  hasVectorChartFills,
  vectorChartBox,
  isBackgroundImage,
  bleedEdgeCount,
  VECTOR_CHART_MIN_COLORED_FILLS,
  VECTOR_CHART_MIN_HUES,
  BACKGROUND_MIN_BLEED_EDGES,
  BACKGROUND_TEXT_FRACTION,
  BACKGROUND_MIN_TEXT_CHARS,
  BACKGROUND_TEXT_DENSITY_MIN_CHARS,
  imageDimsKey,
  isRepeatedImage,
} from "../src/convert/raster-gate.js";
import { IMAGE_OP_NAMES } from "../src/convert/classify.js";

// Fake OPS table — arbitrary distinct numbers, mirroring pdfjsLib.OPS's shape.
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  paintInlineImageXObject: 86,
  paintInlineImageXObjectGroup: 87,
  paintImageXObjectRepeat: 88,
  paintImageMaskXObject: 83,
  constructPath: 91,
  shadingFill: 62,
  setFillRGBColor: 58,
  fill: 22,
  stroke: 20,
};

// Operator-list builder: each step is [opName, args].
function opList(steps) {
  const fnArray = [];
  const argsArray = [];
  for (const [name, args = null] of steps) {
    assert.ok(OPS[name] !== undefined, `unknown fake op ${name}`);
    fnArray.push(OPS[name]);
    argsArray.push(args);
  }
  return { fnArray, argsArray };
}

// An image placed at (x, y) sized w×h pt: the CTM scales the unit square.
const placeImage = (objId, x, y, w, h, iw = 1600, ih = 1200) => [
  ["save"],
  ["transform", [w, 0, 0, h, x, y]],
  ["paintImageXObject", [objId, iw, ih]],
  ["restore"],
];

const scanOf = (steps) => {
  const { fnArray, argsArray } = opList(steps);
  return scanPageOps(fnArray, argsArray, OPS);
};

test("single big photo XObject → candidate with the CTM box", () => {
  const scan = scanOf(placeImage("img_p4_1", 50, 100, 400, 300));
  const cand = decodeCandidate(scan);
  assert.ok(cand);
  assert.equal(cand.objId, "img_p4_1");
  assert.deepEqual(cand.box, { x0: 50, y0: 100, x1: 450, y1: 400 });
  assert.equal(cand.w, 1600);
  assert.equal(cand.h, 1200);
});

test("nested save/restore: the box uses the CTM in force at the paint op", () => {
  const scan = scanOf([
    ["save"],
    ["transform", [2, 0, 0, 2, 0, 0]], // outer 2× scale
    ...placeImage("img_p0_1", 10, 20, 100, 80), // inner placement
    ["restore"],
    // After restore the CTM is identity again; a later icon lands small.
    ...placeImage("img_p0_2", 0, 0, 10, 10),
  ]);
  // Inner image: unit square → [10,20,110,100] locally, ×2 outer → [20,40,220,200].
  assert.deepEqual(scan.xobjects[0].box, { x0: 20, y0: 40, x1: 220, y1: 200 });
  // Icon below MIN_IMAGE_EDGE_PT doesn't disqualify the photo (not "qualifying").
  const cand = decodeCandidate(scan);
  assert.equal(cand?.objId, "img_p0_1");
});

test("vector-heavy page (a chart with a raster layer) → null", () => {
  const paths = Array.from({ length: MAX_VECTOR_PAINT_OPS + 1 }, () => [
    "constructPath",
    [1, [new Float32Array(4)]],
  ]);
  const scan = scanOf([...placeImage("img_p1_1", 0, 0, 400, 300), ...paths]);
  assert.equal(scan.vectorPaintOps, MAX_VECTOR_PAINT_OPS + 1);
  assert.equal(decodeCandidate(scan), null);
  // A handful of vector ops (border rule, caption underline) is fine.
  const light = scanOf([
    ...placeImage("img_p1_1", 0, 0, 400, 300),
    ["constructPath", [1, [new Float32Array(4)]]],
    ["shadingFill", []],
  ]);
  assert.ok(decodeCandidate(light));
});

test("two figure-sized XObjects (collage) → null; exactly one wins", () => {
  const scan = scanOf([
    ...placeImage("img_p2_1", 0, 0, 200, 150),
    ...placeImage("img_p2_2", 250, 0, 200, 150),
  ]);
  assert.equal(decodeCandidate(scan), null);
});

test("gradient strip: big CTM box but tiny intrinsic pixels → null", () => {
  // 2×256px image stretched across half the page — CTM tests alone can't
  // catch this; the intrinsic gates must.
  const strip = scanOf(placeImage("img_p3_1", 0, 0, 300, 400, 2, 256));
  assert.equal(decodeCandidate(strip), null);
  // Banner: real pixels but absurd aspect.
  const banner = scanOf(
    placeImage("img_p3_2", 0, 0, 500, 60, 3000, 3000 / (MAX_INTRINSIC_ASPECT + 2))
  );
  assert.equal(decodeCandidate(banner), null);
  // Boundary sanity: exactly MIN_INTRINSIC_PX on the short edge passes.
  const ok = scanOf(
    placeImage("img_p3_3", 0, 0, 300, 200, MIN_INTRINSIC_PX * 2, MIN_INTRINSIC_PX)
  );
  assert.ok(decodeCandidate(ok));
});

test("unknown intrinsic dims (other pdf.js builds) defer to the decoder", () => {
  // Args without w/h: the geometric gates decide; the decoder re-checks
  // against the resolved object.
  const scan = scanOf([
    ["save"],
    ["transform", [400, 0, 0, 300, 0, 0]],
    ["paintImageXObject", ["img_p5_1"]],
    ["restore"],
  ]);
  const cand = decodeCandidate(scan);
  assert.ok(cand);
  assert.equal(cand.w, null);
});

test("icons/logos only (below MIN_IMAGE_EDGE_PT) → null", () => {
  const scan = scanOf(
    placeImage("img_p6_1", 0, 0, MIN_IMAGE_EDGE_PT - 1, MIN_IMAGE_EDGE_PT - 1)
  );
  assert.equal(decodeCandidate(scan), null);
});

test("a figure-sized inline image or mask disqualifies the page", () => {
  const inline = scanOf([
    ...placeImage("img_p7_1", 0, 0, 400, 300),
    ["save"],
    ["transform", [200, 0, 0, 150, 0, 400]],
    ["paintInlineImageXObject", [{}]],
    ["restore"],
  ]);
  assert.equal(inline.otherFigureImages, 1);
  assert.equal(decodeCandidate(inline), null);

  // A small decorative mask (a glyph stencil) does not.
  const smallMask = scanOf([
    ...placeImage("img_p7_2", 0, 0, 400, 300),
    ["save"],
    ["transform", [10, 0, 0, 10, 0, 0]],
    ["paintImageMaskXObject", [{}]],
    ["restore"],
  ]);
  assert.equal(smallMask.otherFigureImages, 0);
  assert.ok(decodeCandidate(smallMask));
});

test("any image-tiling op (wallpaper/texture) disqualifies the page", () => {
  const scan = scanOf([
    ...placeImage("img_p8_1", 0, 0, 400, 300),
    ["paintImageXObjectRepeat", ["img_p8_2", 1, 1, []]],
  ]);
  assert.equal(scan.repeats, 1);
  assert.equal(decodeCandidate(scan), null);
});

test("significance: real figures count, decoration doesn't", () => {
  // A photo page is significant…
  const photo = scanOf(placeImage("img_p9_1", 0, 0, 400, 300));
  assert.equal(significantFigureComponents(photo).length, 1);
  assert.ok(pageHasSignificantImage(photo));
  // …an icon or a stretched gradient strip is not…
  const icon = scanOf(placeImage("img_p9_2", 0, 0, 20, 20));
  const strip = scanOf(placeImage("img_p9_3", 0, 0, 300, 400, 2, 256));
  assert.ok(!pageHasSignificantImage(icon));
  assert.ok(!pageHasSignificantImage(strip));
  // …and a figure-sized inline image is (visual content, though undecodable).
  const inline = scanOf([
    ["save"],
    ["transform", [300, 0, 0, 200, 0, 0]],
    ["paintInlineImageXObject", [{}]],
    ["restore"],
  ]);
  assert.ok(pageHasSignificantImage(inline));
  assert.equal(decodeCandidate(inline), null); // significant ≠ decodable
});

test("retina-resolution logo: big pixels, tiny footprint → not significant", () => {
  // The field case (Gmail payment-confirmation PDF): a 1601×609px logo asset
  // painted 118×41pt on a US-Letter page — 1% of the page. Every pixel gate
  // passes; only the page-area fraction separates it from a real figure.
  const LETTER = 612 * 792;
  const logo = scanOf(placeImage("img_p0_1", 425, 590, 118, 41, 1601, 609));
  assert.ok(!pageHasSignificantImage(logo, LETTER));
  assert.equal(decodeCandidate(logo, LETTER), null);
  // Without page geometry the area gate is skipped (callers that lack it).
  assert.ok(pageHasSignificantImage(logo));
  // A real chart footprint (300×225pt ≈ 14% of Letter) still qualifies.
  const chart = scanOf(placeImage("img_p0_2", 156, 320, 300, 225));
  assert.ok(pageHasSignificantImage(chart, LETTER));
  assert.ok(decodeCandidate(chart, LETTER));
  // Boundary: a hair over the fraction passes, a hair under fails (sqrt
  // round-trips aren't float-exact, so probe both sides of the line).
  const side = Math.sqrt(MIN_FIGURE_PAGE_FRACTION * LETTER);
  const over = scanOf(placeImage("img_p0_3", 0, 0, side * 1.01, side * 1.01));
  const under = scanOf(placeImage("img_p0_4", 0, 0, side * 0.99, side * 0.99));
  assert.ok(pageHasSignificantImage(over, LETTER));
  assert.ok(!pageHasSignificantImage(under, LETTER));
});

test("inline images respect the page-area gate too", () => {
  const LETTER = 612 * 792;
  const smallInline = scanOf([
    ["save"],
    ["transform", [118, 0, 0, 41, 425, 590]], // logo-sized inline paint
    ["paintInlineImageXObject", [{}]],
    ["restore"],
  ]);
  assert.equal(countSignificantImages(smallInline, LETTER), 0);
  assert.ok(pageHasSignificantImage(smallInline)); // area check skipped
});

test("significance is broader than decodability: a two-photo collage counts", () => {
  const collage = scanOf([
    ...placeImage("img_pA_1", 0, 0, 200, 150),
    ...placeImage("img_pA_2", 250, 0, 200, 150),
  ]);
  assert.equal(significantFigureComponents(collage).length, 2);
  assert.ok(pageHasSignificantImage(collage)); // prompts the user
  assert.equal(decodeCandidate(collage), null); // but stays on the crop path
});

// --- Background/decoration demotion ------------------------------------------

test("full-bleed art (3+ page edges) is decoration, not a figure", () => {
  const A4 = [0, 0, 595, 842];
  // The MSIM field case: a section-divider photo bleeding left, right and top
  // (box from the actual document, 62% of the page).
  const divider = { x0: -1, y0: 321, x1: 596, y1: 843 };
  assert.equal(bleedEdgeCount(divider, A4), 3);
  assert.ok(isBackgroundImage(divider, { view: A4 }));
  // A generous hero image touching top + one side (2 edges) stays a figure.
  const hero = { x0: -1, y0: 400, x1: 400, y1: 843 };
  assert.equal(bleedEdgeCount(hero, A4), 2);
  assert.ok(!isBackgroundImage(hero, { view: A4 }));
  // A margin-respecting chart bleeds nothing.
  const chart = { x0: 60, y0: 300, x1: 500, y1: 700 };
  assert.equal(bleedEdgeCount(chart, A4), 0);
  // Without a view the bleed check is skipped.
  assert.ok(!isBackgroundImage(divider, {}));
});

test("an image the page's text is printed over is a backdrop", () => {
  const box = { x0: 0, y0: 400, x1: 595, y1: 842 };
  const inside = (chars) => ({ x: 100, y: 600, chars });
  const outside = (chars) => ({ x: 100, y: 100, chars });
  // All 100 chars inside → backdrop (the MSIM cover-page case).
  assert.ok(isBackgroundImage(box, { textPoints: [inside(60), inside(40)] }));
  // Half the text outside → real figure territory (a caption inside is fine).
  assert.ok(
    !isBackgroundImage(box, { textPoints: [inside(50), outside(50)] })
  );
  // A bare page number on a photo is too little text to judge by.
  assert.ok(
    !isBackgroundImage(box, {
      textPoints: [inside(BACKGROUND_MIN_TEXT_CHARS - 1)],
    })
  );
  // Fraction boundary: just under the threshold stays a figure.
  const under = Math.ceil(100 * BACKGROUND_TEXT_FRACTION) - 1;
  assert.ok(
    !isBackgroundImage(box, {
      textPoints: [inside(under), outside(100 - under)],
    })
  );
});

test("background demotion flows through significance and decode", () => {
  const A4 = [0, 0, 595, 842];
  const AREA = 595 * 842;
  // Full-bleed photo: passes every size gate, demoted by geometry.
  const scan = scanOf([
    ["save"],
    ["transform", [597, 0, 0, 522, -1, 321]],
    ["paintImageXObject", ["img_p5_1", 2412, 2107]],
    ["restore"],
  ]);
  assert.equal(significantFigureComponents(scan, AREA).length, 1); // no view: old behavior
  assert.equal(significantFigureComponents(scan, AREA, { view: A4 }).length, 0);
  assert.ok(!pageHasSignificantImage(scan, AREA, { view: A4 }));
  assert.equal(decodeCandidate(scan, AREA, { view: A4 }), null);
  // Inline images respect the demotion too.
  const inline = scanOf([
    ["save"],
    ["transform", [597, 0, 0, 522, -1, 321]],
    ["paintInlineImageXObject", [{}]],
    ["restore"],
  ]);
  assert.equal(countSignificantImages(inline, AREA, { view: A4 }), 0);
  assert.equal(countSignificantImages(inline, AREA), 1);
});

test("a text-backed panel texture is a backdrop (density demotion)", () => {
  const A4 = [0, 0, 595, 842]; // page area 500,990 pt²
  // A callout-box texture: 12% of the page (the Discovery panels ran 6–23%).
  const box = { x0: 100, y0: 100, x1: 300, y1: 400 };
  const inside = (chars) => ({ x: 150, y: 200, chars });
  const outside = (chars) => ({ x: 500, y: 800, chars });
  // Body text over the panel at ~1.7× the page's own density → backdrop.
  // (Well under the 85% whole-page fraction — that check never sees panels.)
  assert.ok(
    isBackgroundImage(box, {
      view: A4,
      textPoints: [inside(400), outside(1600)],
    })
  );
  // The same chars inside a text-DENSE page (a caption-scale share) → figure.
  assert.ok(
    !isBackgroundImage(box, {
      view: A4,
      textPoints: [inside(400), outside(19600)],
    })
  );
  // Below the char floor nothing fires, however dense the box reads.
  assert.ok(
    !isBackgroundImage(box, {
      view: A4,
      textPoints: [inside(BACKGROUND_TEXT_DENSITY_MIN_CHARS - 1), outside(700)],
    })
  );
  // Density needs the page view for the area comparison.
  assert.ok(
    !isBackgroundImage(box, { textPoints: [inside(400), outside(1600)] })
  );
});

test("cross-page repeated images are furniture, not figures", () => {
  const A4 = [0, 0, 595, 842];
  const AREA = 595 * 842;
  // The Discovery contents page: a background-art set painted with page-local
  // ids on the FIRST page it decorates — only the document census (matching
  // intrinsic dims on other pages) can demote it there.
  const first = scanOf([
    ...placeImage("img_p1_234", 0, 252, 367, 343, 775, 984),
    ...placeImage("img_p1_236", 0, 100, 300, 150, 775, 214),
  ]);
  const census = new Set([imageDimsKey(775, 984), imageDimsKey(775, 214)]);
  assert.equal(significantFigureComponents(first, AREA, { view: A4 }).length, 1);
  assert.equal(
    significantFigureComponents(first, AREA, { view: A4, repeatedDims: census })
      .length,
    0
  );
  // Later pages reference the same art through pdf.js's global cache: the g_
  // prefix demotes with no census at all.
  assert.ok(isRepeatedImage({ objId: "g_d0_img_p9_142", w: 543, h: 690 }));
  const cached = scanOf(
    placeImage("g_d0_img_p9_142", 100, 100, 400, 300, 543, 690)
  );
  assert.equal(significantFigureComponents(cached, AREA, { view: A4 }).length, 0);
  // A one-off photo abutting a decoration tile: the tile is dropped BEFORE
  // component merging, so the photo survives with its own box — a crop frames
  // the photo, not the pair.
  const mixed = scanOf([
    ...placeImage("img_p3_141", 60, 60, 300, 250, 585, 514), // unique photo
    ...placeImage("img_p3_137", 361, 60, 200, 250, 642, 591), // repeated tile
  ]);
  const tileCensus = new Set([imageDimsKey(642, 591)]);
  const comps = significantFigureComponents(mixed, AREA, {
    view: A4,
    repeatedDims: tileCensus,
  });
  assert.equal(comps.length, 1);
  assert.equal(comps[0].members[0].xobject.objId, "img_p3_141");
  assert.equal(comps[0].x1, 360);
  // Decode gating inherits the demotion through the same opts.
  assert.equal(
    decodeCandidate(mixed, AREA, { view: A4, repeatedDims: tileCensus })?.objId,
    "img_p3_141"
  );
});

// --- Tiled/full-bleed art reassembly -----------------------------------------

test("clampBoxToView trims off-page paint; fully off-page → null", () => {
  const A4 = [0, 0, 595, 842];
  assert.deepEqual(
    clampBoxToView({ x0: -100, y0: 700, x1: 300, y1: 900 }, A4),
    { x0: 0, y0: 700, x1: 300, y1: 842 }
  );
  assert.equal(clampBoxToView({ x0: -400, y0: 0, x1: -10, y1: 500 }, A4), null);
  const inside = { x0: 50, y0: 50, x1: 100, y1: 100 };
  assert.deepEqual(clampBoxToView(inside, A4), inside);
});

test("abutting tiles merge into one component; a gap keeps them apart", () => {
  const twoTiles = scanOf([
    ...placeImage("img_p0_1", 0, 0, 200, 300),
    ...placeImage("img_p0_2", 201, 0, 200, 300), // 1pt gap: same artwork
  ]);
  assert.equal(figureComponents(twoTiles).length, 1);
  const apart = scanOf([
    ...placeImage("img_p0_3", 0, 0, 200, 300),
    ...placeImage("img_p0_4", 250, 0, 200, 300), // 50pt gutter: two figures
  ]);
  assert.equal(figureComponents(apart).length, 2);
});

test("the Discovery field case: 2×2 background tiles overhanging the page", () => {
  // Each tile bleeds ≤2 edges (the demotion needs 3) and passes every size
  // gate — judged alone, four significant figures. Clamped and merged, the
  // component bleeds left+top+bottom and demotes as full-bleed art.
  const VIEW = [0, 0, 1054, 595];
  const AREA = 1054 * 595;
  const tiles = scanOf([
    ...placeImage("img_p2_3", -314, 168, 479, 442, 953, 878),
    ...placeImage("img_p2_4", 163, 95, 406, 515, 806, 1024),
    ...placeImage("img_p2_5", -314, -15, 479, 185, 953, 368),
    ...placeImage("img_p2_6", 163, -15, 406, 112, 806, 222),
  ]);
  const comps = figureComponents(tiles, VIEW);
  assert.equal(comps.length, 1);
  assert.equal(comps[0].members.length, 4);
  assert.ok(bleedEdgeCount(comps[0], VIEW) >= BACKGROUND_MIN_BLEED_EDGES);
  assert.equal(countSignificantImages(tiles, AREA, { view: VIEW }), 0);
  assert.equal(decodeCandidate(tiles, AREA, { view: VIEW }), null);
});

test("a figure painted ON full-bleed art is not swallowed by the merge", () => {
  // Containment blocks the merge: the backdrop demotes alone (4 edges), the
  // chart inside it survives as its own significant, decodable component.
  const A4 = [0, 0, 595, 842];
  const AREA = 595 * 842;
  const scan = scanOf([
    ...placeImage("img_p1_1", -5, -5, 605, 852), // full-page backdrop
    ...placeImage("img_p1_2", 100, 300, 350, 300), // chart on top
  ]);
  const comps = significantFigureComponents(scan, AREA, { view: A4 });
  assert.equal(comps.length, 1);
  assert.equal(comps[0].members[0].xobject.objId, "img_p1_2");
  assert.equal(decodeCandidate(scan, AREA, { view: A4 })?.objId, "img_p1_2");
});

test("a merged multi-tile component is significant but never decodable", () => {
  // Two abutting tiles well inside the margins: real figure content (a
  // panorama placed as two slices) — attach and crop, but there is no single
  // XObject to decode.
  const A4 = [0, 0, 595, 842];
  const AREA = 595 * 842;
  const scan = scanOf([
    ...placeImage("img_p3_1", 100, 300, 200, 250),
    ...placeImage("img_p3_2", 301, 300, 200, 250),
  ]);
  assert.equal(countSignificantImages(scan, AREA, { view: A4 }), 1);
  assert.equal(decodeCandidate(scan, AREA, { view: A4 }), null);
});

// --- Vector-chart fill signal -------------------------------------------------

test("parseFillRGB handles CSS hex strings, floats and 0–255 components", () => {
  assert.deepEqual(parseFillRGB(["#199050"]), [0x19, 0x90, 0x50]);
  assert.deepEqual(parseFillRGB([1, 0.5, 0]), [255, 128, 0]);
  assert.deepEqual(parseFillRGB([240, 195, 25]), [240, 195, 25]);
  assert.equal(parseFillRGB(["not-a-color"]), null);
  assert.equal(parseFillRGB(null), null);
});

test("hueBucket separates a categorical palette, rejects neutrals", () => {
  const red = hueBucket(parseFillRGB(["#a61e22"]));
  const yellow = hueBucket(parseFillRGB(["#f0c319"]));
  const green = hueBucket(parseFillRGB(["#199050"]));
  const blue = hueBucket(parseFillRGB(["#005c90"]));
  // The MSIM risk-matrix palette lands in four distinct buckets.
  assert.equal(new Set([red, yellow, green, blue]).size, 4);
  // Black text, gray rules, near-white bands: no bucket.
  assert.equal(hueBucket(parseFillRGB(["#000000"])), null);
  assert.equal(hueBucket(parseFillRGB(["#8b8e90"])), null);
  assert.equal(hueBucket(parseFillRGB(["#e2e9ed"])), null);
  assert.equal(hueBucket(null), null);
});

// N fills under the given hex color.
const coloredFills = (hex, n) => [
  ["setFillRGBColor", [hex]],
  ...Array.from({ length: n }, () => ["fill", []]),
];

test("a symbol chart's fills (many, multi-hue) read as a vector chart", () => {
  // The MSIM risk matrix: green/yellow/red cells plus blue header accents.
  const scan = scanOf([
    ...coloredFills("#199050", 6),
    ...coloredFills("#f0c319", 8),
    ...coloredFills("#a61e22", 7),
    ...coloredFills("#005c90", 3),
  ]);
  assert.equal(scan.coloredFills, 24);
  assert.ok(hasVectorChartFills(scan));
});

test("single-hue decoration never reads as a vector chart, however busy", () => {
  // The clean-text field case: 163 brand-colored fills, ONE hue family.
  const scan = scanOf([
    ...coloredFills("#005c90", 100),
    ...coloredFills("#009bda", 63), // nearby blue: same/adjacent bucket, still <3 hues
    ...coloredFills("#000000", 50), // neutrals never count
  ]);
  assert.ok(scan.coloredFills >= VECTOR_CHART_MIN_COLORED_FILLS);
  assert.ok(!hasVectorChartFills(scan));
});

test("a sparse multicolor page (cover art, a few icons) stays quiet", () => {
  const scan = scanOf([
    ...coloredFills("#199050", 2),
    ...coloredFills("#f0c319", 2),
    ...coloredFills("#a61e22", 2),
  ]);
  assert.ok(scan.coloredFills < VECTOR_CHART_MIN_COLORED_FILLS);
  assert.ok(!hasVectorChartFills(scan));
  // Many fills but only two hues clearing the per-hue floor: still quiet.
  const twoHue = scanOf([
    ...coloredFills("#199050", 10),
    ...coloredFills("#a61e22", 10),
    ...coloredFills("#f0c319", 1), // below the per-hue floor
  ]);
  assert.ok(!hasVectorChartFills(twoHue));
});

// A v4+ packed path: constructPath carrying its paint verb and bounds.
const packedPath = (verb, x0, y0, x1, y1) => [
  ["constructPath", [OPS[verb], [new Float32Array(0)], new Float32Array([x0, y0, x1, y1])]],
];
// A w×h chromatic symbol at (x, y).
const symbol = (hex, x, y, w = 10, h = 10) => [
  ["setFillRGBColor", [hex]],
  ...packedPath("fill", x, y, x + w, y + h),
];

test("constructPath counts by its packed verb; fills record CTM'd boxes", () => {
  // A stroked grid under a lingering chromatic fill color is not a symbol.
  const strokes = scanOf([
    ["setFillRGBColor", ["#199050"]],
    ...packedPath("stroke", 0, 0, 500, 0),
    ...packedPath("stroke", 0, 20, 500, 20),
  ]);
  assert.equal(strokes.coloredFills, 0);
  // A fill verb counts and carries its bounds — through the CTM in force.
  const scan = scanOf([
    ["save"],
    ["transform", [2, 0, 0, 2, 10, 10]],
    ...symbol("#199050", 5, 5),
    ["restore"],
  ]);
  assert.equal(scan.coloredFills, 1);
  assert.deepEqual(scan.coloredFillBoxes[0].box, { x0: 20, y0: 20, x1: 40, y1: 40 });
});

test("vectorChartBox finds the symbol cluster, ignores far accents", () => {
  // The MSIM page-12 shape: a compact symbol grid + legend low on the page,
  // a few chromatic brand accents far above. The box is the grid's, not the
  // union's.
  const grid = [];
  const palette = ["#199050", "#f0c319", "#a61e22"];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      grid.push(...symbol(palette[(row + col) % 3], 150 + col * 70, 80 + row * 25));
    }
  }
  const scan = scanOf([
    ...symbol("#005c90", 40, 780, 200, 20), // header accent, far away
    ...grid,
  ]);
  assert.ok(hasVectorChartFills(scan));
  const box = vectorChartBox(scan);
  assert.ok(box);
  assert.ok(box.y1 <= 80 + 4 * 25 && box.y0 >= 80, `band ${box.y0}–${box.y1}`);
  assert.ok(box.y1 < 700, "accent excluded");
});

test("vectorChartBox declines when it can't point at ONE confident cluster", () => {
  // Bare fill verbs (older builds): the gate fires but there's no geometry.
  const bare = scanOf([
    ...coloredFills("#199050", 6),
    ...coloredFills("#f0c319", 6),
    ...coloredFills("#a61e22", 6),
  ]);
  assert.ok(hasVectorChartFills(bare));
  assert.equal(vectorChartBox(bare), null);
  // Two qualifying clusters (a two-chart page): ambiguous, whole page.
  const chartAt = (yBase) => {
    const fills = [];
    for (let i = 0; i < 12; i++) {
      fills.push(
        ...symbol(["#199050", "#f0c319", "#a61e22"][i % 3], 100 + i * 12, yBase + (i % 4) * 20)
      );
    }
    return fills;
  };
  const twoCharts = scanOf([...chartAt(100), ...chartAt(600)]);
  assert.ok(hasVectorChartFills(twoCharts));
  assert.equal(vectorChartBox(twoCharts), null);
  // Not a chart page at all: no box either.
  assert.equal(vectorChartBox(scanOf(symbol("#199050", 0, 0))), null);
});

test("fill color rides save/restore and stroke ops don't count as fills", () => {
  const scan = scanOf([
    ["setFillRGBColor", ["#199050"]],
    ["save"],
    ["setFillRGBColor", ["#000000"]], // neutral inside the saved state
    ["fill", []], // doesn't count
    ["restore"], // green is current again
    ["fill", []], // counts
    ["stroke", []], // stroke never applies fill color
  ]);
  assert.equal(scan.coloredFills, 1);
  assert.equal(hasVectorChartFills(scan), false);
});

test("matrix helpers follow PDF's row-vector convention", () => {
  const scaled = composeTransform([1, 0, 0, 1, 10, 20], [2, 0, 0, 2, 0, 0]);
  assert.deepEqual(applyTransform(scaled, 1, 1), [22, 42]);
});

// --- OPS-name pins against the installed pdf.js build -----------------------
// Every name the extension maps through pdfjsLib.OPS must exist there — a
// misspelled or renamed op silently resolves to undefined and its signal
// vanishes (this exact bug shipped as "paintInlineImage" in IMAGE_OP_NAMES).
test("all OPS names resolve in the installed pdfjs-dist build", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const names = [
    ...IMAGE_OP_NAMES,
    ...NON_DECODABLE_IMAGE_OP_NAMES,
    ...REPEAT_IMAGE_OP_NAMES,
    "constructPath", // the v4+ packed-path op the vector count relies on
    "shadingFill",
    "save",
    "restore",
    "transform",
    "paintImageXObject",
    "setFillRGBColor", // the colored-fill (vector chart) signal's color source
  ];
  for (const name of names) {
    assert.notEqual(pdfjs.OPS[name], undefined, `OPS.${name} missing`);
  }
  // The bare paint verbs are intentionally tolerated as absent (older builds
  // only) — opSet() drops undefined — but at least one vector op must map.
  assert.ok(VECTOR_PAINT_OP_NAMES.some((n) => pdfjs.OPS[n] !== undefined));
  assert.ok(FILL_PAINT_OP_NAMES.some((n) => pdfjs.OPS[n] !== undefined));
});
