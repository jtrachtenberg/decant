// Tier 2 chart-table corruption (SPEC §3.9): synthetic regressions for the
// WHO-doc p17 failure modes — C0 control characters (a font with no usable
// ToUnicode map makes pdf.js emit raw glyph codes) silently landing in table
// cells, and a floating legend/axis text box shredding fragment-by-fragment
// into grid rows. A confidently-wrong table is worse than an omission: the
// figures flow attaches the actual chart page, so a corrupt table is replaced
// by a marker pointing at it.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { reconstructPage, linesToMarkdown } from "../src/convert/classify.js";

// pdf.js-style text item (mirrors table.test.mjs).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

// The aligned 3-column grid from table.test.mjs, with one cell's value and
// the notes column's width swappable so each test can inject corruption or
// control where the last column ends.
function gridItems({ q1North = "100", notesW = 300 } = {}) {
  const items = [];
  const rows = [
    ["Region", "Q1", "Notes here are long enough to defeat the short-cell rule"],
    ["North", q1North, "on track for the quarter and beyond, comfortably"],
    ["South", "80", "supply issue affecting the southern distribution hub"],
    ["East", "60", "recovering after the outage earlier in the period"],
  ];
  rows.forEach((r, i) => {
    const y = 200 - i * 15;
    items.push(item(r[0], 0, y, { w: 40 }));
    items.push(item(r[1], 120, y, { w: 20 }));
    items.push(item(r[2], 180, y, { w: notesW }));
  });
  return items;
}

test("C0 control chars in a grid-table cell omit the table with a page-labelled marker", () => {
  // WHO p17: a no-ToUnicode font emitted U+001A–U+001F glyph codes as cell
  // "data". Provably corrupt → the whole table is untrustworthy.
  const items = gridItems({ q1North: "\u001b\u001c\u001a" });
  const md = linesToMarkdown(reconstructPage(items).lines, "7");
  assert.match(
    md,
    /\[chart table omitted — unreliable extraction; see attached figure, document page 7\]/
  );
  // The corrupt table must not be emitted — no pipe rows, no control chars.
  assert.doesNotMatch(md, /\| North \|/);
  assert.doesNotMatch(md, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test("C0 control chars in a content-run table omit it too (the WHO p17 path)", () => {
  // The p17 corruption actually lives in a content-based table run (short
  // numeric cells upgraded by tableRuns), not a geometry grid — 2 columns is
  // below detectGrid's floor. 3 lines × 2 cells, one cell pure glyph codes.
  const items = [
    item("0.04", 0, 200, { w: 20 }),
    item("0.02", 100, 200, { w: 20 }),
    item("0.11", 0, 185, { w: 20 }),
    item("\u001f\u001e\u001d", 100, 185, { w: 15 }),
    item("0.16", 0, 170, { w: 20 }),
    item("0.07", 100, 170, { w: 20 }),
  ];
  const md = linesToMarkdown(reconstructPage(items).lines);
  // No page label supplied → marker without the page clause.
  assert.match(
    md,
    /\[chart table omitted — unreliable extraction; see attached figure\]/
  );
  assert.doesNotMatch(md, /document page/);
  assert.doesNotMatch(md, /\|/);
  assert.doesNotMatch(md, /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test("a clean grid table still converts — no omission marker", () => {
  const md = linesToMarkdown(reconstructPage(gridItems()).lines, "7");
  assert.match(md, /\| North \| 100 \| on track/);
  assert.doesNotMatch(md, /chart table omitted/);
});

test("adjacent corrupt tables collapse into a single omission marker", () => {
  // A corrupt grid directly followed by a corrupt content run must not stack
  // two identical markers.
  const items = gridItems({ q1North: "\u001b\u001c" });
  // Below the grid (grid rows span y 155–200): a 2-column numeric run with
  // its own C0 cell, at x positions off the grid's bands.
  items.push(
    item("0.04", 10, 130, { w: 20 }),
    item("\u001a\u001a", 210, 130, { w: 10 }),
    item("0.11", 10, 115, { w: 20 }),
    item("0.07", 210, 115, { w: 20 }),
    item("0.16", 10, 100, { w: 20 }),
    item("0.09", 210, 100, { w: 20 })
  );
  const md = linesToMarkdown(reconstructPage(items).lines, "7");
  const markers = md.match(/chart table omitted/g) || [];
  assert.equal(markers.length, 1, "expected exactly one marker:\n" + md);
});

test("a floating legend box right of the grid's bands is excluded from row merging", () => {
  // WHO p17: the axis label "Change in HALE (years)" (x 438) sat far right of
  // the grid's last band (285) and was glued into a data row's last cell. Here
  // a legend text box at x=400 sits beside rows whose last column ends x=360.
  const items = gridItems({ notesW: 180 });
  items.push(
    item("Communicable,", 400, 185, { w: 34, h: 6 }),
    item("maternal, perinatal", 400, 170, { w: 45, h: 6 }),
    item("conditions", 400, 155, { w: 25, h: 6 })
  );
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /\| North \| 100 \| on track/);
  assert.match(md, /\| South \| 80 \| supply issue/);
  // The legend must not shred into the data rows.
  assert.doesNotMatch(md, /Communicable|maternal|conditions/);
});

test("a floating text box left of the grid's first band is excluded too", () => {
  const items = [];
  const rows = [
    ["Region", "Q1", "Notes here are long enough to defeat the short-cell rule"],
    ["North", "100", "on track for the quarter and beyond, comfortably"],
    ["South", "80", "supply issue affecting the southern distribution hub"],
    ["East", "60", "recovering after the outage earlier in the period"],
  ];
  rows.forEach((r, i) => {
    const y = 200 - i * 15;
    items.push(item(r[0], 100, y, { w: 40 }));
    items.push(item(r[1], 220, y, { w: 20 }));
    items.push(item(r[2], 280, y, { w: 300 }));
  });
  items.push(item("Sidebar note", 10, 185, { w: 30, h: 6 }));
  items.push(item("in the margin", 10, 170, { w: 32, h: 6 }));
  const md = linesToMarkdown(reconstructPage(items).lines);
  assert.match(md, /\| North \| 100 \| on track/);
  assert.doesNotMatch(md, /Sidebar|margin/);
});
