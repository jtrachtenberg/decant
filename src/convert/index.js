// Converter interface — engine-agnostic entry point the content script calls.
// Milestone 1 wires in only the in-browser (shape A) PDF path; companion/http
// engines (shapes B/C) drop in here later behind the same return contract.
//
// convertFile(file) resolves to one of:
//   { action: "converted",   file, original, reason, meta }  swap in `file`
//   { action: "passthrough",  file, reason, meta }            leave `file` as-is
// In both cases `file` is what should be handed to the upload target, so the
// caller can treat the result uniformly.

import { analyzePdf } from "./inbrowser.js";

export async function convertFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return { action: "passthrough", file, reason: "not-pdf" };
  }

  try {
    const res = await analyzePdf(file);

    if (res.decision === "convert") {
      const name = file.name.replace(/\.pdf$/i, "") + ".md";
      const mdFile = new File([res.markdown], name, { type: "text/markdown" });
      return {
        action: "converted",
        file: mdFile,
        original: file,
        reason: res.reason,
        meta: res.summary,
      };
    }

    // "passthrough" (no usable text) and "ambiguous" (text + charts) both keep
    // the original for now. Ambiguous is where the per-file Convert / Send-
    // original toggle will later let the user opt into conversion; until then
    // we err toward never silently degrading a chart-bearing document.
    return { action: "passthrough", file, reason: res.reason, meta: res.summary };
  } catch (err) {
    console.error("[decant] analysis failed, passing original through:", err);
    return { action: "passthrough", file, reason: "error" };
  }
}
