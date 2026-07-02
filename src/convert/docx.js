// In-browser DOCX engine (shape A) — mammoth.js converts the document to
// Markdown. DOCX sits squarely on the parsing side of the
// parsing-vs-recognition line (it's zipped XML), so no classifier pass is
// needed the way PDFs need one; the only judgment call is images.
//
// Images: mammoth inlines them as data-URI markdown images, which would bloat
// the output with base64 far beyond what the original upload costs — the
// opposite of the point. They're stripped, and per the core rule that Decant
// never silently degrades a visual document (ARCHITECTURE §5), a document
// that *had* images comes back "ambiguous" so the user chooses between
// Markdown-without-images and the untouched original.
//
// analyzeDocx() returns the same { decision, reason, summary, markdown }
// shape as analyzePdf(), so resultFromAnalysis() wraps both engines.
//
// The mammoth.browser build is imported directly: it bundles cleanly for the
// extension and also loads in Node, so unit tests exercise the real engine.
// Legacy binary .doc is NOT supported (mammoth reads OOXML only) — routing
// defaults deliberately match .docx alone.

import * as mammothNs from "mammoth/mammoth.browser.js";

const mammoth = mammothNs.default ?? mammothNs;

// Remove data-URI images from mammoth's Markdown and count them. Exported
// for direct unit testing. Alt text (rarely present) goes with the image —
// a caption without its figure reads as noise, not content.
export function stripDataUriImages(markdown) {
  let images = 0;
  const stripped = markdown.replace(/!\[[^\]]*\]\(data:[^)]*\)/g, () => {
    images++;
    return "";
  });
  return { markdown: stripped.replace(/\n{3,}/g, "\n\n").trim(), images };
}

// Decision over mammoth's raw Markdown — pure, exported for tests.
export function docxAnalysis(rawMarkdown) {
  const { markdown, images } = stripDataUriImages(rawMarkdown);
  const summary = { images, chars: markdown.length };
  if (!markdown) {
    return { decision: "passthrough", reason: "no-text", summary, markdown: null };
  }
  return {
    decision: images > 0 ? "ambiguous" : "convert",
    reason: images > 0 ? "text-with-images" : "text",
    summary,
    markdown: markdown + "\n",
  };
}

export async function analyzeDocx(file) {
  const { value } = await mammoth.convertToMarkdown({
    arrayBuffer: await file.arrayBuffer(),
  });
  return docxAnalysis(value);
}
