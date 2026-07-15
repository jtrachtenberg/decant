// Unit tests for icon-key symbol references (ADR 0017): the scan-level
// census (form matrices, clip-tracked shadings, small fills), the key plan
// (legend detection, the one-label rule, the suppression accounting), and
// the reconstruction binding (injected labels emit as each row's own value
// cell, never spliced into its text). Synthetic fixtures shaped like the
// Discovery climate report's phased-disclosure matrix, which drove the
// calibration.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { scanPageOps } from "../src/convert/raster-gate.js";
import {
  symbolComposites,
  symbolKeyPlan,
  symbolLabelItems,
} from "../src/convert/symbol-key.js";
import { reconstructLines, linesToMarkdown } from "../src/convert/classify.js";

// Fake OPS table — arbitrary distinct numbers, mirroring pdfjsLib.OPS's shape
// (same convention as raster-gate.test.mjs).
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  paintImageXObject: 85,
  constructPath: 91,
  shadingFill: 62,
  setFillRGBColor: 58,
  fill: 22,
  stroke: 20,
  endPath: 28,
  clip: 29,
  eoClip: 30,
  paintFormXObjectBegin: 74,
  paintFormXObjectEnd: 75,
};

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

const scanOf = (steps) => {
  const { fnArray, argsArray } = opList(steps);
  return scanPageOps(fnArray, argsArray, OPS);
};

// A filled rect x..x+w, y..y+h: constructPath with a fill verb and minMax.
const fillRect = (x, y, w, h) => [
  ["constructPath", [OPS.fill, [], [x, y, x + w, y + h]]],
];
const setColor = (hex) => [["setFillRGBColor", [hex]]];

// --- Scan census -------------------------------------------------------------

test("form XObject matrices place in-form fills at their page position", () => {
  const scan = scanOf([
    ["save"],
    ["paintFormXObjectBegin", [[1, 0, 0, 1, 500, 300], null]],
    ...setColor("#00b5b0"),
    ...fillRect(0, 0, 12, 12), // form-local; page position is (500,300)
    ["paintFormXObjectEnd", []],
    ["restore"],
  ]);
  assert.equal(scan.smallFills.length, 1);
  assert.deepEqual(scan.smallFills[0].box, { x0: 500, y0: 300, x1: 512, y1: 312 });
  assert.deepEqual(scan.smallFills[0].rgb, [0, 181, 176]);
});

test("shadingFill under an icon-sized clip is recorded; page-sized clip is not", () => {
  const badge = [
    ["save"],
    ["clip"], // pdf.js emits the clip BEFORE its path
    ["constructPath", [OPS.endPath, [], [200, 100, 212, 112]]],
    ["shadingFill", ["pattern_p9_1"]],
    ["restore"],
  ];
  const background = [
    ["save"],
    ["clip"],
    ["constructPath", [OPS.endPath, [], [0, 0, 1000, 600]]],
    ["shadingFill", ["pattern_p9_2"]],
    ["restore"],
  ];
  const scan = scanOf([...background, ...badge]);
  assert.equal(scan.smallShadings.length, 1);
  assert.deepEqual(scan.smallShadings[0].box, { x0: 200, y0: 100, x1: 212, y1: 112 });
});

test("small fills record exact RGB with no chroma gate; coloredFills unchanged", () => {
  const scan = scanOf([
    ...setColor("#4d4d4f"), // achromatic dark — invisible to the chart signal
    ...fillRect(100, 100, 12, 12),
    ...setColor("#00d6fd"), // chromatic
    ...fillRect(100, 200, 20, 20),
    ...fillRect(0, 300, 400, 20), // chromatic but large — not symbol material
  ]);
  assert.equal(scan.smallFills.length, 2);
  assert.deepEqual(scan.smallFills[0].rgb, [77, 77, 79]);
  assert.equal(scan.coloredFills, 2); // both chromatic fills, small or not
});

// --- Key plan ----------------------------------------------------------------

// pdf.js-style text item.
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

