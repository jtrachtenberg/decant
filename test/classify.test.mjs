// Unit tests for the document classifier. Pure logic, no PDFs — each case is a
// synthetic per-page profile mirroring a real corpus file's signature.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyDocument,
  countChars,
  MIN_CHART_PAGES_FOR_AMBIGUOUS,
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
