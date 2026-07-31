// Unit tests for row grouping (ADR 0029): which boxes share a printed line.
// A row's reach is its tallest box, so a tall run reaches further down the page
// than the type beside it justifies — and the greedy pass hands it whatever it
// reaches first. Settling gives a contested box to the NEAREST baseline.
// messy-scan p31 drove the calibration, a well-completion figure with drawing
// callouts down the left and a dot-leadered specification list on the right.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  groupRows,
  columnRegions,
  reconstructPage,
  linesToMarkdown,
} from "../src/convert/classify.js";

// A box as toBox() builds one: unrotated, so its height is the type size.
function box(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return {
    x0: x,
    x1: x + w,
    y0: y,
    y1: y + h,
    h,
    rot: false,
    ws: !str.trim().length,
    g: { str, width: w, height: h, transform: [h, 0, 0, h, x, y] },
  };
}

function textOf(row) {
  return row.boxes.map((b) => b.g.str);
}

// p31's contested geometry, as ADR 0025 recorded it: a 10pt callout at 659.8
// reaches 5.0pt down and finds the 8pt spec label 4.7pt below it, while that
// label's own dot leader — 5.4pt below the callout — starts a fresh row.
function p31Rows() {
  return groupRows([
    box("Locking Cap and Padlock", 123, 659.8, { w: 93, h: 10 }),
    box("Protective Casing", 290.3, 655.1, { w: 66, h: 8 }),
    box("..............", 358, 654.4, { w: 33, h: 8 }),
    box('6" x 6" x 5\' steel cover', 392, 654.4, { w: 82, h: 8 }),
  ]);
}

test("a contested run joins the nearer baseline, not the taller reach", () => {
  const rows = p31Rows();
  assert.equal(rows.length, 2, `expected two rows:\n${rows.map(textOf).join("\n")}`);
  assert.deepEqual(textOf(rows[0]), ["Locking Cap and Padlock"]);
  assert.deepEqual(textOf(rows[1]), [
    "Protective Casing",
    "..............",
    '6" x 6" x 5\' steel cover',
  ]);
});

test("a settled row reports the bounds of the boxes it ends up with", () => {
  const [callout, spec] = p31Rows();
  // The callout keeps only itself: 93pt wide, 10pt tall.
  assert.equal(callout.h, 10);
  assert.equal(callout.x1 - callout.x0, 93);
  // The spec row is measured from the label through the value, and its
  // baseline stays the seed's — the leader's, not the label's.
  assert.equal(spec.y0, 654.4);
  assert.equal(spec.x0, 290.3);
  assert.equal(spec.x1, 474);
  assert.equal(spec.h, 8);
});

test("a box already on the nearest baseline is left alone", () => {
  // Ordinary body type: one baseline per line, nothing contested.
  const boxes = [];
  for (let i = 0; i < 5; i++) {
    boxes.push(box("The quick brown fox", 72, 700 - i * 14, { w: 200, h: 10 }));
    boxes.push(box("jumps over", 280, 700 - i * 14, { w: 90, h: 10 }));
  }
  const rows = groupRows(boxes);
  assert.equal(rows.length, 5);
  for (const r of rows) assert.equal(r.boxes.length, 2);
});

test("settling never empties a row or loses a box", () => {
  // Interleaved streams at three type sizes, tight enough that every reach
  // overlaps its neighbours.
  const boxes = [];
  for (let i = 0; i < 12; i++) {
    boxes.push(box(`tall ${i}`, 60, 600 - i * 9, { w: 40, h: 14 }));
    boxes.push(box(`mid ${i}`, 160, 596.2 - i * 9, { w: 40, h: 9 }));
    boxes.push(box(`small ${i}`, 260, 595.4 - i * 9, { w: 40, h: 6 }));
  }
  const rows = groupRows(boxes);
  const seen = rows.flatMap(textOf);
  assert.equal(seen.length, boxes.length, "a box was dropped or duplicated");
  assert.equal(new Set(seen).size, boxes.length);
  for (const r of rows) assert.ok(r.boxes.length > 0, "empty row");
  // Baselines stay monotonically descending, so downstream top-to-bottom
  // walks (column blocks, grid seeds) still read the page in order.
  for (let i = 1; i < rows.length; i++)
    assert.ok(rows[i].y0 < rows[i - 1].y0, "rows out of order");
});

