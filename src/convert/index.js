// Converter interface — engine-agnostic entry point the content script calls.
// Milestone 1 wires in only the in-browser (shape A) PDF path; companion/http
// engines (shapes B/C) drop in here later behind the same return contract.
//
// convertFile(file) resolves to one of:
//   { action: "converted",   file, original, reason, meta }  swap in `file`
//   { action: "passthrough", file, reason, meta }            leave `file` as-is
//   { action: "ambiguous",   file, converted, reason, meta } user chooses:
//       `file` is the original (safe default), `converted` is the Markdown.
// `file` is always the safe/default thing to hand the upload; callers that
// support a choice look at `converted`.
//
// The analysis-result → contract mapping lives in result.js (pure, testable).

import { analyzePdf } from "./inbrowser.js";
import { resultFromAnalysis } from "./result.js";

export async function convertFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return { action: "passthrough", file, reason: "not-pdf" };
  }

  let res = null;
  try {
    res = await analyzePdf(file);
  } catch (err) {
    console.error("[decant] analysis failed, passing original through:", err);
  }
  return resultFromAnalysis(file, res);
}
