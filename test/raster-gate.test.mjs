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
  composeTransform,
  applyTransform,
  VECTOR_PAINT_OP_NAMES,
  NON_DECODABLE_IMAGE_OP_NAMES,
  REPEAT_IMAGE_OP_NAMES,
  MIN_IMAGE_EDGE_PT,
  MIN_INTRINSIC_PX,
  MAX_INTRINSIC_ASPECT,
  MAX_VECTOR_PAINT_OPS,
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
  ];
  for (const name of names) {
    assert.notEqual(pdfjs.OPS[name], undefined, `OPS.${name} missing`);
  }
  // The bare paint verbs are intentionally tolerated as absent (older builds
  // only) — opSet() drops undefined — but at least one vector op must map.
  assert.ok(VECTOR_PAINT_OP_NAMES.some((n) => pdfjs.OPS[n] !== undefined));
});
