// Unit tests for the document classifier. Pure logic, no PDFs — each case is a
// synthetic per-page profile mirroring a real corpus file's signature.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDocument,
  countChars,
  shouldScanImages,
  extrapolateImages,
  appendOmittedImagesNote,
  hasOmittedChartTable,
  selectChartPages,
  MIN_CHART_PAGES_FOR_AMBIGUOUS,
  MAX_ANALYZE_PAGES,
  IMAGE_SAMPLE_INTERVAL,
} from "../src/convert/classify.js";

test("clean text PDF → convert (claudetest profile)", () => {
  const res = classifyDocument([{ chars: 84, images: 0 }]);
  assert.equal(res.decision, "convert");
});

test("no extractable text → passthrough (vector/scan form profile)", () => {
  const res = classifyDocument([
    { chars: 0, images: 2 },
    { chars: 0, images: 1 },
    { chars: 0, images: 0 },
    { chars: 0, images: 0 },
  ]);
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});

test("text with many image-charts → ambiguous (WHO profile)", () => {
  const pages = [];
  for (let i = 0; i < 77; i++) pages.push({ chars: 3000, images: 0 });
  for (let i = 0; i < 11; i++) pages.push({ chars: 3000, images: 2 });
  const res = classifyDocument(pages);
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.summary.chartPages, 11);
  // The summary names WHICH pages (1-based) so pdf-figures.js can render
  // exactly the chart pages: 78..88 here.
  assert.deepEqual(
    res.summary.chartPageNumbers,
    Array.from({ length: 11 }, (_, i) => 78 + i)
  );
});

test("chartPageNumbers stays consistent with the chartPages count", () => {
  const res = classifyDocument([
    { chars: 2000, images: 0 },
    { chars: 2000, images: 1 }, // page 2 — chart page
    { chars: 10, images: 3 }, // image-only page: not a chart page (no text)
    { chars: 2000, images: 2 }, // page 4 — chart page
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, [2, 4]);
  assert.equal(res.summary.chartPages, 2);
});

test("text with a single incidental image → convert (header logo)", () => {
  const res = classifyDocument([
    { chars: 2000, images: 0 },
    { chars: 2000, images: 1 },
  ]);
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "text-incidental-image");
});

test("ambiguous threshold is exactly MIN_CHART_PAGES_FOR_AMBIGUOUS", () => {
  const justUnder = [{ chars: 999, images: 0 }];
  for (let i = 0; i < MIN_CHART_PAGES_FOR_AMBIGUOUS - 1; i++)
    justUnder.push({ chars: 999, images: 1 });
  assert.equal(classifyDocument(justUnder).decision, "convert");

  const atThreshold = [{ chars: 999, images: 0 }];
  for (let i = 0; i < MIN_CHART_PAGES_FOR_AMBIGUOUS; i++)
    atThreshold.push({ chars: 999, images: 1 });
  assert.equal(classifyDocument(atThreshold).decision, "ambiguous");
});

test("a single SIGNIFICANT figure bypasses the page-count threshold", () => {
  // One chart page whose image is figure-sized and pixel-bearing (a real
  // chart/photo) → the user decides, even below MIN_CHART_PAGES_FOR_AMBIGUOUS.
  const res = classifyDocument([{ chars: 500, images: 1, figureImages: 1 }]);
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-figure"); // distinct: corpus-gradeable
  assert.equal(res.summary.figurePages, 1);
});

test("a single insignificant image (logo) still converts", () => {
  // Scanned page, image present but NOT figure-significant → today's quiet
  // behavior is preserved: no prompt for letterhead art.
  const res = classifyDocument([{ chars: 500, images: 1, figureImages: 0 }]);
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "text-incidental-image");
});

test("perPage without the figureImages field behaves exactly as before", () => {
  // Back-compat: producers that don't compute significance (older callers,
  // extrapolated pages from legacy shapes) keep the page-count rule only.
  const res = classifyDocument([{ chars: 500, images: 1 }]);
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "text-incidental-image");
});

test("a significant figure on a NO-text page doesn't trigger the prompt", () => {
  // Image-only page (below the char floor) isn't a chart page — the
  // passthrough/convert logic owns that case, not the figure trigger.
  const res = classifyDocument([
    { chars: 2000, images: 0 },
    { chars: 10, images: 1, figureImages: 1 },
  ]);
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "text");
});

