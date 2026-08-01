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

test("full-width intro paragraph doesn't hide the gutter below it", () => {
  // The columns are set on independent baselines (no row holds both), so the
  // per-row gutter gap sees nothing and detection falls to the column-starts
  // path. Above them sits a full-width intro paragraph whose lines run margin
  // to margin — and whose CENTER lands left of the gutter, because the left
  // margin is wider than the right. That paragraph used to be counted as
  // left-column content, dragging the left column's right edge past the right
  // column's start, so the whitespace-corridor check measured a NEGATIVE
  // corridor and rejected a perfectly good two-column page. Both streams then
  // interleaved line by line into false prose (real instance: a two-column
  // financial primer's page 33).
  const items = [];
  // Full-width intro: x0=50, x1=540, center 295 — just left of the gutter.
  for (let k = 0; k < 3; k++) {
    items.push(item(`intro line ${k} running the full page width`, 50, 400 - k * 14, { w: 490, h: 10 }));
  }
  // Two columns, baselines offset by 7pt so no row ever holds both.
  for (let k = 0; k < 12; k++) {
    items.push(item(`LEFT ${k} left column running text`, 50, 300 - k * 14, { w: 230, h: 10 }));
    items.push(item(`RIGHT ${k} right column running text`, 310, 293 - k * 14, { w: 230, h: 10 }));
  }
  const text = linesToText(reconstructLines(items));
  const lines = text.split("\n");
  const lastLeft = lines.findLastIndex((l) => l.includes("LEFT "));
  const firstRight = lines.findIndex((l) => l.includes("RIGHT "));
  assert.ok(lastLeft >= 0 && firstRight >= 0, `columns missing:\n${text}`);
  assert.ok(
    lastLeft < firstRight,
    `columns interleaved instead of reading left-then-right:\n${text}`
  );
  // No line may carry both streams either (the glued-across-gutter failure).
  assert.ok(
    !lines.some((l) => l.includes("LEFT ") && l.includes("RIGHT ")),
    `streams glued into one line:\n${text}`
  );
});

// --- Straddling the gutter is not by itself full-width furniture (ADR 0025) --
// A run that crosses the gutter used to be promoted to a spanning region on
// that fact alone. Three shapes cross, and they need opposite treatment.

test("a figure's outdented label keeps its own dot-leader value", () => {
  // The p31 shape: a specification column whose labels sit right of the gutter,
  // except one outdented a few points left of it. Promoting that label to a
  // spanning region separated it from the value on its own leader line, which
  // stayed in the column — so the value read as belonging to the drawing
  // callout printed above it. Meaning loss, not just lost structure.
  // Coordinates are the real page's, which matter here: the callout is set in
  // TALLER type (h=10) than the label (h=8), and it is the callout's own
  // half-height reach — 5.0pt — that claims a label 4.7pt below it while
  // leaving that label's leader, 5.4pt below, to start a fresh row.
  const items = [];
  // Well-information block, bottom left: gives the left margin its start band.
  ["Well Number: DTX11", "Project", "U.S.G.S", "Longitude", "Local"].forEach(
    (s, k) => items.push(item(s, 78, 526 - k * 11, { w: 126, h: 8 }))
  );
  // Drawing callouts, left stream, taller type.
  [
    [122.7, 659.8, "Locking Cap and Padlock", 93],
    [169.3, 635.8, "Inner Well Cap", 54],
    [197.7, 616.8, "Vent hole", 35],
    [287, 596.4, "Drain", 18],
    [163.5, 239.6, "Bottom Cap", 45],
  ].forEach(([x, y, s, w]) => items.push(item(s, x, y, { w, h: 10 })));
  // Specification column, right of the gutter.
  [
    [565.9, "Borehole Diameter", '8 5/8"'],
    [549.6, "Casing Diameter", '2"'],
    [536.6, "Material", "PVC, SCH.40"],
    [415, "Setting", "24-31' BLS"],
    [245.9, "Total Depth of Well", "30' BLS"],
  ].forEach(([y, label, val]) => {
    items.push(item(label, 318, y, { w: 71, h: 8 }));
    items.push(item("...........", 392, y, { w: 33, h: 8 }));
    items.push(item(val, 428, y, { w: 70, h: 8 }));
  });
  // …and ONE label outdented left of the gutter, level with the first callout,
  // its leader and value on the next baseline down.
  items.push(item("Protective Casing", 290.3, 655.1, { w: 65.8, h: 8 }));
  items.push(item("...........", 357.7, 654.4, { w: 33.3, h: 8 }));
  items.push(item('6" x 6" steel cover', 391.7, 654.4, { w: 82.7, h: 8 }));

  const text = linesToText(reconstructLines(items));
  const line = text.split("\n").find((l) => l.includes("Protective Casing"));
  assert.ok(line, `label missing:\n${text}`);
  assert.match(
    line,
    /6" x 6" steel cover/,
    `label divorced from its own value — the value now reads as belonging to whatever precedes it:\n${text}`
  );
  // And the value must not have attached itself to a drawing callout instead.
  assert.ok(
    !text.split("\n").some((l) => /Inner Well Cap|Locking Cap/.test(l) && /steel cover/.test(l)),
    `value bound to an unrelated callout:\n${text}`
  );
});

