// Unit tests for the token-savings estimate (src/convert/savings.js). Pure.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateSavings,
  aggregateSavings,
  IMAGE_TOKENS_PER_PAGE,
} from "../src/convert/savings.js";

const pdf = (pageCount, totalChars) => ({
  action: "converted",
  meta: { pageCount, totalChars },
});

test("estimateTokens is chars/4, rounded up, floored at 0", () => {
  assert.equal(estimateTokens(0), 0);
  assert.equal(estimateTokens(4), 1);
  assert.equal(estimateTokens(5), 2);
  assert.equal(estimateTokens(4000), 1000);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens(-10), 0);
});

test("estimateSavings on a PDF = eliminated page-images plus the text base", () => {
  const s = estimateSavings(pdf(10, 8000));
  assert.equal(s.markdownTokens, 2000); // 8000 / 4
  assert.equal(s.savedTokens, 10 * IMAGE_TOKENS_PER_PAGE);
  assert.equal(s.originalTokens, 2000 + 10 * IMAGE_TOKENS_PER_PAGE);
});

test("estimateSavings returns null for non-PDF results (no pageCount)", () => {
  assert.equal(estimateSavings({ action: "converted", meta: { images: 2 } }), null);
  assert.equal(estimateSavings({ action: "converted", meta: { sheets: 1 } }), null);
  assert.equal(estimateSavings({ action: "passthrough", meta: null }), null);
  assert.equal(estimateSavings(undefined), null);
});

test("aggregateSavings sums PDFs and ignores non-estimable results", () => {
  const agg = aggregateSavings([
    pdf(10, 8000),
    { action: "converted", meta: { images: 0 } }, // DOCX — ignored
    pdf(2, 400),
  ]);
  assert.equal(agg.files, 2);
  assert.equal(agg.savedTokens, 12 * IMAGE_TOKENS_PER_PAGE);
  // percent = saved / (saved + markdown); markdown = (8000+400)/4 = 2100
  const md = 2100;
  assert.equal(agg.percent, Math.round((6000 / (6000 + md)) * 100));
});

test("aggregateSavings returns null when nothing is estimable", () => {
  assert.equal(aggregateSavings([{ action: "converted", meta: { images: 1 } }]), null);
  assert.equal(aggregateSavings([]), null);
  assert.equal(aggregateSavings(null), null);
});

test("a text-light PDF shows a high savings percent (image-dominated)", () => {
  const agg = aggregateSavings([pdf(10, 400)]); // 100 md tokens, 5000 saved
  assert.ok(agg.percent >= 90, `expected high percent, got ${agg.percent}`);
});
