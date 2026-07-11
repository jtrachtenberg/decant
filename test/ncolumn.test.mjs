// Unit tests for N-column generalization: guarded recursive column splits
// and the prose-vs-grid discriminators (a 3-column prose page satisfies the
// aligned-starts grid test exactly like a bordered table, and used to emit as
// a fake pipe table). Synthetic glyph items, no PDFs — the Discovery climate
// report drove the calibration (see docs/adr/0012).
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

test("three prose columns read column-by-column, not as a pipe table", () => {
  // Three aligned prose columns with shared baselines: the aligned-starts
  // grid test sees 3 bands × 12 rows (a "table"), and single-gutter splitting
  // used to interleave two of the streams. The cells wrap mid-sentence
  // (no terminal punctuation, lowercase continuations) — the prose tell.
  const items = [];
  const COLS = [0, 200, 400];
  for (let k = 0; k < 12; k++) {
    const y = 300 - k * 14;
    items.push(item(`first column running text ${k} and`, COLS[0], y, { w: 150, h: 10 }));
    items.push(item(`second column running text ${k} and`, COLS[1], y, { w: 150, h: 10 }));
    items.push(item(`third column running text ${k} and`, COLS[2], y, { w: 150, h: 10 }));
  }
  const lines = reconstructLines(items);
  const md = linesToMarkdown(lines);
  assert.doesNotMatch(md, /\|/, `prose formalized into a pipe table:\n${md}`);
  const text = linesToText(lines);
  for (const l of text.split("\n")) {
    const hit = ["first", "second", "third"].filter((c) => l.includes(c));
    assert.ok(hit.length <= 1, `columns interleaved on one line: "${l}"`);
  }
  // Column-major order: each stream finishes before the next begins.
  const lastFirst = text.lastIndexOf("first column running text 11");
  const firstSecond = text.indexOf("second column running text 0");
  const lastSecond = text.lastIndexOf("second column running text 11");
  const firstThird = text.indexOf("third column running text 0");
  assert.ok(lastFirst !== -1 && firstSecond !== -1 && firstThird !== -1);
  assert.ok(lastFirst < firstSecond, "first column must precede second");
  assert.ok(lastSecond < firstThird, "second column must precede third");
});

test("a grid whose bands recur page-wide as column origins is prose", () => {
  // Punctuated cells (no wrap tell), but the three bands are the page's own
  // column origins: rows above and below the aligned run start at the same
  // x positions across the whole page height. A real table's interior column
  // positions are private to the table.
  const items = [];
  const COLS = [0, 200, 400];
  for (let k = 0; k < 12; k++) {
    const y = 300 - k * 14;
    for (const [c, name] of [[0, "one"], [1, "two"], [2, "three"]]) {
      // A paragraph gap in a different column each 4th row breaks the
      // aligned run, so detectGrid's best run is a slice of the page and the
      // remaining rows are its outside support.
      if (k % 4 === 3 && c === (Math.floor(k / 4) % 3)) continue;
      items.push(
        item(`column ${name} sentence ${k} ends here.`, COLS[c], y, { w: 150, h: 10 })
      );
    }
  }
  const md = linesToMarkdown(reconstructLines(items));
  assert.doesNotMatch(md, /\|/, `prose formalized into a pipe table:\n${md}`);
});

test("a genuine aligned grid with complete-phrase cells stays a table", () => {
  // Regression guard for the wrap discriminator: long cells that are complete
  // phrases (terminal punctuation, capitalized starts) don't wrap like prose,
  // so the grid must still emit row-major as a pipe table.
  const items = [
    item("Prose paragraph above the table sits here.", 0, 400, { w: 300, h: 10 }),
    item("It has a couple of lines of running text.", 0, 386, { w: 300, h: 10 }),
  ];
  const rows = [
    ["Fixed income securities.", "Held at market value.", "Reviewed yearly."],
    ["Listed equity holdings.", "Held at closing price.", "Reviewed monthly."],
    ["Unlisted investments.", "Held at directors' value.", "Reviewed quarterly."],
    ["Derivative instruments.", "Held at fair value.", "Reviewed daily."],
  ];
  rows.forEach((cells, r) => {
    const y = 300 - r * 12;
    items.push(item(cells[0], 0, y, { w: 130, h: 10 }));
    items.push(item(cells[1], 160, y, { w: 130, h: 10 }));
    items.push(item(cells[2], 320, y, { w: 100, h: 10 }));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(
    md,
    /\| Fixed income securities\. \| Held at market value\. \| Reviewed yearly\. \|/,
    `aligned grid no longer emits as a table:\n${md}`
  );
});

test("a symbol rail is never split off from its referent column", () => {
  // The Discovery p7 commitments panel: entries with R/S letters in a narrow
  // rail beside them. The rail's corridor is a perfectly confident gutter,
  // but splitting there reads all entries then all letters, divorcing every
  // symbol from its referent. The nested-split guard must reject that cut so
  // the rail stays row-paired with its entries.
  const items = [];
  // A left prose column, separated from the panel by the page's main gutter.
  for (let k = 0; k < 9; k++) {
    items.push(item(`body prose line ${k} and`, 0, 290 - k * 14, { w: 80, h: 10 }));
  }
  // The panel: entries at x=200 (each a different width — a ragged right
  // edge), letters rail at x=420.
  const entries = [
    "Responsible Investment Principles",
    "Carbon Disclosure Project",
    "Climate Financial Disclosures",
    "Alliance for Climate Action",
    "Sustainable Insurance Principles",
    "Global Compact Initiative",
    "Reporting Initiative Standards",
    "Accounting Standards Board",
  ];
  entries.forEach((name, k) => {
    const y = 288 - k * 15;
    items.push(item(name, 200, y, { w: 120 + (k % 3) * 20, h: 10 }));
    items.push(item(k % 2 ? "R S" : "R", 420, y, { w: 15, h: 10 }));
  });
  const text = linesToText(reconstructLines(items));
  const lines = text.split("\n");
  // Every entry keeps its letters on its own line…
  entries.forEach((name, k) => {
    const line = lines.find((l) => l.includes(name));
    assert.ok(line, `entry missing: ${name}`);
    assert.match(
      line,
      k % 2 ? /R S$/ : /R$/,
      `letters divorced from their entry: "${line}"`
    );
  });
  // …so no orphaned run of bare letters exists.
  assert.ok(
    !lines.some((l) => /^[RS ]{1,4}$/.test(l.trim())),
    `orphaned symbol rail:\n${text}`
  );
});