test("a narrow column header above a value column still spans", () => {
  // The table-of-contents shape: the gutter falls between the entry labels and
  // the page numbers, and a short right-hand header ("Page") overhangs it. That
  // header is ALONE on its row — a header, not one cell of a two-stream row —
  // and demoting it costs the table the rows below it reconstruct into.
  const items = [];
  items.push(item("Page", 510, 400, { w: 25, h: 12 }));
  const entries = [
    ["FINANCIAL STATEMENT REQUIREMENTS", "3"],
    ["LEGISLATIVE UPDATES", "4"],
    ["SAMPLE FINANCIAL STATEMENTS", "5"],
    ["Independent Auditors' Report", "7"],
    ["Balance Sheet", "9"],
    ["Statement of Operations", "11"],
  ];
  entries.forEach(([label, page], k) => {
    const y = 370 - k * 26;
    items.push(item(`${label}............`, 72, y, { w: 420, h: 12 }));
    items.push(item(page, 519, y, { w: 7, h: 12 }));
  });
  const md = linesToMarkdown(reconstructLines(items));
  assert.match(
    md,
    /\|\s*FINANCIAL STATEMENT REQUIREMENTS[.…]*\s*\|\s*3\s*\|/,
    `dot-leader contents table no longer reconstructs its rows:\n${md}`
  );
});

test("a letterspaced running footer is not split at the gutter", () => {
  // The footer shape: one banner broken into several runs, straddling the
  // gutter. It has row-mates, but they sit on its OWN side — so it is not a
  // two-stream row, and splitting it severs the banner.
  const items = [];
  for (let k = 0; k < 10; k++) {
    items.push(item(`left column line ${k} of running text`, 42, 300 - k * 14, { w: 150, h: 10 }));
    items.push(item(`right column line ${k} of running text`, 303, 300 - k * 14, { w: 150, h: 10 }));
  }
  items.push(item("CL IMA TE R E", 290.8, 25.9, { w: 24, h: 6 }));
  items.push(item("OR T 2025", 311.3, 25.9, { w: 27, h: 6 }));
  items.push(item("MORGAN STANLEY", 375.4, 25.9, { w: 147, h: 6 }));
  const lines = linesToText(reconstructLines(items)).split("\n");
  assert.ok(
    !lines.some((l) => /^\s*CL IMA TE R E\s*$/.test(l)),
    `letterspaced footer split at the gutter:\n${lines.join("\n")}`
  );
});

// --- Centred narrow headings (SF-93) -----------------------------------------
// A heading centred over the whole measure spans the columns even when its
// text is too narrow to cross either corridor — SF-93's "10. PAST/CURRENT
// MEDICAL HISTORY" prints entirely inside the middle column's x-range of a
// three-column checklist. Left in a column it emits mid-stream, after all of
// column 1, and everything printed above the columns scrambles with it.
test("a centred larger-type heading spans columns it never crosses", () => {
  const items = [];
  const COLS = [0, 200, 400];
  // The heading: larger type, alone on its band, centred on the measure
  // (0–550), inside the middle column's x-range, and too close above the
  // columns for the gap flush to separate it (12pt < GAP_FLUSH * med).
  items.push(item("10. SECTION TITLE", 225, 312, { w: 100, h: 13 }));
  for (let k = 0; k < 12; k++) {
    const y = 300 - k * 14;
    items.push(item(`first column running text ${k} and`, COLS[0], y, { w: 150, h: 10 }));
    items.push(item(`second column running text ${k} and`, COLS[1], y, { w: 150, h: 10 }));
    items.push(item(`third column running text ${k} and`, COLS[2], y, { w: 150, h: 10 }));
  }
  const text = linesToText(reconstructLines(items));
  const heading = text.indexOf("10. SECTION TITLE");
  const firstFirst = text.indexOf("first column running text 0");
  const firstSecond = text.indexOf("second column running text 0");
  assert.ok(heading !== -1 && firstFirst !== -1);
  assert.ok(
    heading < firstFirst,
    `heading emitted mid-stream instead of before the columns:\n${text}`
  );
  // ...and the columns themselves still read column-major.
  assert.ok(text.lastIndexOf("first column running text 11") < firstSecond);
});

test("a wrapped column heading's last line is not promoted", () => {
  // The same centred narrow line with a same-size line one leading above it,
  // overlapping its x-range: that is the LAST LINE OF A WRAP (chart-heavy
  // p50's "STAGE TO MEMBERSHIP" under "ASSOCIATE MEMBER STATES IN THE PRE-"),
  // and promoting it to a spanning region tears the wrap from its opening.
  const items = [];
  const COLS = [0, 200, 400];
  items.push(item("ASSOCIATED MEMBER STATES", 210, 326, { w: 130, h: 13 }));
  items.push(item("10. SECTION TITLE", 225, 312, { w: 100, h: 13 }));
  for (let k = 0; k < 12; k++) {
    const y = 300 - k * 14;
    items.push(item(`first column running text ${k} and`, COLS[0], y, { w: 150, h: 10 }));
    items.push(item(`second column running text ${k} and`, COLS[1], y, { w: 150, h: 10 }));
    items.push(item(`third column running text ${k} and`, COLS[2], y, { w: 150, h: 10 }));
  }
  const text = linesToText(reconstructLines(items));
  const heading = text.indexOf("10. SECTION TITLE");
  const firstFirst = text.indexOf("first column running text 0");
  assert.ok(heading !== -1 && firstFirst !== -1);
  assert.ok(
    heading > firstFirst,
    `a wrap's last line was promoted over the columns:\n${text}`
  );
});
