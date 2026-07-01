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

import { analyzePdf } from "./inbrowser.js";

function markdownFile(original, markdown) {
  const name = original.name.replace(/\.pdf$/i, "") + ".md";
  return new File([markdown], name, { type: "text/markdown" });
}

export async function convertFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return { action: "passthrough", file, reason: "not-pdf" };
  }

  try {
    const res = await analyzePdf(file);

    if (res.decision === "convert") {
      return {
        action: "converted",
        file: markdownFile(file, res.markdown),
        original: file,
        reason: res.reason,
        meta: res.summary,
      };
    }

    if (res.decision === "ambiguous") {
      // Text plus meaningful charts: converting to text-only would drop the
      // charts, so let the user choose. Default (`file`) is the original.
      return {
        action: "ambiguous",
        file,
        converted: markdownFile(file, res.markdown),
        reason: res.reason,
        meta: res.summary,
      };
    }

    // "passthrough" (no usable text): keep the original untouched.
    return { action: "passthrough", file, reason: res.reason, meta: res.summary };
  } catch (err) {
    console.error("[decant] analysis failed, passing original through:", err);
    return { action: "passthrough", file, reason: "error" };
  }
}
