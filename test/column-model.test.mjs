// Unit tests for the page-level column model (ADR 0030): where a page's
// columns are is decided once, over the whole page, and imposed on every band
// the reconstruction chops the page into.
//
// The pages that drove the calibration are too large to synthesize whole, so
// these fixtures reproduce the SHAPES the census has to tell apart, at the
// level pageColumnModel is asked at:
//
//   - a designed multi-column spread whose widest column holds sub-columns of
//     its own (table-heavy p8, printed page 7) — the sub-columns are real
//     corridors at the wrong level, and eighteen of that page's bands voted
//     for one of them
//   - a full-width banner printed across a real corridor, which must not
//     delete it
//   - ragged single-column prose, whose accidental gaps between short lines
//     must not read as columns (private-novel p11 offered four, and splitting
//     there took the page from 1.00 convergence to 0.56)
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { pageColumnModel, columnRegions } from "../src/convert/classify.js";

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

// Three columns at x=0, 200 and 400, each 150pt wide with a 50pt gutter. Each
// column is set on its OWN leading — 12, 13 and 14pt — which is how designed
// columns really sit (ADR 0029) and what makes them columns rather than a
// table's cells: a band holds runs from one column, not a row across all
// three. Over the bottom half
// the third column is a panel of two narrow sub-columns with a 90pt gap
// between them, WIDER than either of the page's own gutters. That is the shape
// that outvoted the page on table-heavy p8: down there each band's largest
// interior gap is the panel's, so the band votes for a corridor inside one
// column.
function threeColumnPage({ banner = false, subPanel = true } = {}) {
  const boxes = [];
  for (let i = 0; i < 34; i++)
    boxes.push(box("left column running text", 0, 500 - i * 12, { w: 150 }));
  for (let i = 0; i < 31; i++)
    boxes.push(box("middle column running text", 200, 494 - i * 13, { w: 150 }));
  for (let i = 0; i < 29; i++) {
    const y = 488 - i * 14;
    if (subPanel && y <= 300) {
      boxes.push(box("panel a", 400, y, { w: 30 }));
      boxes.push(box("panel b", 520, y, { w: 30 }));
    } else {
      boxes.push(box("right column running text", 400, y, { w: 150 }));
    }
  }
  if (banner) {
    // One full-width heading printed straight across both page corridors.
    boxes.push(box("A HEADING RIGHT ACROSS THE PAGE", 0, 512, { w: 550, h: 14 }));
  }
  return boxes;
}

test("the page's corridors are found, and a column's own sub-corridor is not", () => {
  const model = pageColumnModel(threeColumnPage());
  assert.equal(
    model.length,
    2,
    `expected the two page corridors, got ${model.map((c) => Math.round(c.gx)).join(", ")}`
  );
  // Just left of where each next column starts, findGutter's convention.
  assert.equal(Math.round(model[0].gx), 199);
  assert.equal(Math.round(model[1].gx), 399);
  // The sub-panel corridor at x=450..500 is open over a quarter of the page
  // and is NOT the page's — that is the level distinction the whole census
  // exists to make.
  assert.ok(
    !model.some((c) => c.gx > 440 && c.gx < 500),
    "a corridor inside one column must not enter the page model"
  );
});

test("a banner printed across a corridor does not delete it", () => {
  const model = pageColumnModel(threeColumnPage({ banner: true }));
  assert.equal(model.length, 2);
  assert.equal(Math.round(model[0].gx), 199);
  assert.equal(Math.round(model[1].gx), 399);
});

test("ragged single-column prose offers no page columns", () => {
  // Forty lines of one column, each ending short at a different x — the gaps
  // between line ends and the right margin are corridors by every local
  // measure, and none of them is a column.
  const boxes = [];
  for (let i = 0; i < 40; i++) {
    const y = 500 - i * 12;
    boxes.push(box("a line of ordinary prose", 0, y, { w: 300 + (i % 7) * 8 }));
  }
  assert.deepEqual(pageColumnModel(boxes), []);
});

