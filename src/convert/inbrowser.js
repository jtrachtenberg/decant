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
  reconstructPage,
  linesToText,
  linesToMarkdown,
  countChars,
  classifyDocument,
  shouldScanImages,
  extrapolateImages,
  appendOmittedImagesNote,
  IMAGE_OP_NAMES,
} from "./classify.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

// pdf.js needs the metrics for the 14 standard PDF fonts when a document uses
// one without embedding it; without this it warns ("Ensure that the
// standardFontDataUrl API parameter is provided") on every such file. We ship
// pdf.js's own standard_fonts/ (see build.mjs) and point at it via the dynamic
// extension URL (trailing slash required — pdf.js appends the font filename).
// Exported for pdf-figures.js, which re-opens the document to render pages.
export const STANDARD_FONT_DATA_URL = chrome.runtime.getURL("standard_fonts/");

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjsLib.OPS[name]));

export async function analyzePdf(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  const pdf = await loadingTask.promise;
  const pageCount = pdf.numPages;

  // The document's printed page labels ("OFC1, i, ii, …, 1, 2") when the PDF
  // defines them. Markers, figure stamps, and footers speak this numbering —
  // it's what the document's own TOC and cross-references use, and what's
  // visibly printed on the rendered pages (WHO doc: physical page 17 is
  // printed "7"). Physical indices stay the internal key everywhere else.
  let pageLabels = null;
  try {
    pageLabels = await pdf.getPageLabels();
  } catch {
    // no label table — physical indices are the labels
  }

  const perPage = [];
  const pageMarkdown = [];
  // Column gutter carried page-to-page, so a page-break remainder (too short
  // for detection on its own) still reflows column-first.
  let gutter = null;
  try {
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const { lines, gutter: pageGutter } = reconstructPage(content.items, gutter);
      gutter = pageGutter;
      // Char count drives classification; count raw text so it's unaffected by
      // Markdown decoration (headings/tables) added for output.
      const images = shouldScanImages(n, pageCount) ? await countImages(page) : null;
      perPage.push({ chars: countChars(linesToText(lines)), images });
      // Scanned pages with images get a visible omission marker in the output
      // (null = unscanned on a sampled large doc — assert only what was seen).
      pageMarkdown.push(
        appendOmittedImagesNote(
          linesToMarkdown(lines, pageLabels?.[n - 1] ?? n),
          images ?? 0,
          pageLabels?.[n - 1] ?? n
        )
      );
    }
  } finally {
    // destroy() lives on the loading task in pdf.js v6; it tears down the
    // document and the worker connection.
    await loadingTask.destroy();
  }

  const { decision, reason, summary } = classifyDocument(
    extrapolateImages(perPage)
  );
  // Ride the label table on the summary so the figure paths (mini-PDF stamps,
  // association footer) can label pages the way the document itself does.
  if (pageLabels) summary.pageLabels = pageLabels;
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
