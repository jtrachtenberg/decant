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
