// Unit tests for the chart-pages-only mini-PDF (src/convert/pdf-subset.js).
// pdf-lib both builds the source fixtures and verifies the output, so the
// whole path runs in Node — no binary fixtures, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import { buildChartPagesPdf, MAX_SUBSET_PAGES } from "../src/convert/pdf-subset.js";

// An n-page PDF whose page widths encode their 1-based number (100 + n), so
// assertions can tell exactly which pages were copied.
async function makePdf(n, name = "report.pdf") {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= n; i++) doc.addPage([100 + i, 200]);
  return new File([await doc.save()], name, { type: "application/pdf" });
}

async function pageWidths(file) {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  return doc.getPages().map((p) => Math.round(p.getWidth()));
}

test("subsets exactly the chart pages, in order, named <doc>-charts.pdf", async () => {
  const src = await makePdf(5, "who report.pdf");
  const out = await buildChartPagesPdf(src, { chartPageNumbers: [2, 4] });
  assert.equal(out.name, "who report-charts.pdf");
  assert.equal(out.type, "application/pdf");
  assert.deepEqual(await pageWidths(out), [102, 104]); // pages 2 and 4
});

test("null when there are no chart pages to subset", async () => {
  const src = await makePdf(3);
  assert.equal(await buildChartPagesPdf(src, { chartPageNumbers: [] }), null);
  assert.equal(await buildChartPagesPdf(src, {}), null);
  assert.equal(await buildChartPagesPdf(src, undefined), null);
});

test("out-of-range page numbers (sampled-doc extrapolation) drop out", async () => {
  const src = await makePdf(3);
  const out = await buildChartPagesPdf(src, { chartPageNumbers: [2, 99] });
  assert.deepEqual(await pageWidths(out), [102]);
  // All out of range → nothing to subset.
  assert.equal(await buildChartPagesPdf(src, { chartPageNumbers: [99] }), null);
});

test("page cap holds at MAX_SUBSET_PAGES, keeping the first pages", async () => {
  const n = MAX_SUBSET_PAGES + 5;
  const src = await makePdf(n);
  const all = Array.from({ length: n }, (_, i) => i + 1);
  const out = await buildChartPagesPdf(src, { chartPageNumbers: all });
  const widths = await pageWidths(out);
  assert.equal(widths.length, MAX_SUBSET_PAGES);
  assert.equal(widths[0], 101); // capped from the front
});
