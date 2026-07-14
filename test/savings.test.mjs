// Unit tests for the token-savings estimate (src/convert/savings.js). Pure.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateTokens,
  estimateSavings,
  aggregateSavings,
  formatTokens,
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

test("reattached figure pages are netted out of the savings claim", () => {
  // "Convert + attach figures" on an 88-page PDF with 11 chart pages: the
  // 11 reattached pages' image layer was NOT saved.
  const s = estimateSavings({ ...pdf(88, 100000), attachedFigurePages: 11 });
  assert.equal(s.savedTokens, (88 - 11) * IMAGE_TOKENS_PER_PAGE);
  // The original's price still includes every page — percent stays honest.
  assert.equal(s.originalTokens, 25000 + 88 * IMAGE_TOKENS_PER_PAGE);
  // Degenerate: everything reattached → nothing saved, never negative.
  const zero = estimateSavings({ ...pdf(5, 4000), attachedFigurePages: 9 });
  assert.equal(zero.savedTokens, 0);
});

test("estimateSavings returns null for non-PDF results (no pageCount)", () => {
  assert.equal(estimateSavings({ action: "converted", meta: { images: 2 } }), null);
  assert.equal(estimateSavings({ action: "converted", meta: { sheets: 1 } }), null);
  assert.equal(estimateSavings({ action: "passthrough", meta: null }), null);
  assert.equal(estimateSavings(undefined), null);
  // The "Convert + attach figures" choice sends Markdown plus image files —
  // any claimed savings would have to net out the attached figures' image
  // cost. Office results (the only figure-eligible type) estimate null, so
  // the badge stays silent rather than overstating (see savings.js NOTE).
  assert.equal(
    estimateSavings({ action: "ambiguous", meta: { images: 6, chars: 9000 } }),
    null
  );
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

test("formatTokens compacts thousands, one decimal below 10k", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(9999), "10.0k");
  assert.equal(formatTokens(25000), "25k");
});
