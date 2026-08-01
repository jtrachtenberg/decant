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

// --- Label rails (ADR 0032) --------------------------------------------------

test("a form's label rail binds to its values instead of splitting", () => {
  // The generated-report case: field labels down one side of a wide gap, their
  // values down the other. Read column-major this emits every label and then
  // every value, and nothing says which belongs to which.
  const items = [];
  const fields = [
    ["Name:", "Kitchen Units"],
    ["Description:", "Kitchen mantle needs to be ordered and fitted"],
    ["Due Date:", "05 Jun 2017"],
    ["Priority:", "High"],
    ["Status:", "In Progress"],
    ["Assigned To:", "Me"],
  ];
  fields.forEach(([label, value], k) => {
    const y = 490 - k * 9;
    items.push(item(label, 235, y, { w: label.length * 2.8, h: 6 }));
    items.push(item(value, 325, y, { w: value.length * 2.8, h: 6 }));
  });
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /\| Name: \| Kitchen Units \|/);
  assert.match(md, /\| Due Date: \| 05 Jun 2017 \|/);
  assert.match(md, /\| Assigned To: \| Me \|/);
  // The column-major failure mode: a label line with no value on it.
  assert.doesNotMatch(md, /^Name:\s*$/m);
});

test("two columns of prose still split when neither side is a label rail", () => {
  // Same geometry, same short cells — only the trailing colons are gone. The
  // rail veto must not reach this: it is an ordinary two-column page.
  const items = [];
  for (let k = 0; k < 6; k++) {
    const y = 490 - k * 9;
    items.push(item(`left line ${k}`, 235, y, { w: 34, h: 6 }));
    items.push(item(`right line ${k}`, 325, y, { w: 38, h: 6 }));
  }
  const md = linesToMarkdown(reconstructPage(items).lines);
  for (const l of md.split("\n"))
    assert.ok(
      !(l.includes("left line") && l.includes("right line")),
      `columns interleaved: "${l}"`
    );
});

test("a wrapped value folds into its cell instead of ending the table", () => {
  // The details block: a description too long for its column sets its
  // remainder under the value, with no label beside it. Emitted as a row of
  // its own it ends the table there, and an eleven-row block comes out as two
  // tables with a loose sentence between them.
  const rows = [
    ["Name:", "3 Main Street"],
    ["Reference:", "2017/04/0001S"],
    ["Description:", "Full renovation and extension as per project"],
  ];
  const items = [];
  rows.forEach(([label, value], k) => {
    const y = 719 - k * 12;
    items.push(item(label, 70, y, { w: label.length * 2.7, h: 6 }));
    items.push(item(value, 190, y, { w: value.length * 2.9, h: 6 }));
  });
  // The wrap: 7pt below its row (695) where the rows are set 12pt apart.
  items.push(item("document reference 17/6353G", 190, 688, { w: 81, h: 6 }));
  items.push(item("Started:", 70, 676, { w: 21, h: 6 }));
  items.push(item("10 Jan 2017", 190, 676, { w: 33, h: 6 }));

  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(
    md,
    /\| Description: \| Full renovation and extension as per project document reference 17\/6353G \|/
  );
  // One table, not two with an orphan between them.
  assert.equal(md.split("| --- |").length - 1, 1);
});

test("a wrap chain anchored on the region's FIRST row does not crash at the last line", () => {
  // The anchor row opens the region (no gap above it) and the candidate closes
  // it (no line below): both pitch readings are out of range at once. The
  // fallback used to index one past the end of the lines array and throw,
  // killing conversion of the whole document.
  const items = [
    item("Description:", 70, 719, { w: 32, h: 6 }),
    item("Full renovation and extension as per project", 190, 719, { w: 127, h: 6 }),
    // First continuation, at leading — merges into the row above.
    item("document reference 17/6353G and annexes", 190, 712, { w: 113, h: 6 }),
    // Second continuation, last line of the region: its anchor is line 0.
    item("as amended by the March addendum", 190, 700, { w: 94, h: 6 }),
  ];
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /document reference 17\/6353G/);
});

test("the next ROW at the same pitch is not folded into the row above", () => {
  // Same shape, but the second line is set at the rows' own spacing — it is a
  // row that happens to have no label, not a continuation.
  const items = [];
  [
    ["Name:", "3 Main Street"],
    ["Reference:", "2017/04/0001S"],
  ].forEach(([label, value], k) => {
    const y = 719 - k * 12;
    items.push(item(label, 70, y, { w: label.length * 2.7, h: 6 }));
    items.push(item(value, 190, y, { w: value.length * 2.9, h: 6 }));
  });
  items.push(item("a full 12pt below", 190, 695, { w: 50, h: 6 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.doesNotMatch(md, /2017\/04\/0001S a full 12pt below/);
});
