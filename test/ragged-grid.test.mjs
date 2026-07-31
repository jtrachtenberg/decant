// Unit tests for ragged-grid binding (ADR 0027): a table whose rows do not all
// fill every column still reads row-major, its columns are derived from the
// whole run rather than from one row, and the prose guard that stands between
// a table and a page of columns is rebuilt on evidence that survives the
// absorption. Synthetic glyph items, no PDFs — the decantCC corpus drove the
// calibration (table-heavy p32, public-famous p17, table-heavy p11).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructLines, linesToMarkdown } from "../src/convert/classify.js";

// Build a pdf.js-style text item. y is page coordinate (larger = higher).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

// A cell set FLUSH RIGHT against `edge`, as a column of figures is: its start
// moves with the width of its own value, which is the alignment the band
// derivation has to absorb.
function rightCell(str, edge, y) {
  const w = str.length * 5;
  return item(str, edge - w, y, { w });
}

const EDGES = [300, 380, 460, 540];

test("a column that carries a value on total rows only still binds its years", () => {
  // table-heavy p32: "% Change" is stated on the total rows and left empty on
  // the rest, so no three consecutive rows ever share a band set. Every short
  // row used to pack its values LEFT, shifting each year one column over.
  const items = EDGES.map((edge, c) =>
    rightCell(["FY2024", "%Chnge", "FY2023", "FY2022"][c], edge, 400)
  );
  items.push(item("Item", 40, 400));
  const rows = [
    ["Mobile combustion", ["94211", null, "95122", "86433"]],
    ["Stationary combust", ["75044", null, "54355", "49266"]],
    ["Refrigerant gases", ["50877", null, "32088", "25599"]],
    ["Total Scope 1", ["28552", "(4%)", "30589", "30012"]],
    ["Purchased electric", ["26352", null, "28862", "28569"]],
    ["Employee commute", ["12610", null, "11974", "70110"]],
    ["Total Scope 3", ["31685", "11%", "23230", "77800"]],
  ];
  rows.forEach(([label, vals], r) => {
    const y = 380 - r * 14;
    items.push(item(label, 40, y));
    vals.forEach((v, c) => {
      if (v) items.push(rightCell(v, EDGES[c], y));
    });
  });
  const md = linesToMarkdown(reconstructLines(items));
  // Every historical figure under its own year, and the sparse column empty
  // where the page leaves it empty.
  assert.match(
    md,
    /\| Mobile combustion \| 94211 \|\s+\| 95122 \| 86433 \|/,
    `short row's values shifted:\n${md}`
  );
  assert.match(
    md,
    /\| Total Scope 1 \| 28552 \| \(4%\) \| 30589 \| 30012 \|/,
    `total row lost its % Change:\n${md}`
  );
  // The row labels are a column of the table, not a list stranded above it.
  assert.doesNotMatch(
    md,
    /^Mobile combustion$/m,
    `row label stranded outside the table:\n${md}`
  );
});

