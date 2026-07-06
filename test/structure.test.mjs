// Unit tests for line reconstruction and Markdown structuring (headings,
// tables, paragraphs). Synthetic glyph items, no PDFs.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconstructLines,
  reconstructPage,
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

test("two columns on independent baselines still read column-first", () => {
  // The WHO "World health statistics" p.17 regression: the two columns are
  // typeset on offset baselines (a taller subheading in the left column knocks
  // its grid out of sync with the right), so NO row contains both columns.
  // findGutter reads each row's interior gutter gap and thus sees nothing, and
  // the page used to fall back to single-region y-order — interleaving the
  // columns into false sentences. A short subheading that happens to share a
  // right-column baseline was the worst case: it merged with the right line into
  // "2.4.1 Global subsection <right text>", exactly the reported symptom.
  const LEFT = 0;
  const RIGHT = 150;
  const items = [];
  // Right column: 10 continuous prose lines on grid y = 270 - 14k.
  for (let k = 0; k < 10; k++) {
    items.push(item(`rightcol line ${k} onward`, RIGHT, 270 - k * 14, { w: 70, h: 10 }));
  }
  // Left column prose, baselines offset +7 from the right grid (never merge).
  [277, 263, 249].forEach((y, k) =>
    items.push(item(`leftcol line ${k + 1} onward`, LEFT, y, { w: 70, h: 10 }))
  );
  // Short subheading, taller font, sharing the right-grid baseline y=200 (k=5),
  // with whitespace around it in the left column.
  items.push(item("2.4.1 Global subsection", LEFT, 200, { w: 90, h: 14 }));
  // Whitespace below the subheading before the left column resumes.
  [180, 166, 152, 138].forEach((y, k) =>
    items.push(item(`leftcol line ${k + 4} onward`, LEFT, y, { w: 70, h: 10 }))
  );

  const lines = linesToMarkdown(reconstructLines(items))
    .split("\n")
    .filter((l) => l.trim());

  // No line may mix the two columns, and the subheading must not swallow a
  // right-column line.
  for (const l of lines) {
    assert.ok(
      !(l.includes("leftcol") && l.includes("rightcol")),
      `columns interleaved on one line: "${l}"`
    );
    assert.ok(
      !(l.includes("Global subsection") && l.includes("rightcol")),
      `subheading joined a right-column line: "${l}"`
    );
  }
  // The subheading is emitted as its own heading.
  assert.ok(
    lines.some((l) => /^#+\s+2\.4\.1 Global subsection$/.test(l)),
    "subheading not emitted as its own heading:\n" + lines.join("\n")
  );
  // Left column reads fully before the right column.
  const lastLeft = lines.findIndex((l) => l.includes("leftcol line 7"));
  const firstRight = lines.findIndex((l) => l.includes("rightcol line 0"));
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

test("page-break fragment inherits the previous page's gutter", () => {
  // Page 1: a confident two-column layout — detection succeeds on its own.
  const page1 = [];
  for (let k = 1; k <= 8; k++) {
    const y = 270 - (k - 1) * 15;
    page1.push(item(`leftcol line ${k}`, 0, y, { w: 70, h: 10 }));
    page1.push(item(`rightcol line ${k}`, 150, y, { w: 70, h: 10 }));
  }
  const { gutter } = reconstructPage(page1);
  assert.ok(gutter != null, "page 1 should detect a gutter");

  // Page 2: a three-row remainder — below the detection guards on its own.
  const frag = [];
  for (let k = 1; k <= 3; k++) {
    const y = 270 - (k - 1) * 15;
    frag.push(item(`leftfrag ${k}`, 0, y, { w: 70, h: 10 }));
    frag.push(item(`rightfrag ${k}`, 150, y, { w: 70, h: 10 }));
  }
  // Without the hint the rows interleave (the documented limitation)...
  assert.match(linesToText(reconstructPage(frag).lines), /leftfrag 1 rightfrag 1/);
  // ...with it, the fragment reads the left column fully, then the right.
  const hinted = linesToText(reconstructPage(frag, gutter).lines);
  assert.match(hinted, /leftfrag 3\nrightfrag 1/);
  for (const l of hinted.split("\n")) {
    assert.ok(
      !(l.includes("leftfrag") && l.includes("rightfrag")),
      `columns interleaved on one line: "${l}"`
    );
  }
});

test("a carried gutter is inert on a full-width page and stops there", () => {
  const items = [];
  for (let k = 1; k <= 4; k++) {
    items.push(
      item(`full width line ${k} covering the whole page`, 0, 200 - k * 14, {
        w: 300,
        h: 10,
      })
    );
  }
  const { lines, gutter } = reconstructPage(items, 140);
  assert.equal(gutter, null); // not carried further
  assert.match(linesToText(lines), /line 1[\s\S]*line 4/);
});

test("a single-side fragment does not adopt the carried gutter", () => {
  // Two short left-column-only rows: nothing on the right of the gutter, so
  // the hint must not apply (and must not carry on).
  const frag = [
    item("left only one", 0, 100, { w: 70, h: 10 }),
    item("left only two", 0, 85, { w: 70, h: 10 }),
  ];
  const { lines, gutter } = reconstructPage(frag, 140);
  assert.equal(gutter, null);
  assert.equal(linesToText(lines), "left only one\nleft only two");
});

test("empty input yields empty output", () => {
  assert.equal(linesToMarkdown(reconstructLines([])), "");
  assert.equal(linesToText(reconstructLines([])), "");
});
