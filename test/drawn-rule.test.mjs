// Unit tests for typographic rules drawn as repeated glyphs (classify.js:
// isDrawnRule) and the table they were destroying.
//
// The failure it exists for: a ruled line under a table's column headings,
// painted not as a stroke but as a long run of one glyph from a symbol font
// with no usable ToUnicode. public-famous PDF page 17 underscores each heading
// of its "Preferred Stock Versus Common Stock" comparison table with 45 and 37
// repetitions of U+0002, and that costs the page its table twice over: the run
// sits between the heading row and the first data row, so row grouping bridges
// the two and swallows "Voting Rights / Does not vote / May vote" into the
// header; then its control characters condemn the whole table as corrupt
// (tableHasCorruptCells), replacing seven clean rows with the omitted-chart-
// table note and attaching the page as a figure it never was.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isDrawnRule,
  reconstructPage,
  linesToText,
  linesToMarkdown,
} from "../src/convert/classify.js";

// Built from code points rather than typed literally — a control character
// does not survive a round trip through every editor and terminal encoding,
// and a test for control characters that silently loses them proves nothing.
const RULE = String.fromCharCode(0x02); // the symbol font's rule tile
const FFFD = String.fromCharCode(0xfffd); // pdf.js's "no character for this glyph"

// A pdf.js-shaped text item. Only str/transform/width/height are read.
const item = (str, x, y, width = str.length * 5, height = 10) => ({
  str,
  transform: [height, 0, 0, height, x, y],
  width,
  height,
});

// --- the test itself -------------------------------------------------------

test("a long homogeneous run of one control code is a rule", () => {
  assert.equal(isDrawnRule(item(RULE.repeat(45), 379, 449, 74.9, 5)), true);
});

test("a run shorter than the floor is left alone", () => {
  // Nothing in the corpus draws a rule this short, and below the floor the
  // corruption signal keeps the benefit of the doubt.
  assert.equal(isDrawnRule(item(RULE.repeat(4), 379, 449, 6.6, 5)), false);
});

test("control codes mixed through readable text are not a rule", () => {
  // The corruption signal tableHasCorruptCells exists for. Laundering this
  // into a clean-looking wrong value is the failure mode to avoid.
  assert.equal(isDrawnRule(item(`Rev${RULE}nue 45${RULE}2`, 60, 400)), false);
  assert.equal(isDrawnRule(item(RULE.repeat(20) + "total", 60, 400)), false);
});

test("two different control codes in a row are not a rule", () => {
  const mixed = (RULE + String.fromCharCode(0x03)).repeat(10);
  assert.equal(isDrawnRule(item(mixed, 60, 400)), false);
});

test("undecodable glyphs are left to the garble machinery", () => {
  // U+FFFD/PUA runs look identical in shape but already have an owner:
  // textLayerGarble measures them per page, marks the loss and strips them.
  // Claiming them here would compute a garbled page's ratio as zero and
  // silently withdraw its marker — messy-scan sets 1,205 such runs.
  assert.equal(isDrawnRule(item(FFFD.repeat(200), 60, 600)), false);
  assert.equal(isDrawnRule(item(String.fromCharCode(0xe000).repeat(50), 60, 600)), false);
});

test("ordinary prose is never a rule", () => {
  assert.equal(isDrawnRule(item("The quick brown fox jumps over it", 60, 700)), false);
  assert.equal(isDrawnRule(null), false);
  assert.equal(isDrawnRule({ str: "" }), false);
});

// --- reconstruction: the table the rule was costing us ---------------------

// public-famous p17's comparison table to scale: three aligned column bands
// (row labels at 316.5, Preferred at 379.5, Common at 463.5) with the ruled
// underline sitting between the heading row and the first data row.
function comparisonTable() {
  const rows = [
    ["Voting Rights", "Does not vote", "May vote", 438],
    ["Callable", "May be callable", "Not callable", 420],
    ["Dividends", "Fixed dividend", "Variable dividend", 402],
    ["Seniority", "Priority over", "Lowest claim", 384],
  ];
  const items = [
    item("Preferred Stock", 379.5, 456, 63, 9),
    item("Common Stock", 463.5, 456, 61.3, 9),
    item(RULE.repeat(45), 379.5, 449, 74.9, 5),
    item(RULE.repeat(37), 463.5, 449, 61.6, 5),
  ];
  for (const [label, pref, common, y] of rows) {
    items.push(item(label, 316.5, y, label.length * 4, 9));
    items.push(item(pref, 379.5, y, pref.length * 4, 9));
    items.push(item(common, 463.5, y, common.length * 4, 9));
  }
  return items;
}

test("the rule does not reach the output", () => {
  const text = linesToText(reconstructPage(comparisonTable()).lines);
  assert.ok(!text.includes(RULE), "rule tiles must not survive");
  assert.match(text, /Preferred Stock/);
  assert.match(text, /Common Stock/);
});

test("the rule no longer bridges the heading row into the first data row", () => {
  // The row-grouping half of the damage: with the rule in place, the header's
  // reach extends over it and down to the first data row, so "Voting Rights"
  // is swallowed by the "Preferred Stock" cell.
  const { lines } = reconstructPage(comparisonTable());
  const header = lines.find((l) => l.cells.some((c) => /Preferred Stock/.test(c.text)));
  assert.ok(header, "the heading row must survive");
  for (const cell of header.cells) {
    assert.doesNotMatch(cell.text, /Voting Rights|Does not vote|May vote/);
  }
});

test("the table emits instead of being condemned as corrupt", () => {
  // The corrupt-cell half: one control character anywhere in a table's cells
  // replaces the whole table with the omitted-chart-table note, which then
  // routes the page into the figures flow (hasOmittedChartTable).
  const md = linesToMarkdown(reconstructPage(comparisonTable()).lines, "17");
  assert.doesNotMatch(md, /chart table omitted/);
  assert.match(md, /Voting Rights/);
  assert.match(md, /May vote/);
});

test("a table whose cells are genuinely corrupt is still condemned", () => {
  // The signal must survive intact: same table, but with control characters
  // scattered THROUGH the values rather than tiled into a rule.
  const items = comparisonTable().filter((it) => !isDrawnRule(it));
  const broken = items.map((it) =>
    /Does not vote/.test(it.str) ? { ...it, str: `Do${RULE}s not v${RULE}te` } : it
  );
  const md = linesToMarkdown(reconstructPage(broken).lines, "17");
  assert.match(md, /chart table omitted/);
});