// A page in p31's shape: callouts on the left, a dot-leadered spec list on the
// right, the two streams on independent baselines. `leaderX` detaches the dot
// leaders from their labels, opening a corridor INSIDE the right column.
function wellPage(leaderX = null) {
  const item = (str, x, y, w, h) => ({
    str,
    width: w,
    height: h,
    transform: [h, 0, 0, h, x, y],
  });
  const callouts = [
    ["Locking Cap and Padlock", 123, 93],
    ["Inner Well Cap", 140, 60],
    ["Concrete Pad", 131, 52],
    ["Bentonite Seal", 152, 57],
    ["Filter Pack", 118, 45],
    ["Screen Interval", 144, 62],
    ["Borehole Wall", 136, 55],
    ["Sediment Sump", 129, 57],
  ];
  // Labels start just right of the gutter at 317.4 — except "Protective
  // Casing", outdented to 290.3, which crosses it.
  const specs = [
    ["Protective Casing", 290.3, 66, '6" x 6" x 5\' steel cover'],
    ["Locking Cap and Padlock", 318, 92, "keyed alike"],
    ["Inner Well Cap", 318, 58, "slip fit PVC"],
    ["Riser Pipe", 318, 42, '2" Sch 40 PVC'],
    ["Well Screen", 318, 47, '0.010" slot PVC'],
    ["Filter Sand", 318, 44, "20/40 silica"],
    ["Annular Seal", 318, 48, "bentonite chips"],
    ["Total Depth", 318, 46, "42.5 ft bgs"],
  ];
  const items = [];
  callouts.forEach(([s, x, w], i) => items.push(item(s, x, 659.8 - i * 22, w, 10)));
  specs.forEach(([label, x, w, value], i) => {
    const y = 655.1 - i * 22;
    items.push(item(label, x, y, w, 8));
    // The dot leader fills from the label's right edge to the value, unless
    // leaderX pins it further right.
    const lx = leaderX ?? x + w + 2;
    items.push(
      item(".".repeat(Math.max(1, Math.round((445 - lx) / 2.4))), lx, y - 0.7, 445 - lx, 8)
    );
    items.push(item(value, 447, y - 0.7, 82, 8));
  });
  return { items, specs };
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The whole point of the reach: the spec list is what a reader needs bound
// correctly, and it stays bound through the page pipeline.
test("p31's spec labels keep their own values through reconstruction", () => {
  const { items, specs } = wellPage();
  const md = linesToMarkdown(reconstructPage(items).lines);
  for (const [label, , , value] of specs)
    assert.match(
      md,
      new RegExp(`${esc(label)}\\.+${esc(value)}`),
      `"${label}" lost its value:\n${md}`
    );
});

// ADR 0025's straddler demotion asks whether a run crossing the gutter is
// furniture or one cell of a two-stream row, and answers it from what shares
// the run's line. Settling is exactly what takes that row-mate away: on the
// corpus, "Protective Casing" alone on its settled row read as a banner, the
// span region flushed the accumulated column blocks apart, and messy-scan p31
// dropped from column-major to y-order — callout, spec, callout, spec. The
// question is what is printed AT THIS HEIGHT, so it is asked of the band.
//
// Two columns on independent baselines: callouts down the left, a specification
// list on the right whose first label is outdented across the gutter.
function twoStreamPage() {
  const boxes = [];
  for (let i = 0; i < 8; i++) {
    boxes.push(box(`Callout ${i}`, 123, 659.8 - i * 22, { w: 93, h: 10 }));
    if (i === 0) {
      // The straddler: outdented to cross the gutter, and 4.7pt below the
      // callout but only 0.7pt above its own leader — so settling moves it off
      // the callout's row and it ends up alone on its line.
      boxes.push(box("Protective Casing", 290.3, 655.1, { w: 66, h: 8 }));
      boxes.push(box("..............", 358, 654.4, { w: 33, h: 8 }));
      boxes.push(box('6" x 6" x 5\' steel cover', 392, 654.4, { w: 82, h: 8 }));
    } else {
      boxes.push(box(`Specification ${i}`, 318, 655.1 - i * 22, { w: 200, h: 8 }));
    }
  }
  return boxes;
}

test("a straddler keeps its column when its row-mate is a band away", () => {
  const { regions, gutter } = columnRegions(twoStreamPage());
  assert.ok(gutter !== null && Math.abs(gutter - 317) <= 4, `gutter ${gutter}`);
  // Exactly two streams: the callout column and the specification column. A
  // straddler read as furniture splits into a span plus the column fragments
  // above and below it, and the page then emits in y-order.
  const texts = regions.map((rg) => rg.map((b) => b.g.str));
  assert.equal(
    regions.length,
    2,
    `column blocks fragmented into ${regions.length} regions:\n` +
      texts.map((t) => "  " + t.join(" / ")).join("\n")
  );
  assert.ok(texts[0].includes("Callout 7"), "left column lost a callout");
  assert.ok(
    texts[1].includes("Protective Casing") && texts[1].includes("Specification 7"),
    "the straddler left its own column"
  );
});

// Settling is for printed rows; the gutter is measured over baseline BANDS,
// and must not follow them. On a page whose two streams never share a printed
// line, the only unit that sees the corridor BETWEEN them is the band — settle
// first and findGutter reads each spec line's own label-to-leader spacing
// instead, putting the gutter inside the right column and gluing every callout
// to the label beside it.
test("the gutter stays between the streams, not inside a row", () => {
  for (const leaderX of [null, 370, 380, 390, 400, 412, 420]) {
    const { gutter } = reconstructPage(wellPage(leaderX).items);
    assert.ok(
      gutter !== null && Math.abs(gutter - 317) <= 2,
      `leaderX=${leaderX}: gutter ${gutter} left the corridor between the streams`
    );
  }
});