// A Discovery-shaped page: a legend column of three textless icon classes
// (teal fill / dark two-paint composite / shading badge) with labels to their
// right, and usages of each in a status column. All chromatic paint is
// icon-sized, so the accounting closes.
function legendFixture() {
  const steps = [
    // Legend column at x=100: y = 200, 180, 160.
    ...setColor("#00b5b0"),
    ...fillRect(100, 200, 12, 12),
    ...setColor("#4d4d4f"),
    ...fillRect(100, 180, 12, 12),
    ...fillRect(103, 183, 6, 6), // the badge's inner mark — same composite
    ["save"],
    ["clip"],
    ["constructPath", [OPS.endPath, [], [100, 160, 112, 172]]],
    ["shadingFill", ["pattern_1"]],
    ["restore"],
    // Usages in a status column at x=500.
    ...setColor("#00b5b0"),
    ...fillRect(500, 300, 12, 12),
    ...fillRect(500, 260, 12, 12),
    ...setColor("#4d4d4f"),
    ...fillRect(500, 220, 12, 12),
    ...fillRect(503, 223, 6, 6),
    ["save"],
    ["clip"],
    ["constructPath", [OPS.endPath, [], [500, 340, 512, 352]]],
    ["shadingFill", ["pattern_1"]],
    ["restore"],
  ];
  const items = [
    item("In progress", 118, 202, { h: 8 }),
    item("Not started", 118, 182, { h: 8 }),
    item("Disclosed", 118, 162, { h: 8 }),
    item("Some row text far from the icons", 200, 302, { h: 10 }),
  ];
  return { scan: scanOf(steps), items };
}

test("legend + usages → keyed entries with closed accounting", () => {
  const { scan, items } = legendFixture();
  const plan = symbolKeyPlan(scan, items);
  assert.ok(plan, "no plan formed");
  assert.equal(plan.suppress, true);
  const byLabel = Object.fromEntries(
    plan.entries.map((e) => [e.label, e.usages.length])
  );
  assert.deepEqual(byLabel, {
    "In progress": 2,
    "Not started": 1,
    Disclosed: 1,
  });
});

test("stacked paints merge into one composite; chained slivers are dropped", () => {
  const steps = [
    ...setColor("#4d4d4f"),
    ...fillRect(100, 100, 12, 12),
    ...fillRect(103, 103, 6, 6), // nested inner mark
    // A gradient strip flattened into abutting slivers: chains past icon size.
    ...setColor("#00d6fd"),
    ...Array.from({ length: 40 }, (_, i) => fillRect(200 + i, 300, 1.2, 20)).flat(),
  ];
  const comps = symbolComposites(scanOf(steps));
  assert.equal(comps.length, 1, "sliver chain must not survive as an icon");
  assert.equal(comps[0].members.length, 2);
});

test("self-labeled repeats (colored bullets) form no key", () => {
  // Every instance has text to its right — no unique legend row exists.
  const steps = [
    ...setColor("#00b5b0"),
    ...fillRect(100, 300, 8, 8),
    ...fillRect(100, 280, 8, 8),
    ...fillRect(100, 260, 8, 8),
  ];
  const items = [
    item("first bullet point", 112, 301, { h: 8 }),
    item("second bullet point", 112, 281, { h: 8 }),
    item("third bullet point", 112, 261, { h: 8 }),
  ];
  assert.equal(symbolKeyPlan(scanOf(steps), items), null);
});

test("scattered 'key' icons (no legend cluster) form no key", () => {
  // The messy-scan map case: two classes, each with one incidentally-labeled
  // instance — but the labeled icons sit nowhere near each other, so no
  // legend list exists.
  const steps = [
    ...setColor("#00b5b0"),
    ...fillRect(100, 500, 12, 12), // labeled
    ...fillRect(400, 200, 12, 12),
    ...setColor("#4d4d4f"),
    ...fillRect(600, 90, 12, 12), // labeled, far from the other
    ...fillRect(250, 350, 12, 12),
  ];
  const items = [
    item("ELBERT COUNTY", 118, 502, { h: 8 }),
    item("Soil-sampling area", 618, 92, { h: 8 }),
  ];
  assert.equal(symbolKeyPlan(scanOf(steps), items), null);
});

