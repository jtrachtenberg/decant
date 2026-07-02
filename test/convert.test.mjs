// Unit tests for the analysis-result → converter-contract mapping
// (src/convert/result.js). Pure — no pdf.js, no chrome.*.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { resultFromAnalysis } from "../src/convert/result.js";

const pdf = (name) => new File(["%PDF-fake"], name, { type: "application/pdf" });
const summary = { pageCount: 1, contentPages: 1, chartPages: 0, totalChars: 99, totalImages: 0 };

test("convert renames case-insensitively and returns a Markdown file", () => {
  const original = pdf("Report.PDF");
  const r = resultFromAnalysis(original, {
    decision: "convert",
    reason: "text",
    summary,
    markdown: "# hi\n",
  });
  assert.equal(r.action, "converted");
  assert.equal(r.file.name, "Report.md");
  assert.equal(r.file.type, "text/markdown");
  assert.equal(r.original, original); // original reference carried alongside
  assert.equal(r.meta, summary);
});

test("ambiguous carries both the original and the converted file", () => {
  const original = pdf("charts.pdf");
  const r = resultFromAnalysis(original, {
    decision: "ambiguous",
    reason: "text-with-charts",
    summary,
    markdown: "# hi\n",
  });
  assert.equal(r.action, "ambiguous");
  assert.equal(r.file, original); // safe default is the untouched original
  assert.equal(r.converted.name, "charts.md");
  assert.equal(r.converted.type, "text/markdown");
});

test("passthrough preserves the original file reference", () => {
  const original = pdf("scan.pdf");
  const r = resultFromAnalysis(original, {
    decision: "passthrough",
    reason: "no-text",
    summary,
    markdown: null,
  });
  assert.equal(r.action, "passthrough");
  assert.equal(r.file, original);
  assert.equal(r.reason, "no-text");
});

test("thrown analysis (null result) → passthrough with reason error", () => {
  const original = pdf("broken.pdf");
  const r = resultFromAnalysis(original, null);
  assert.deepEqual(r, { action: "passthrough", file: original, reason: "error" });
});
