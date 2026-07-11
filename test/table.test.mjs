// Tests for geometry-based table reconstruction (classify.js): a golden test
// against the real fidelity-brief fixture (Deliverable 1), plus synthetic
// tests for grid detection and the low-structural-confidence marker
// (Deliverable 2).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { reconstructPage, linesToMarkdown } from "../src/convert/classify.js";

// pdf.js-style text item (mirrors structure.test.mjs).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

async function fixtureMarkdown(name) {
  const buf = await readFile(new URL(`./fixtures/tables/${name}`, import.meta.url));
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let gutter = null;
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const { lines, gutter: g } = reconstructPage(content.items, gutter);
    gutter = g;
    pages.push(linesToMarkdown(lines));
  }
  return pages.join("\n\n");
}

const CANONICAL_TABLE = [
  "| Account | Number | Notes |",
  "| --- | --- | --- |",
  "| Rollover IRA (the claim) | Y90901256 | ≈$470k; passes by beneficiary designation, outside trust |",
  "| Trust: Under Agreement | Z73675350 | $104,220.14; trustee-controlled (Sandra L. Hill) |",
  "| Trust: Under Agreement | Y97210273 | $89,409.24; trustee-controlled |",
  "| Ghost account (item 36) | Y01237817 | Renumbered, closed, or mislabel — confirm |",
].join("\n");

test("fidelity brief: table reconstructs cell-for-cell, row bindings correct", async () => {
  const md = await fixtureMarkdown("fidelity_call_brief.pdf");
  assert.ok(md.includes(CANONICAL_TABLE), "canonical pipe table not found in output:\n" + md);
});

