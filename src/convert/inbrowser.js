// Shape A converter: in-browser PDF analysis + text extraction via pdf.js.
//
// analyzePdf() does one pass over the document gathering the per-page signals
// the classifier needs — extractable text and raster-image count — then asks
// classify.js what to do. Text is reconstructed regardless (it's the basis of
// the char count); the Markdown is assembled when the document is convertible
// (decision "convert" or "ambiguous"), so an ambiguous doc's converted version
// is ready if the user chooses it.
//
// The image count requires getOperatorList(), which is heavier than
// getTextContent() but does not rasterize. For typical uploads it is well
// under a second; documents beyond MAX_ANALYZE_PAGES get their operator lists
// sampled (every IMAGE_SAMPLE_INTERVAL-th page, extrapolated by classify.js)
// while text is still extracted from every page.

import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import {
  reconstructLines,
  linesToText,
  linesToMarkdown,
  countChars,
  classifyDocument,
  shouldScanImages,
  extrapolateImages,
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
  const pageMarkdown = [];
  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const lines = reconstructLines(content.items);
      // Char count drives classification; count raw text so it's unaffected by
      // Markdown decoration (headings/tables) added for output.
      perPage.push({
        chars: countChars(linesToText(lines)),
        images: shouldScanImages(n, pageCount) ? await countImages(page) : null,
      });
      pageMarkdown.push(linesToMarkdown(lines));
    }
  } finally {
    // destroy() lives on the loading task in pdf.js v6; it tears down the
    // document and the worker connection.
    await loadingTask.destroy();
  }

  const { decision, reason, summary } = classifyDocument(
    extrapolateImages(perPage)
  );
  const markdown =
    decision === "convert" || decision === "ambiguous"
      ? pageMarkdown.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
      : null;

  return { decision, reason, summary, markdown };
}

// Count raster-image paint operations on a page without rasterizing.
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
