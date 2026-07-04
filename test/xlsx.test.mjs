// Unit tests for the XLSX engine (src/convert/xlsx.js): the pure
// rows→Markdown-table logic plus real SheetJS parsing against the committed
// fixtures (regenerate with scripts/make-xlsx-fixtures.mjs).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzeXlsx, rowsToMarkdownTable, MAX_CELLS } from "../src/convert/xlsx.js";

const fixture = async (name) => {
  const buf = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
};

test("rowsToMarkdownTable renders header, separator, and body", () => {
  assert.equal(
    rowsToMarkdownTable([
      ["Name", "Score"],
      ["alpha", 10],
    ]),
    "| Name | Score |\n| --- | --- |\n| alpha | 10 |"
  );
});

test("rowsToMarkdownTable escapes pipes, flattens newlines, pads ragged rows", () => {
  const md = rowsToMarkdownTable([
    ["a|b", "two\nlines", ""],
    ["only-one"],
  ]);
  assert.equal(md, "| a\\|b | two lines |\n| --- | --- |\n| only-one |  |");
});

test("rowsToMarkdownTable escapes backslashes before pipes (CodeQL autofix regression)", () => {
  // The CodeQL autofix added backslash-doubling. It must run BEFORE pipe
  // escaping: a literal backslash is doubled so it survives Markdown, and the
  // `\` that pipe escaping itself introduces must NOT be doubled again. So a
  // cell holding `a\|b` (backslash then pipe) escapes to `a\\\|b`, not
  // `a\\\\|b`. A Windows path exercises the plain backslash-doubling case.
  const md = rowsToMarkdownTable([
    ["path", "mix"],
    ["C:\\tmp", "a\\|b"],
  ]);
  assert.equal(md, "| path | mix |\n| --- | --- |\n| C:\\\\tmp | a\\\\\\|b |");
});

test("rowsToMarkdownTable trims trailing empty rows and columns", () => {
  const md = rowsToMarkdownTable([
    ["x", "", ""],
    ["y", "", ""],
    ["", "", ""],
  ]);
  assert.equal(md, "| x |\n| --- |\n| y |");
});

test("rowsToMarkdownTable returns empty string for nothing", () => {
  assert.equal(rowsToMarkdownTable([]), "");
  assert.equal(rowsToMarkdownTable([[""], [""]]), "");
});

test("tiny.xlsx converts: two sheets, escaped cells, trimmed padding (real SheetJS)", async () => {
  const res = await analyzeXlsx(await fixture("tiny.xlsx"));
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "table");
  assert.equal(res.summary.tables, 2);
  assert.match(res.markdown, /^## Sheet: Budget/m);
  assert.match(res.markdown, /\| Region \| Q1 \| Q2 \| Notes \|/);
  assert.match(res.markdown, /on\\\|track/); // pipe escaped
  assert.match(res.markdown, /supply issue/); // newline flattened
  assert.match(res.markdown, /^## Sheet: List/m);
  assert.doesNotMatch(res.markdown, /\|\s*\|\s*\|\s*\|\s*\|\n$/); // no trailing empty row
});

test("empty.xlsx passes through with no-text (real SheetJS)", async () => {
  const res = await analyzeXlsx(await fixture("empty.xlsx"));
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});

test("cell-count cap routes huge workbooks to passthrough", async () => {
  // Build an in-memory workbook just over the cap via the generator's own
  // path: cheaper to synthesize rows and count than to commit a huge binary.
  const rows = [];
  const cols = 10;
  for (let r = 0; r < Math.ceil((MAX_CELLS + 1) / cols); r++) {
    rows.push(Array.from({ length: cols }, (_, c) => `r${r}c${c}`));
  }
  const XLSX = (await import("xlsx")).default ?? (await import("xlsx"));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), "Big");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const res = await analyzeXlsx(new File([buf], "big.xlsx"));
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "too-large");
});

test("chart.xlsx recovers the chart data after the sheet (real SheetJS + zip)", async () => {
  const res = await analyzeXlsx(await fixture("chart.xlsx"));
  assert.equal(res.decision, "convert");
  assert.equal(res.summary.chartsRecovered, 1);
  assert.match(res.markdown, /## Sheet: Data/);
  assert.match(res.markdown, /## Chart: Sales/);
  assert.match(res.markdown, /\| Category \| Sales \|/);
  assert.match(res.markdown, /\| Feb \| 12 \|/);
});