test("sparse text just over the per-page floor still counts as content", () => {
  // 60 non-whitespace chars > 50 floor → a content page, not empty.
  const res = classifyDocument([{ chars: 60, images: 0 }]);
  assert.equal(res.decision, "convert");
});

test("countChars ignores whitespace", () => {
  assert.equal(countChars("  a b\n c\t "), 3);
  assert.equal(countChars("   \n\t  "), 0);
});

test("appendOmittedImagesNote marks pages that had images, and only those", () => {
  assert.equal(appendOmittedImagesNote("page text", 0), "page text");
  assert.equal(appendOmittedImagesNote("page text", 1), "page text\n\n[1 image omitted]");
  assert.equal(appendOmittedImagesNote("page text", 3), "page text\n\n[3 images omitted]");
  assert.equal(appendOmittedImagesNote("", 2), "[2 images omitted]");
  // With a page number the marker is anchored, so it can be matched to an
  // attached figures PDF (whose footer names document pages).
  assert.equal(
    appendOmittedImagesNote("page text", 2, 17),
    "page text\n\n[2 images omitted — page 17]"
  );
  // Printed page labels (PDF label table) pass through as-is: the WHO doc's
  // physical page 17 is printed "7", and front matter is "i, ii, …".
  assert.equal(
    appendOmittedImagesNote("page text", 2, "7"),
    "page text\n\n[2 images omitted — page 7]"
  );
  assert.equal(
    appendOmittedImagesNote("page text", 1, "iv"),
    "page text\n\n[1 image omitted — page iv]"
  );
});

test("shouldScanImages scans every page at or below the ceiling", () => {
  for (let n = 1; n <= MAX_ANALYZE_PAGES; n++) {
    assert.equal(shouldScanImages(n, MAX_ANALYZE_PAGES), true);
  }
});

test("shouldScanImages samples every interval-th page above the ceiling", () => {
  const pageCount = MAX_ANALYZE_PAGES + 100;
  const scanned = [];
  for (let n = 1; n <= pageCount; n++) {
    if (shouldScanImages(n, pageCount)) scanned.push(n);
  }
  assert.equal(scanned[0], 1); // first page always scanned
  for (let i = 1; i < scanned.length; i++) {
    assert.equal(scanned[i] - scanned[i - 1], IMAGE_SAMPLE_INTERVAL);
  }
});

test("extrapolateImages passes fully-scanned input through unchanged", () => {
  const perPage = [
    { chars: 100, images: 0 },
    { chars: 100, images: 2 },
  ];
  assert.equal(extrapolateImages(perPage), perPage);
});

test("extrapolateImages carries figureImages alongside images", () => {
  const filled = extrapolateImages([
    { chars: 100, images: 2, figureImages: 1 },
    { chars: 100, images: null },
  ]);
  assert.equal(filled[1].images, 2);
  assert.equal(filled[1].figureImages, 1); // nearest-fill, same as images
});

test("extrapolateImages fills unscanned pages from the nearest sample", () => {
  const filled = extrapolateImages([
    { chars: 100, images: 0 }, // scanned
    { chars: 100, images: null },
    { chars: 100, images: null },
    { chars: 100, images: 3 }, // scanned — nearer to the two below
    { chars: 100, images: null },
  ]);
  assert.deepEqual(
    filled.map((p) => p.images),
    [0, 0, 3, 3, 3]
  );
});

test("sampled large doc with a chart section still classifies ambiguous", () => {
  // 300-page document, operator lists scanned on pages 1, 6, 11, … only.
  // Pages 200-250 are a chart section; the sampled hits inside it must
  // extrapolate to enough chart pages to trip the ambiguous threshold.
  const pageCount = MAX_ANALYZE_PAGES * 2;
  const perPage = [];
  for (let n = 1; n <= pageCount; n++) {
    const inChartSection = n >= 200 && n <= 250;
    perPage.push({
      chars: 3000,
      images: shouldScanImages(n, pageCount) ? (inChartSection ? 2 : 0) : null,
    });
  }
  const res = classifyDocument(extrapolateImages(perPage));
  assert.equal(res.decision, "ambiguous");
});