test("a corridor beside one figure is not the page's", () => {
  // A wide, clean corridor — but only over the bottom quarter of the page.
  const boxes = [];
  for (let i = 0; i < 40; i++) {
    const y = 500 - i * 12;
    if (y <= 140) {
      boxes.push(box("caption left", 0, y, { w: 150 }));
      boxes.push(box("caption right", 300, y, { w: 150 }));
    } else {
      boxes.push(box("full measure body text running right across", 0, y, { w: 450 }));
    }
  }
  assert.deepEqual(pageColumnModel(boxes), []);
});

test("the page's corridor overrules the band's own vote", () => {
  // Three streams, each on its own leading. The widest gap — the one the
  // band's own vote follows — is the RIGHT one, at x≈500; the page's corridor
  // is the narrower left one at x≈300. The page wins.
  const boxes = [];
  for (let i = 0; i < 20; i++)
    boxes.push(box("first stream text", 0, 400 - i * 12, { w: 280 }));
  for (let i = 0; i < 19; i++)
    boxes.push(box("second stream", 320, 394 - i * 13, { w: 140 }));
  for (let i = 0; i < 17; i++)
    boxes.push(box("third", 560, 388 - i * 14, { w: 60 }));

  const ownVote = columnRegions(boxes, null, [], null).gutter;
  assert.equal(Math.round(ownVote), 559, "fixture: the band's own vote is the right gap");
  const imposed = columnRegions(boxes, null, [], [{ a: 285, b: 315, gx: 319 }]).gutter;
  assert.equal(Math.round(imposed), 319);
});

test("the model stands aside inside a table, whose rows straddle every cell edge", () => {
  // A three-column table: every row runs across all three cells, so no row is
  // wholly on either side of a cell boundary. That is what tells a table from
  // a set of columns, and it is the guard that keeps a page corridor from
  // cutting the rows apart — table-heavy p10's tag-rail disclosure table
  // (ADR 0014) came apart when this test was relaxed.
  const boxes = [];
  for (let i = 0; i < 20; i++) {
    const y = 400 - i * 12;
    boxes.push(box("G", 0, y, { w: 12 }));
    boxes.push(box("a disclosure item spelled out here", 200, y, { w: 150 }));
    boxes.push(box("Disclosed", 500, y, { w: 60 }));
  }
  // A corridor between the item and status cells. The table reads exactly as
  // it did without a model: its own chip gutter, not the imposed one.
  const bare = columnRegions(boxes, null, [], null).gutter;
  const withModel = columnRegions(boxes, null, [], [{ a: 355, b: 445, gx: 449 }]).gutter;
  assert.equal(withModel, bare, "a page corridor must not re-cut a table's rows");
  assert.notEqual(Math.round(withModel), 449);
});

test("a band with no page corridor inside it still finds its own", () => {
  // The third column alone. No page corridor is interior to it, so the
  // sub-panel corridor is found by the band's own detection — the level the
  // guarded sub-split exists to reach.
  const page = threeColumnPage();
  const model = pageColumnModel(page);
  const thirdColumn = page.filter((b) => b.x0 >= 400 && b.y0 <= 300);
  const { gutter } = columnRegions(thirdColumn, null, [], model);
  assert.ok(
    gutter != null && gutter > 430 && gutter < 520,
    `expected the panel's own corridor, got ${gutter}`
  );
});

test("the leftmost page corridor is cut first, so one column peels off per cut", () => {
  const page = threeColumnPage({ subPanel: false });
  const model = pageColumnModel(page);
  const { regions, gutter } = columnRegions(page, null, [], model);
  assert.equal(Math.round(gutter), 199);
  // Every region is wholly on one side of the cut, and the left ones hold only
  // the first column — the remainder that recurses is two columns, not three.
  const left = regions.filter((r) => r.every((b) => b.x1 <= gutter));
  assert.ok(left.length, "expected a left region");
  for (const r of left)
    for (const b of r) assert.ok(b.x0 < 200, `${b.g.str} is not in column 1`);
});