test("fidelity brief: prose and bullets stay lossless; no low-confidence marker", async () => {
  const md = await fixtureMarkdown("fidelity_call_brief.pdf");
  assert.match(md, /### Have at the ready/);
  assert.match(md, /Certified death certificate/);
  assert.match(md, /CARDINAL RULE:/);
  assert.match(md, /### Questions, in priority order/);
  // Clean, well-formed table → the low-confidence marker must NOT fire.
  assert.doesNotMatch(md, /low structural confidence/i);
});

test("an aligned 3-column grid becomes a pipe table (row-major)", () => {
  const items = [];
  const rows = [
    ["Region", "Q1", "Notes here are long enough to defeat the short-cell rule"],
    ["North", "100", "on track for the quarter and beyond, comfortably"],
    ["South", "80", "supply issue affecting the southern distribution hub"],
    ["East", "60", "recovering after the outage earlier in the period"],
  ];
  rows.forEach((r, i) => {
    const y = 200 - i * 15;
    items.push(item(r[0], 0, y, { w: 40 }));
    items.push(item(r[1], 120, y, { w: 20 }));
    items.push(item(r[2], 180, y, { w: 300 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /\| Region \| Q1 \| Notes/);
  assert.match(md, /\| North \| 100 \| on track/);
  assert.match(md, /\| South \| 80 \| supply issue/);
  assert.doesNotMatch(md, /low structural confidence/i);
});

test("low-confidence marker fires when tabular columns collapse (not a clean grid)", () => {
  // A tall 2-column short-cell table: detectGrid needs >= 3 columns, so this
  // isn't cleanly reconstructed; the prose column-split reads it column-major,
  // and the marker flags the loss.
  const items = [];
  const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  labels.forEach((lab, i) => {
    const y = 200 - i * 18;
    items.push(item(lab, 0, y, { w: 30 }));
    items.push(item(String((i + 1) * 100), 160, y, { w: 20 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /low structural confidence/i);
});

test("genuine two-column prose does not fire the marker", () => {
  // Long running-text cells → not tabular → column reflow, no marker.
  const items = [];
  for (let k = 0; k < 8; k++) {
    const y = 200 - k * 15;
    items.push(item(`left column running prose sentence number ${k} continues`, 0, y, { w: 90 }));
    items.push(item(`right column running prose sentence number ${k} continues`, 150, y, { w: 90 }));
  }
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /low structural confidence/i);
  // Two clean column margins → converges → no flattened-figure marker either.
  assert.doesNotMatch(md, /flattened into text/i);
});

test("scattered chart labels fire the flattened-figure marker (Tier 2)", () => {
  // Loose labels strewn across x and y with no recurring column — the
  // fingerprint of a chart flattened into text. Doesn't column-split into a
  // table (so the tabular marker stays silent); convergence catches it.
  const xs = [8, 120, 60, 210, 300, 45, 175, 260, 95, 330, 20, 150, 240, 80, 190];
  const items = xs.map((x, i) => item(`L${i}`, x, 300 - i * 14, { w: 18 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /flattened into text/i);
});

test("clean single-column prose fires no marker of either kind", () => {
  const items = [];
  for (let k = 0; k < 10; k++) {
    items.push(
      item(`ordinary running prose line number ${k} of a normal paragraph`, 0, 300 - k * 15, { w: 220 })
    );
  }
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /flattened into text|low structural confidence/i);
});

test("a collapsed table fires only the table marker, never both", () => {
  // The 2-column short-cell table from above: the tabular marker fires; the
  // flattened-figure marker must NOT also fire (they're mutually exclusive).
  const items = [];
  const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  labels.forEach((lab, i) => {
    const y = 200 - i * 18;
    items.push(item(lab, 0, y, { w: 30 }));
    items.push(item(String((i + 1) * 100), 160, y, { w: 20 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /low structural confidence/i);
  assert.doesNotMatch(md, /flattened into text/i);
});

// --- Display-height fake tables (Discovery report p6) -----------------------
// A run of short-cell "rows" set at display-heading height isn't a table but
// disparate display elements — a section heading, a legend, a nav rail — that a
// tall heading glyph vacuumed onto shared baselines, then read as multi-cell
// lines ("| Our position on | KEY: | ... | Reporting | SignatoryR | ... |").
// A real short/numeric table is set at body height, so the guard keys on the
// run's height alone: same cells, different height, opposite verdict.
const dline = (h, para, ...texts) => ({
  y: 0,
  h,
  para,
  cells: texts.map((t, i) => ({ text: t, x: i * 200, endX: i * 200 + 20 })),
});
const bodyLines = () => [
  dline(9, true, "This is an ordinary paragraph of running body text on the page."),
  dline(9, false, "It continues here so nine-point text dominates the height mode."),
];

test("a short-cell run at display-heading height is not emitted as a table", () => {
  const display = [
    dline(34, true, "Our position on", "KEY:"),
    dline(34, false, "Reporting", "Signatory"),
  ];
  const md = linesToMarkdown([...bodyLines(), ...display]);
  assert.doesNotMatch(md, /\|/); // no fake pipe table
  assert.match(md, /Our position on/); // the text itself survives as prose
});

test("the same short-cell run at body height still emits as a table", () => {
  const rows = [
    dline(9, true, "2024", "2025"),
    dline(9, false, "100", "200"),
  ];
  const md = linesToMarkdown([...bodyLines(), ...rows]);
  assert.match(md, /\| 2024 \| 2025 \|/);
});

// --- Discovery p6 fixes: x-order cells, symbol headings, display bands ------
// Synthetic regressions for the heading-band failures (table-heavy corpus doc,
// document page 6): a 34pt two-line heading beside an 8pt KEY legend and 17pt
// R/S commitment letters, all sharing baselines.

test("same-line glyphs at offset baselines assemble in x order, not arrival order", () => {
  // "Signatory" (y=380, h=8) arrives before "R" (y=376, h=18) in y-then-x
  // order, but R sits LEFT of Signatory. Single-pass cell building appended
  // arrival-order ("SignatoryR"); cells must read in x order.
  const items = [
    item("Reporting", 620, 380, { w: 37, h: 8 }),
    item("Signatory", 691, 380, { w: 35, h: 8 }),
    item("R", 601, 376, { w: 11, h: 18 }),
    item("S", 673, 376, { w: 10, h: 18 }),
  ];
  const { lines } = reconstructPage(items);
  assert.equal(lines.length, 1);
  const text = lines[0].cells.map((c) => c.text).join(" ");
  assert.equal(text, "R Reporting S Signatory");
});

test("subscripts join their word without a space (word gap at the smaller glyph's scale)", () => {
  // "CO" + subscript "2" + "-equivalent": the subscript's tiny gap must not
  // read as a word break, and the word must not weld to the next either.
  const items = [
    item("reduce CO", 100, 200, { w: 45, h: 9 }),
    item("2", 145.2, 197, { w: 4, h: 5 }),
    item("-equivalent", 149.4, 200, { w: 52, h: 9 }),
  ];
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /reduce CO2-equivalent/);
});

test("a line of 1-2 char symbol tokens never emits as a heading", () => {
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(item("Body text line long enough to set the height mode.", 0, 200 - i * 12, { w: 240, h: 9 }));
  items.push(item("R", 40, 130, { w: 10, h: 18 }));
  items.push(item("S", 60, 130, { w: 10, h: 18 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /# R S/);
  assert.match(md, /^R S$/m);
});

test("tall symbols riding an entry line don't make it a heading (char-weighted height)", () => {
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(item("Body text line long enough to set the height mode.", 0, 200 - i * 12, { w: 240, h: 9 }));
  // Entry text at body height with 17pt letters close enough to share a cell.
  items.push(item("The UNEP FI Principles for Sustainable Insurance", 0, 130, { w: 230, h: 9 }));
  items.push(item("R", 239, 128, { w: 10, h: 17 }));
  items.push(item("S", 259, 128, { w: 10, h: 17 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /^#/m);
  assert.match(md, /The UNEP FI Principles for Sustainable Insurance R S/);
});

test("a display heading beside side content extracts as one heading plus the side block", () => {
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(item("Ordinary body copy that fixes the page's body height.", 0, 100 - i * 12, { w: 250, h: 9 }));
  // The real Discovery p6 band: a 34pt two-line heading, an 8pt KEY legend
  // level with line 1, and the legend's 18pt R/S letters + 8pt labels level
  // with line 2 (the tall letters bridge the small labels onto the heading's
  // line during y-clustering — keep the real geometry).
  items.push(item("Our position on", 33, 408, { w: 241, h: 34 }));
  items.push(item("KEY:", 599, 397, { w: 17, h: 8 }));
  items.push(item("Reporting", 620, 380, { w: 37, h: 8 }));
  items.push(item("Signatory", 691, 380, { w: 35, h: 8 }));
  items.push(item("R", 601, 376, { w: 11, h: 18 }));
  items.push(item("S", 673, 376, { w: 10, h: 18 }));
  items.push(item("climate change", 33, 373, { w: 236, h: 34 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /# Our position on climate change/);
  assert.match(md, /KEY:\nR Reporting S Signatory/);
  assert.doesNotMatch(md, /Our position on KEY:/);
});

test("a lowercase 'display' cell does not extract (collapsed body-height guard)", () => {
  // A page whose body height mode collapses makes ordinary annotations clear
  // the heading ratio; a mid-clause lowercase fragment must stay in place.
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(item("tiny metrics body text run repeated for the mode.", 0, 100 - i * 6, { w: 200, h: 2 }));
  items.push(item("specific point in time—showing", 0, 200, { w: 140, h: 9 }));
  items.push(item("260,000", 300, 200, { w: 35, h: 2 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /# specific point/);
});

// --- Stream-integrity repairs (LLM-first: token order is all the reader has) --

test("a symbol rail line re-attaches to the entry it sits level with", () => {
  const items = [];
  for (let i = 0; i < 4; i++)
    items.push(item("Body text line long enough to set the height mode.", 0, 300 - i * 12, { w: 240, h: 8 }));
  // Entry at body height; its R/S letters 5pt below the baseline — past the
  // 4pt line-grouping tolerance, so they land on their own line.
  items.push(item("UN Global Compact", 0, 200, { w: 85, h: 8 }));
  items.push(item("R", 230, 195, { w: 10, h: 17 }));
  items.push(item("S", 250, 195, { w: 10, h: 17 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /UN Global Compact R S/);
  assert.doesNotMatch(md, /^R S$/m);
});

test("a margin label spliced into prose is lifted out as its own block", () => {
  // A prose column with a short side-label hanging off two of its lines
  // ("Maintaining legitimacy"): the sentence must read clean and the label
  // must survive separately — not corrupt the claim it landed in.
  const items = [];
  const prose = [
    "One advocates for a reframing of investors' role",
    "in achieving net zero, emphasising real-world",
    "carbon reduction and portfolio returns that",
    "support a just and inclusive transition. Ninety",
    "One engages with higher-emitting companies",
    "on their strategic response to climate change,",
    "applying assessment frameworks to ensure the",
    "plans and strategies are credible and aligned.",
  ];
  prose.forEach((t, i) => items.push(item(t, 758, 300 - i * 12, { w: 170, h: 8 })));
  items.push(item("Maintaining", 984, 288, { w: 55, h: 10 }));
  items.push(item("legitimacy", 988, 276, { w: 50, h: 10 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /emphasising real-world\ncarbon reduction/);
  assert.doesNotMatch(md, /real-world Maintaining/);
  assert.match(md, /Maintaining\s*\n?legitimacy/i);
});

test("a table header row keeps its last column (marginalia must not strip table cells)", () => {
  // Four header cells, the last on a band only these two lines share — it is
  // row data (the scenario name), not a margin label.
  const items = [];
  for (let i = 0; i < 8; i++)
    items.push(item("Running prose body line to anchor the band support.", 0, 300 - i * 12, { w: 230, h: 8 }));
  items.push(item("SECTOR/", 0, 180, { w: 40, h: 8 }));
  items.push(item("NET ZERO", 80, 180, { w: 45, h: 8 }));
  items.push(item("FRAGMENTED", 160, 180, { w: 60, h: 8 }));
  items.push(item("HOT", 260, 180, { w: 20, h: 8 }));
  items.push(item("INDUSTRY", 0, 168, { w: 48, h: 8 }));
  items.push(item("2050", 80, 168, { w: 22, h: 8 }));
  items.push(item("WORLD", 160, 168, { w: 35, h: 8 }));
  items.push(item("HOUSE", 260, 168, { w: 32, h: 8 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /HOT/);
  assert.match(md, /SECTOR\/.*HOT|HOT.*HOUSE/s);
  assert.doesNotMatch(md, /WORLD \|\s*$/m);
});