test("sampled large clean-text doc still classifies convert", () => {
  const pageCount = MAX_ANALYZE_PAGES * 2;
  const perPage = [];
  for (let n = 1; n <= pageCount; n++) {
    perPage.push({
      chars: 3000,
      images: shouldScanImages(n, pageCount) ? 0 : null,
    });
  }
  const res = classifyDocument(extrapolateImages(perPage));
  assert.equal(res.decision, "convert");
});

// --- Flattened chart pages (Tier 2 convergence → figures flow) --------------

test("a flattened text page with ZERO images is a chart page (vector chart)", () => {
  // CERN Annual Report profile: the one genuine chart page ("CERN in
  // figures") is pure vector — no raster paints — but Tier 2 convergence
  // flags its text as a flattened figure. It must join chartPageNumbers or
  // the Markdown warns "values unreliable" while attaching nothing.
  const res = classifyDocument([
    { chars: 2000, images: 0 },
    { chars: 978, images: 0, flattened: true },
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, [2]);
  assert.deepEqual(res.summary.flattenedPageNumbers, [2]);
  // A flattened chart is a significant figure: it earns the prompt alone.
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-figure");
  assert.equal(res.summary.figurePages, 1);
});

test("a flattened NO-text page is not a chart page", () => {
  const res = classifyDocument([
    { chars: 2000, images: 0 },
    { chars: 10, images: 0, flattened: true },
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, []);
  assert.equal(res.decision, "convert");
});

test("flattened + image page lands in flattenedPageNumbers, not figurePageNumbers", () => {
  const res = classifyDocument([
    { chars: 900, images: 2, figureImages: 1, flattened: true },
    { chars: 900, images: 1, figureImages: 1 },
    { chars: 900, images: 1, figureImages: 0 },
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, [1, 2, 3]);
  assert.deepEqual(res.summary.flattenedPageNumbers, [1]);
  assert.deepEqual(res.summary.figurePageNumbers, [2]);
});

test("hasOmittedChartTable recognizes the omitted-table note", () => {
  assert.equal(
    hasOmittedChartTable(
      "prose\n\n[chart table omitted — unreliable extraction; see attached figure, document page 7]"
    ),
    true
  );
  assert.equal(hasOmittedChartTable("plain prose"), false);
  assert.equal(hasOmittedChartTable(null), false);
});

// --- selectChartPages: value-ranked selection under the page caps -----------

test("selectChartPages: plain image pages don't attach when real figures exist", () => {
  // The clean-text regression: one genuine chart page plus text pages whose
  // only image is a letterhead logo. The logo pages made chartPageNumbers,
  // but the significance gate judged their images non-figures — attaching
  // them dilutes the real figure.
  const meta = {
    chartPageNumbers: [3, 5, 9],
    flattenedPageNumbers: [9],
    figurePageNumbers: [5],
  };
  assert.deepEqual(selectChartPages(meta, 8), [5, 9]);
});

test("selectChartPages: over the cap, flattened outrank figures, in page order", () => {
  // Annual-report profile: significant photos from page 3 on, the real chart
  // at the back. Page-order truncation would keep 3..6 and drop page 53.
  const meta = {
    chartPageNumbers: [3, 4, 5, 6, 7, 53],
    flattenedPageNumbers: [53],
    figurePageNumbers: [3, 4, 5, 6, 7],
  };
  // cap 4 → the flattened chart page makes it first, figures fill the rest
  // front-first; ascending page order.
  assert.deepEqual(selectChartPages(meta, 4), [3, 4, 5, 53]);
});

test("selectChartPages: no stronger evidence → all image pages attach (volume fallback)", () => {
  // Volume-triggered ambiguity: several image-bearing pages, none flagged
  // significant or flattened. The image pages are the only candidates for
  // whatever the significance gate missed, so they attach as before.
  const meta = {
    chartPageNumbers: [2, 4, 6],
    flattenedPageNumbers: [],
    figurePageNumbers: [],
  };
  assert.deepEqual(selectChartPages(meta, 8), [2, 4, 6]);
});

test("selectChartPages: missing rank arrays degrade to page-order slice", () => {
  const meta = { chartPageNumbers: [2, 4, 6, 8] };
  assert.deepEqual(selectChartPages(meta, 2), [2, 4]);
  assert.deepEqual(selectChartPages(null, 2), []);
});
