// Unit tests for the chart-pages-only mini-PDF (src/convert/pdf-subset.js).
// pdf-lib both builds the source fixtures and verifies the output, so the
// whole path runs in Node — no binary fixtures, no browser.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";
import {
  buildChartPagesPdf,
  MAX_SUBSET_PAGES,
  STAMP_STRIP_PT,
} from "../src/convert/pdf-subset.js";

// An n-page PDF whose page widths encode their 1-based number (100 + n), so
// assertions can tell exactly which pages were copied.
async function makePdf(n, name = "report.pdf") {
  const doc = await PDFDocument.create();
  for (let i = 1; i <= n; i++) doc.addPage([100 + i, 200]);
  return new File([await doc.save()], name, { type: "application/pdf" });
}

async function pageSizes(file) {
  const doc = await PDFDocument.load(await file.arrayBuffer());
  return doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())]);
}

// A valid 1×1 PNG, for exercising the crop-embedding path.
const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  ),
  (c) => c.charCodeAt(0)
);

test("subsets exactly the chart pages, in order, named <doc>-charts.pdf", async () => {
  const src = await makePdf(5, "who report.pdf");
  const out = await buildChartPagesPdf(src, { chartPageNumbers: [2, 4] });
  assert.equal(out.file.name, "who report-charts.pdf");
  assert.equal(out.file.type, "application/pdf");
  assert.deepEqual(out.pages, [2, 4]); // the association map for the footer
  assert.deepEqual(await pageSizes(out.file), [
    [102, 200],
    [104, 200],
  ]);
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
  assert.deepEqual(out.pages, [2]);
  assert.deepEqual(await pageSizes(out.file), [[102, 200]]);
  // All out of range → nothing to subset.
  assert.equal(await buildChartPagesPdf(src, { chartPageNumbers: [99] }), null);
});

test("page cap holds at MAX_SUBSET_PAGES, keeping the first pages", async () => {
  const n = MAX_SUBSET_PAGES + 5;
  const src = await makePdf(n);
  const all = Array.from({ length: n }, (_, i) => i + 1);
  const out = await buildChartPagesPdf(src, { chartPageNumbers: all });
  assert.equal(out.pages.length, MAX_SUBSET_PAGES);
  assert.equal(out.pages[0], 1); // capped from the front
});

test("a cropped page embeds at the crop's size (plus stamp strip); others copy whole", async () => {
  const src = await makePdf(5);
  const crops = new Map([[2, { png: PNG_1x1, widthPt: 300, heightPt: 180 }]]);
  const out = await buildChartPagesPdf(src, { chartPageNumbers: [2, 4] }, crops);
  assert.deepEqual(out.pages, [2, 4]);
  assert.deepEqual(await pageSizes(out.file), [
    [300, Math.round(180 + STAMP_STRIP_PT)], // crop + "document page 2" strip
    [104, 200], // whole-page vector copy (stamp overlays, size unchanged)
  ]);
});