test("an unkeyed textless class blocks suppression but not the entries", () => {
  const { items } = legendFixture();
  const steps = [
    // The legend fixture's paint…
    ...setColor("#00b5b0"),
    ...fillRect(100, 200, 12, 12),
    ...fillRect(500, 300, 12, 12),
    ...setColor("#4d4d4f"),
    ...fillRect(100, 180, 12, 12),
    ...fillRect(500, 220, 12, 12),
    // …plus an unexplained repeated textless mark with no label anywhere.
    ...setColor("#888a2f"),
    ...fillRect(700, 400, 10, 10),
    ...fillRect(700, 100, 10, 10),
  ];
  const plan = symbolKeyPlan(scanOf(steps), items);
  assert.ok(plan, "keyed classes must still decode");
  assert.equal(plan.suppress, false, "undecoded repeats must keep the note");
});

test("a large chromatic fill outside any icon blocks suppression", () => {
  const { items } = legendFixture();
  const steps = [
    ...setColor("#00b5b0"),
    ...fillRect(100, 200, 12, 12),
    ...fillRect(500, 300, 12, 12),
    ...setColor("#4d4d4f"),
    ...fillRect(100, 180, 12, 12),
    ...fillRect(500, 220, 12, 12),
    // A real chart's bar: chromatic paint no composite accounts for.
    ...setColor("#c8102e"),
    ...fillRect(300, 50, 200, 40),
  ];
  const plan = symbolKeyPlan(scanOf(steps), items);
  assert.ok(plan);
  assert.equal(plan.suppress, false);
});

// --- Reconstruction binding --------------------------------------------------

test("injected labels emit as each rail-table row's own value cell", () => {
  // A Discovery-shaped leaf: letter chips at x=100, entries at x=118, and
  // injected symbol labels at x=400 — level with their rows. The value column
  // converges hard enough to attract the gutter vote; adopt-left must carry
  // the labels back to their rows instead of splitting them into a stream.
  const rows = [
    ["G", "Board oversight and governance processes", "Disclosed"],
    ["RM", "Risk identification and assessment", "Disclosed"],
    ["S", "Strategy resilience under scenarios", "Not started"],
    ["MT", "Metrics and targets disclosure", "In progress"],
    ["G", "Management role in assessing risk", "In progress"],
    ["S", "Material issues by sector and geography", "Disclosed"],
  ];
  const items = [];
  rows.forEach(([tag, label, status], k) => {
    // 27pt row pitch, like the Discovery panels: wide enough for a paragraph
    // break between rows, tight enough that the rows stay one column block.
    const y = 280 - k * 27;
    items.push(item(tag, 100, y, { w: 12, h: 10 }));
    items.push(item(label, 118, y, { w: 180, h: 10 }));
    items.push({
      str: status,
      width: status.length * 4,
      height: 8,
      transform: [1, 0, 0, 1, 400, y - 1],
      symbolLabel: true,
    });
  });
  const md = linesToMarkdown(reconstructLines(items));
  for (const [tag, label, status] of rows) {
    const row = new RegExp(
      `\\| ${tag} \\| ${label} \\| ${status} \\|`.replace(/[()]/g, "\\$&")
    );
    assert.match(md, row, `row lost its decoded value:\n${md}`);
  }
});

