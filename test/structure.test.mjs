// Unit tests for line reconstruction and Markdown structuring (headings,
// tables, paragraphs). Synthetic glyph items, no PDFs.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconstructLines,
  linesToText,
  linesToMarkdown,
} from "../src/convert/classify.js";

// Build a pdf.js-style text item. y is page coordinate (larger = higher).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

test("groups glyphs on the same line and orders top-to-bottom", () => {
  const lines = reconstructLines([
    item("world", 60, 100),
    item("Hello", 0, 100),
    item("second", 0, 80),
  ]);
  assert.equal(linesToText(lines), "Hello world\nsecond");
});

test("larger font line becomes a heading", () => {
  const lines = reconstructLines([
    item("Big Title", 0, 200, { h: 20 }),
    item("body text one", 0, 170, { h: 10 }),
    item("body text two", 0, 158, { h: 10 }),
    item("body text three", 0, 146, { h: 10 }),
  ]);
  const md = linesToMarkdown(lines);
  assert.match(md, /^# Big Title$/m);
  assert.match(md, /^body text one$/m);
});

test("aligned multi-column rows become a Markdown table", () => {
  // Two rows, two columns; big horizontal gap (>2*h) splits the columns.
  const lines = reconstructLines([
    item("Region", 0, 100),
    item("Value", 200, 100),
    item("Africa", 0, 86),
    item("442", 200, 86),
  ]);
  const md = linesToMarkdown(lines);
  assert.match(md, /\| Region \| Value \|/);
  assert.match(md, /\| --- \| --- \|/);
  assert.match(md, /\| Africa \| 442 \|/);
});

test("ordinary prose is not turned into a table", () => {
  const lines = reconstructLines([
    item("This is a normal sentence of prose.", 0, 100),
    item("And a second line right below it.", 0, 88),
  ]);
  const md = linesToMarkdown(lines);
  assert.doesNotMatch(md, /\|/);
});

test("paragraph break on large vertical gap", () => {
  const lines = reconstructLines([
    item("first paragraph", 0, 200, { h: 10 }),
    item("second paragraph", 0, 160, { h: 10 }), // gap 40 > 1.6*10
  ]);
  const md = linesToMarkdown(lines);
  assert.match(md, /first paragraph\n\nsecond paragraph/);
});

test("two-column page reads left column fully, then right", () => {
  const items = [item("Section One Heading", 0, 300, { w: 280, h: 14 })];
  for (let k = 1; k <= 8; k++) {
    const y = 270 - (k - 1) * 15;
    items.push(item(`leftcol line ${k}`, 0, y, { w: 70, h: 10 }));
    items.push(item(`rightcol line ${k}`, 150, y, { w: 70, h: 10 }));
  }
  const lines = linesToMarkdown(reconstructLines(items))
    .split("\n")
    .filter((l) => l.trim());

  for (const l of lines)
    assert.ok(
      !(l.includes("leftcol") && l.includes("rightcol")),
      `columns interleaved on one line: "${l}"`
    );
  const lastLeft = lines.findIndex((l) => l.includes("leftcol line 8"));
  const firstRight = lines.findIndex((l) => l.includes("rightcol line 1"));
  assert.ok(lastLeft >= 0 && firstRight >= 0, "both columns present");
  assert.ok(lastLeft < firstRight, "left column should precede right column");
});

test("single-column page is unaffected by column detection", () => {
  const items = [];
  for (let k = 1; k <= 10; k++) {
    items.push(
      item(`single column body line number ${k} spanning the width`, 0, 200 - k * 14, {
        w: 300,
        h: 10,
      })
    );
  }
  const md = linesToMarkdown(reconstructLines(items));
  assert.ok(
    md.indexOf("number 1 ") < md.indexOf("number 10"),
    "lines should stay in original order"
  );
});

test("empty input yields empty output", () => {
  assert.equal(linesToMarkdown(reconstructLines([])), "");
  assert.equal(linesToText(reconstructLines([])), "");
});
