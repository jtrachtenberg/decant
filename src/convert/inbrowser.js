// Shape A converter: in-browser PDF analysis + text extraction via pdf.js.
//
// analyzePdf() does one pass over the document gathering the per-page signals
// the classifier needs — extractable text and raster-image count — then asks
// classify.js what to do. Text is reconstructed regardless (it's the basis of
// the char count); the Markdown is only assembled when the decision is convert.
//
// The image count requires getOperatorList(), which is heavier than
// getTextContent() but does not rasterize. For very large documents this is
// the cost worth sampling later (see TODO); for typical uploads it is well
// under a second.

import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import {
  itemsToText,
  countChars,
  classifyDocument,
  IMAGE_OP_NAMES,
} from "./classify.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjsLib.OPS[name]));

export async function analyzePdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({ data });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  const perPage = [];
  const pageTexts = [];
  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const text = itemsToText(content.items);
      pageTexts.push(text);
      perPage.push({ chars: countChars(text), images: await countImages(page) });
    }
  } finally {
    // destroy() lives on the loading task in pdf.js v6; it tears down the
    // document and the worker connection.
    await loadingTask.destroy();
  }

  const { decision, reason, summary } = classifyDocument(perPage);
  const markdown =
    decision === "convert"
      ? pageTexts.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
      : null;

  return { decision, reason, summary, markdown };
}

// Count raster-image paint operations on a page without rasterizing.
// TODO: for very large documents, sample pages instead of scanning every one.
async function countImages(page) {
  try {
    const ops = await page.getOperatorList();
    let images = 0;
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
    return images;
  } catch {
    return 0; // operator list unavailable — treat as no images
  }
}
