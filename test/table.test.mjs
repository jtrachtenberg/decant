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
