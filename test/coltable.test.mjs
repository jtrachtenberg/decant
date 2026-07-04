// Tests for two-column long-text table reconstruction (classify.js): the case
// detectGrid (needs 3 columns) and looksTabular (needs short/numeric cells)
// both miss. A 2-column table with long free-text cells was silently read
// column-major, losing every row's left<->right binding with no marker. The fix
// tells a table from prose by cross-column row correspondence (matching block
// counts with pairwise-aligned tops). Golden test against a committed fixture
// plus synthetic geometry tests.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { reconstructPage, linesToMarkdown } from "../src/convert/classify.js";

// pdf.js-style text item (mirrors structure.test.mjs / table.test.mjs).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

async function fixturePages(name) {
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
  return pages;
}

// The exact row from the reported bug: left indicator <-> its own right reason,
// which the old column-major reflow scrambled into all-left-then-all-right.
const CANONICAL_ROW =
  "| 3.1.1 Maternal mortality ratio | Target set at the global level; progress not assessed at the regional level |";

test("2-col long-text table reconstructs row-major with correct bindings", async () => {
  const [page1] = await fixturePages("two_col_table.pdf");
  assert.match(page1, /\| Indicator \| Reason for exclusion \|/);
  assert.match(page1, /\| --- \| --- \|/);
  assert.ok(page1.includes(CANONICAL_ROW), "canonical row binding not found:\n" + page1);
  // Every reason must sit on its own indicator's row — no all-left-then-all-right
  // column-major collapse.
  assert.match(page1, /\| 3.5.2 Alcohol per capita consumption \| Methodology under revision/);
  // A correctly reconstructed table is high-fidelity: no low-confidence marker.
  assert.doesNotMatch(page1, /low structural confidence|flattened into text/i);
});

test("clean 2-col prose on the facing page stays prose, no table, no marker", async () => {
  const [, page2] = await fixturePages("two_col_table.pdf");
  assert.doesNotMatch(page2, /\|/); // never rendered as a table
  const lastLeft = page2.indexOf("Left running prose line 9");
  const firstRight = page2.indexOf("Right running prose line 0");
  assert.ok(lastLeft >= 0 && firstRight >= 0, "both columns present");
  assert.ok(lastLeft < firstRight, "left column should precede right column");
  assert.doesNotMatch(page2, /low structural confidence|flattened into text/i);
});

test("synthetic single-line 2-col table pairs cells row-major", () => {
  const rows = [
    ["Indicator", "Reason for exclusion"],
    ["Maternal mortality ratio", "Target set at the global level only"],
    ["Under-five mortality rate", "Country-level reporting incomplete"],
    ["New HIV infections per 1000", "Insufficient disaggregated data here"],
    ["Alcohol per capita consumption", "Methodology under revision currently"],
  ];
  const items = [];
  rows.forEach(([l, r], i) => {
    const y = 300 - i * 20; // gap 10 > 0.8*h → each row its own block
    items.push(item(l, 72, y, { w: 150 }));
    items.push(item(r, 320, y, { w: 200 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /\| Indicator \| Reason for exclusion \|/);
  assert.match(md, /\| Maternal mortality ratio \| Target set at the global level only \|/);
  assert.match(md, /\| New HIV infections per 1000 \| Insufficient disaggregated data here \|/);
  assert.doesNotMatch(md, /low structural confidence|flattened into text/i);
});

test("2-col prose with misaligned block tops is NOT turned into a table", () => {
  // Both columns split into 3 blocks, but their tops are offset — the
  // correspondence check must reject this and keep prose reflow. Shared
  // baselines on some rows so a gutter is still detected (the detector runs).
  const L = [300, 286, 258, 244, 216, 202]; // blocks [300,286][258,244][216,202]
  const R = [300, 286, 244, 230, 202, 188]; // blocks [300,286][244,230][202,188]
  const items = [];
  L.forEach((y) => items.push(item("left prose fragment here", 0, y, { w: 80 })));
  R.forEach((y) => items.push(item("right prose fragment here", 150, y, { w: 80 })));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /\|/); // not a table — bindings would be wrong
});

test("short/numeric 2-col table stays on the marker path, not the new table", () => {
  // The long-text gate: short/numeric cells are left to looksTabular's existing
  // conservative marker, not reconstructed as a confident table.
  const items = [];
  const labels = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
  labels.forEach((lab, i) => {
    const y = 200 - i * 22; // clear row gaps, so blocks would segment
    items.push(item(lab, 0, y, { w: 30 }));
    items.push(item(String((i + 1) * 100), 160, y, { w: 20 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /low structural confidence/i);
});
