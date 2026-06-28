// Converter interface — engine-agnostic entry point the content script calls.
// Milestone 1 wires in only the in-browser (shape A) PDF path; companion/http
// engines (shapes B/C) drop in here later behind the same return contract.
//
// convertFile(file) resolves to one of:
//   { action: "converted",   file, original, meta }  swap in `file`
//   { action: "passthrough",  file, reason }           leave `file` as-is
// In both cases `file` is what should be handed to the upload target, so the
// caller can treat the result uniformly.

import { pdfToMarkdown } from "./inbrowser.js";

export async function convertFile(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return { action: "passthrough", file, reason: "not-pdf" };
  }

  try {
    const res = await pdfToMarkdown(file);
    if (!res.ok) {
      // Scanned / image-only: converting would drop the visual content.
      return { action: "passthrough", file, reason: res.reason };
    }
    const name = file.name.replace(/\.pdf$/i, "") + ".md";
    const mdFile = new File([res.markdown], name, { type: "text/markdown" });
    return {
      action: "converted",
      file: mdFile,
      original: file,
      meta: { pageCount: res.pageCount, avgChars: res.avgChars },
    };
  } catch (err) {
    console.error("[decant] conversion failed, passing original through:", err);
    return { action: "passthrough", file, reason: "error" };
  }
}