test("panel headings rebind above their own panel's table", () => {
  // Two side-by-side rail-table panels whose headings share one baseline
  // above them (the Discovery phased-disclosure failure): read row-major,
  // "ALPHA" and "BETA" strand at the top and the panels' tables carry no
  // attribution. Rebinding must move each heading directly above its own
  // panel's table — and the two leaves must emit as two tables, not fuse.
  const items = [];
  items.push(item("ALPHA", 100, 350, { w: 40, h: 12 }));
  items.push(item("BETA", 500, 350, { w: 40, h: 12 }));
  // A banner spanning both panels must stay put.
  items.push(
    item("Comparison of the two programme panels overall", 150, 380, { w: 450, h: 10 })
  );
  // Panel baselines partially coincide, like real panel layouts: the shared
  // rows give gutter detection its interior-gap votes, while the offset rows
  // keep the pair from reading as one aligned grid or as a row-corresponding
  // two-column table (both would be a different page genre).
  const panel = (x, offset, names) =>
    names.forEach((name, k) => {
      const y = 280 - k * 27 - (k % 2 ? offset : 0);
      items.push(item(k % 2 ? "G" : "RM", x, y, { w: 12, h: 10 }));
      items.push(item(name, x + 18, y, { w: 170, h: 10 }));
    });
  panel(100, 0, [
    "First panel item about oversight",
    "Second panel item about roles",
    "Third panel item about processes",
    "Fourth panel item about assessment",
    "Fifth panel item about controls",
    "Sixth panel item about reviews",
  ]);
  panel(500, 12, [
    "Opening entry on market issues",
    "Second entry on sector strategy",
    "Third entry on business impact",
    "Fourth entry on metrics used",
    "Fifth entry on emissions data",
    "Sixth entry on progress tracking",
  ]);
  const md = linesToMarkdown(reconstructLines(items));
  const iAlpha = md.indexOf("ALPHA");
  const iFirstA = md.indexOf("| RM | First panel item about oversight |");
  const iBeta = md.indexOf("BETA");
  const iFirstB = md.indexOf("| RM | Opening entry on market issues |");
  assert.ok(iAlpha !== -1 && iFirstA !== -1 && iBeta !== -1 && iFirstB !== -1, md);
  assert.ok(iAlpha < iFirstA, `ALPHA not above its panel:\n${md}`);
  assert.ok(iFirstA < iBeta, `BETA not between the tables:\n${md}`);
  assert.ok(iBeta < iFirstB, `BETA not above its panel:\n${md}`);
  // Two separate tables (two header-separator rows), not one fused table.
  assert.equal(
    (md.match(/^\| --- \| --- \|$/gm) ?? []).length,
    2,
    `leaves fused into one table:\n${md}`
  );
  // The cross-panel banner stayed above everything.
  assert.ok(md.indexOf("Comparison of the two programme panels") < iAlpha);
});

test("a single table's intro text never rebinds (no multi-panel evidence)", () => {
  const items = [item("Quarterly holdings overview", 118, 350, { w: 150, h: 10 })];
  [
    "First holding entry in the list",
    "Second holding entry in the list",
    "Third holding entry in the list",
    "Fourth holding entry in the list",
    "Fifth holding entry in the list",
    "Sixth holding entry in the list",
  ].forEach((name, k) => {
    const y = 280 - k * 27;
    items.push(item(k % 2 ? "G" : "RM", 100, y, { w: 12, h: 10 }));
    items.push(item(name, 118, y, { w: 170, h: 10 }));
  });
  const md = linesToMarkdown(reconstructLines(items));
  // One run → rebinding is a no-op; the intro stays exactly where reading
  // order put it (before the table), no lines dropped or duplicated.
  assert.equal((md.match(/Quarterly holdings overview/g) ?? []).length, 1);
  assert.ok(
    md.indexOf("Quarterly holdings overview") <
      md.indexOf("| RM | First holding entry in the list |"),
    md
  );
});

test("symbolLabelItems place labels at the icon, flagged for reconstruction", () => {
  const { scan, items } = legendFixture();
  const plan = symbolKeyPlan(scan, items);
  const injected = symbolLabelItems(plan);
  assert.equal(injected.length, 4); // 2 + 1 + 1 usages
  for (const it of injected) {
    assert.equal(it.symbolLabel, true);
    assert.ok(typeof it.str === "string" && it.str.length);
    assert.ok(it.transform[4] >= 500, "labels sit at their usage icons");
  }
});
