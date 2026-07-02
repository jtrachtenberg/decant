// Pure mapping from a PDF analysis outcome to the converter's return contract
// (documented in index.js). Deliberately imports nothing — no pdf.js, no
// chrome.* — so the mapping is unit-testable in Node (test/convert.test.mjs);
// index.js can't be imported there because its pdf.js dependency touches
// chrome.runtime at module load.

function markdownFile(original, markdown) {
  const name = original.name.replace(/\.[a-z0-9]+$/i, "") + ".md";
  return new File([markdown], name, { type: "text/markdown" });
}

// `res` is an engine analysis result (analyzePdf / analyzeDocx), or null when
// analysis threw — the caller logs the error and the file passes through
// untouched with reason "error".
export function resultFromAnalysis(file, res) {
  if (!res) {
    return { action: "passthrough", file, reason: "error" };
  }

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
}
