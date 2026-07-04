// Unit tests for the analysis-result → converter-contract mapping
// (src/convert/result.js). Pure — no pdf.js, no chrome.*.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resultFromAnalysis,
  shouldEscalate,
  ESCALATE_REASONS,
} from "../src/convert/result.js";

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

// --- Forward escalation predicate (shouldEscalate) -------------------------

const companionRule = {
  action: "inbrowser",
  onEmpty: "companion",
  endpoint: "http://127.0.0.1:8765/convert-raw",
};

test("escalates a scanned passthrough when a companion is configured", () => {
  const res = { action: "passthrough", reason: "no-text", file: pdf("scan.pdf") };
  assert.equal(shouldEscalate(res, companionRule), true);
});

test("browser-only user (no onEmpty/endpoint) never escalates — scan passes through", () => {
  const res = { action: "passthrough", reason: "no-text", file: pdf("scan.pdf") };
  assert.equal(shouldEscalate(res, { action: "inbrowser", onError: "passthrough" }), false);
  assert.equal(shouldEscalate(res, { action: "inbrowser", onEmpty: "companion" }), false); // no endpoint
});

test("only browser-came-up-empty reasons escalate; success/ambiguous/error do not", () => {
  assert.deepEqual(ESCALATE_REASONS, ["no-text", "no-engine"]);
  for (const reason of ESCALATE_REASONS) {
    assert.equal(shouldEscalate({ action: "passthrough", reason }, companionRule), true);
  }
  assert.equal(shouldEscalate({ action: "converted", reason: "text" }, companionRule), false);
  assert.equal(shouldEscalate({ action: "ambiguous", reason: "text-with-charts" }, companionRule), false);
  for (const reason of ["routed-passthrough", "unrouted", "error"]) {
    assert.equal(shouldEscalate({ action: "passthrough", reason }, companionRule), false);
  }
});

test("onEmpty must be a real escalation target, not a fallback verb", () => {
  const res = { action: "passthrough", reason: "no-text" };
  assert.equal(shouldEscalate(res, { ...companionRule, onEmpty: "passthrough" }), false);
  assert.equal(shouldEscalate(res, { ...companionRule, onEmpty: "inbrowser" }), false);
  assert.equal(shouldEscalate(res, { ...companionRule, onEmpty: "http" }), true);
});