test("a heading set flush left over figures set flush right lands on its column", () => {
  // The seed row's starts describe the columns only as that row sets them. A
  // header label is wider than its figures, so it begins left of them; matching
  // on one row's starts files it one column across. The bands are re-derived
  // from every row the run collected, which recovers each column's left edge.
  const items = [
    item("Region", 40, 400),
    rightCell("FY2024", 300, 400),
    rightCell("FY2023", 380, 400),
  ];
  [
    ["North", "9000", "12500"],
    ["South", "11000", "800"],
    ["East", "440", "99000"],
    ["West", "70000", "1200"],
  ].forEach(([label, a, b], r) => {
    const y = 380 - r * 14;
    items.push(item(label, 40, y));
    items.push(rightCell(a, 300, y));
    items.push(rightCell(b, 380, y));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(
    md,
    /\| Region \| FY2024 \| FY2023 \|/,
    `header not aligned over its own figures:\n${md}`
  );
  assert.match(md, /\| North \| 9000 \| 12500 \|/, md);
  assert.match(md, /\| West \| 70000 \| 1200 \|/, md);
});

test("a cell that took two lines to set arrives as one cell", () => {
  // public-famous p17: an 18pt row pitch with 10pt inside a wrapped cell.
  const items = [];
  const push = (y, cells) =>
    cells.forEach((t, i) => t && items.push(item(t, [40, 200, 340][i], y)));
  push(400, [null, "Preferred Stock", "Common Stock"]);
  push(370, ["Voting Rights", "Does not vote", "May vote"]);
  push(352, ["Callable", "May be callable", "Not callable"]);
  push(334, ["Dividends", "Fixed dividend", "Variable dividend"]);
  push(316, ["Seniority of", "Priority over", "Lowest claim to"]);
  push(306, ["Dividend", "common stock", "dividend"]); // the wrap
  push(288, ["Convertible", "May be convertible", "Not convertible"]);
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(
    md,
    /\| Seniority of Dividend \| Priority over common stock \| Lowest claim to dividend \|/,
    `wrapped cell not merged:\n${md}`
  );
  // The heading row joins the table it names, with an empty corner cell.
  assert.match(md, /\|\s+\| Preferred Stock \| Common Stock \|/, md);
});

test("two figures on consecutive baselines are two values, never one wrapped cell", () => {
  // A table of figures whose group labels fall on some rows only leaves the
  // best-filled rows scattered, so its measured pitch is several rows wide and
  // every line of it reads as tight spacing. Only the values themselves say
  // otherwise: a number is complete where it ends.
  const items = [
    item("Item", 60, 400),
    rightCell("FY2024", 300, 400),
    rightCell("FY2023", 380, 400),
  ];
  const rows = [
    ["Scope 1", "Fuels", "76860", "88680"],
    [null, "Paper", "47000", "52000"],
    [null, "Water", "83000", "85000"],
    ["Scope 2", "Waste", "43000", "44000"],
    [null, "Travel", "61800", "41820"],
    [null, "Commute", "12610", "13868"],
    ["Scope 3", "Franchise", "58600", "61300"],
  ];
  rows.forEach(([group, label, a, b], r) => {
    const y = 386 - r * 11;
    if (group) items.push(item(group, 8, y));
    items.push(item(label, 60, y));
    items.push(rightCell(a, 300, y));
    items.push(rightCell(b, 380, y));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(md, /\| Fuels \| 76860 \| 88680 \|/, `rows merged:\n${md}`);
  assert.match(md, /\| Paper \| 47000 \| 52000 \|/, md);
  assert.doesNotMatch(
    md,
    /76860 47000/,
    `two values glued into one cell:\n${md}`
  );
});

test("a section heading inside a table is carried, not dropped", () => {
  // clean-text p10: "DEPOSIT LIABILITY" is set flush left of the line items it
  // covers, at an x no other row uses. A band set derived only from the rows
  // that fill the columns has no band there, and gridLines drops the text as a
  // floating box beside the table.
  const items = [
    item("Item", 60, 400),
    rightCell("2004", 300, 400),
    rightCell("2003", 380, 400),
  ];
  const rows = [
    ["Accounts payable", 60, "11000", "12000"],
    ["Taxes payable", 60, "21000", "22000"],
    ["DEPOSIT LIABILITY", 30, null, null],
    ["Tenant deposits", 60, "31000", "32000"],
    ["Mortgage payable", 60, "41000", "42000"],
  ];
  rows.forEach(([label, x, a, b], r) => {
    const y = 380 - r * 14;
    items.push(item(label, x, y));
    if (a) items.push(rightCell(a, 300, y));
    if (b) items.push(rightCell(b, 380, y));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(md, /DEPOSIT LIABILITY/, `section heading dropped:\n${md}`);
  assert.match(md, /\| Tenant deposits \| 31000 \| 32000 \|/, md);
});

test("an annotation set larger than the table it points at is kept, not dropped", () => {
  // public-famous p25: a page teaching how to read an income statement sets the
  // statement itself at 4pt — a prop, deliberately too small to read — and
  // annotates it from both margins at 9pt. The annotations are the page's
  // subject. gridLines drops boxes that float beside a grid, which is right for
  // a chart's axis labels (furniture, set at or below the size of what it
  // annotates) and exactly backwards here.
  const items = [
    item("Item", 200, 400, { h: 4 }),
    item("2004", 275, 400, { h: 4, w: 20 }),
    item("2003", 355, 400, { h: 4, w: 20 }),
  ];
  [
    ["Net sales", "76505", "72500"],
    ["Cost of sales", "53500", "51700"],
    ["Gross margin", "23005", "20800"],
    ["Operating income", "10519", "73500"],
  ].forEach(([label, a, b], r) => {
    const y = 392 - r * 8;
    items.push(item(label, 200, y, { h: 4 }));
    items.push(item(a, 275, y, { h: 4, w: 20 }));
    items.push(item(b, 355, y, { h: 4, w: 20 }));
  });
  // A margin note down each side, on the table's own baselines.
  ["Net Income", "The difference", "between revenues", "and outlays"].forEach(
    (t, i) => items.push(item(t, 40, 392 - i * 8, { h: 9, w: 90 }))
  );
  ["Usually consists", "of cost of sales", "and selling,", "general expenses"].forEach(
    (t, i) => items.push(item(t, 440, 392 - i * 8, { h: 9, w: 90 }))
  );
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(md, /\| Net sales \| 76505 \| 72500 \|/, `table lost:\n${md}`);
  for (const t of [
    "The difference",
    "between revenues",
    "and outlays",
    "of cost of sales",
    "general expenses",
  ])
    assert.ok(md.includes(t), `annotation dropped: "${t}"\n${md}`);
  // ...and the two margins are separate notes, not each other's table columns.
  assert.doesNotMatch(
    md,
    /\| The difference \| of cost of sales \|/,
    `opposite margins welded into one table:\n${md}`
  );
});

test("a column that keeps setting lines past the aligned run is a page column", () => {
  // table-heavy p11: side-by-side committee descriptions line up for the few
  // baselines they all happen to share, then each keeps going on its own for
  // another ten. Absorbing the ragged rows makes the whole page one run, so
  // the tell can no longer be "the run is a slice with rows around it" — it is
  // how far past the run each column reaches.
  const items = [];
  const COLS = [40, 240, 440, 640];
  // Six baselines every column sets — the aligned run.
  for (let k = 0; k < 6; k++) {
    const y = 400 - k * 14;
    COLS.forEach((x, c) =>
      items.push(item(`col ${c} line ${k} ends here.`, x, y, { w: 150 }))
    );
  }
  // ...then the three right-hand columns keep going, to different depths.
  for (let k = 6; k < 16; k++) {
    const y = 400 - k * 14;
    COLS.slice(1).forEach((x, c) => {
      if (k < 10 + c * 2)
        items.push(item(`col ${c + 1} line ${k} ends here.`, x, y, { w: 150 }));
    });
  }
  const md = linesToMarkdown(reconstructLines(items));
  assert.doesNotMatch(md, /\|/, `page columns formalized as a table:\n${md}`);
});
