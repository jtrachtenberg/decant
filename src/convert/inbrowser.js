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
import { browser } from "../browser.js";
import { fileBytes } from "./read-file.js";
import {
  reconstructPage,
  linesToText,
  linesToMarkdown,
  countChars,
  classifyDocument,
  hasFlattenedFigure,
  flattenedWithEvidence,
  hasOmittedChartTable,
  shouldScanImages,
  extrapolateImages,
  appendOmittedImagesNote,
  appendVectorChartNote,
  createFurnitureDetector,
  stripFurniture,
  IMAGE_OP_NAMES,
  MAX_ANALYZE_PAGES,
} from "./classify.js";
import {
  scanPageOps,
  countSignificantImages,
  hasVectorChartFills,
  textPointsFromItems,
  imageDimsKey,
  REPEATED_DIMS_MIN_PAGES,
} from "./raster-gate.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("pdf.worker.mjs");

// pdf.js needs the metrics for the 14 standard PDF fonts when a document uses
// one without embedding it; without this it warns ("Ensure that the
// standardFontDataUrl API parameter is provided") on every such file. We ship
// pdf.js's own standard_fonts/ (see build.mjs) and point at it via the dynamic
// extension URL (trailing slash required — pdf.js appends the font filename).
// Exported for pdf-figures.js, which re-opens the document to render pages.
export const STANDARD_FONT_DATA_URL = browser.runtime.getURL("standard_fonts/");

// pdf.js decodes JPXDecode (JPEG2000) images with an OpenJPEG WASM module it
// fetches from wasmUrl at render time — without it every JPX image throws
// JpxError and is silently skipped, so photos come out black/blank in page
// renders (print-production PDFs are routinely all-JPX). The same directory
// serves jbig2.wasm (scanned docs) and qcms_bg.wasm (ICC color management);
// iccUrl adds the CMYK ICC profile. Shipped by build.mjs like standard_fonts/.
// Trailing slashes required — pdf.js appends the filename.
export const WASM_URL = browser.runtime.getURL("wasm/");
export const ICC_URL = browser.runtime.getURL("iccs/");

// The document-open options every getDocument() call here and in
// pdf-figures.js shares, so no path drifts to an asset-less pdf.js.
export const PDFJS_DOC_OPTIONS = {
  standardFontDataUrl: STANDARD_FONT_DATA_URL,
  wasmUrl: WASM_URL,
  iccUrl: ICC_URL,
  // The MV3 extension CSP already blocks eval, so pdf.js's runtime feature-probe
  // fails and it falls back — but state the intent explicitly rather than relying
  // on the CSP to catch it.
  isEvalSupported: false,
};

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjsLib.OPS[name]));

export async function analyzePdf(file) {
  const data = new Uint8Array(await fileBytes(file));
  const loadingTask = pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS });
  // getDocument eagerly spins up a worker; if the open itself rejects
  // (password-protected / corrupt PDF), the page-loop's finally below never
  // runs, so tear the task (and its worker) down here before rethrowing.
  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    await loadingTask.destroy();
    throw err;
  }
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
  // The repeated-image census (raster-gate.js isRepeatedImage): intrinsic-dims
  // fingerprints seen on REPEATED_DIMS_MIN_PAGES+ pages. Filled by the first
  // pass, consumed by every page's significance judgment, and carried on the
  // summary so the figure paths (pdf-figures.js) frame crops the same way.
  const repeatedDims = new Set();
  // Column gutter carried page-to-page, so a page-break remainder (too short
  // for detection on its own) still reflows column-first.
  let gutter = null;
  try {
    // Furniture pass: find the text repeated at the same position across many
    // pages (running headers, nav rails) so reconstruction below can drop it.
    // Item arrays are cached for the second pass on ordinarily-sized docs;
    // past the analysis ceiling only the counts are kept (memory stays flat)
    // and the text is re-extracted below. Operator lists are scanned in the
    // same pass (sampled like everything image-related) to build the
    // repeated-image census: intrinsic dims recurring across pages mark an
    // image as decoration (raster-gate.js isRepeatedImage), and the census
    // must be complete before any single page's figures are judged.
    const furniture = createFurnitureDetector();
    const cache = pageCount <= MAX_ANALYZE_PAGES ? [] : null;
    const scans = new Map(); // page number → { scan, images }, sampled pages
    const dimsPages = new Map(); // imageDimsKey → Set of page numbers
    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const { items } = await page.getTextContent();
      furniture.addPage(items);
      cache?.push(items);
      if (!shouldScanImages(n, pageCount)) continue;
      const scanned = await scanPage(page);
      if (!scanned) continue;
      scans.set(n, scanned);
      for (const x of scanned.scan.xobjects) {
        if (x.w == null || x.h == null) continue;
        const key = imageDimsKey(x.w, x.h);
        if (!dimsPages.has(key)) dimsPages.set(key, new Set());
        dimsPages.get(key).add(n);
      }
    }
    const furnitureKeys = furniture.keys();
    for (const [key, pages] of dimsPages) {
      if (pages.size >= REPEATED_DIMS_MIN_PAGES) repeatedDims.add(key);
    }

    for (let n = 1; n <= pageCount; n++) {
      const page = await pdf.getPage(n);
      const rawItems = cache
        ? cache[n - 1]
        : (await page.getTextContent()).items;
      const items = stripFurniture(rawItems, furnitureKeys);
      const { lines, gutter: pageGutter } = reconstructPage(items, gutter);
      gutter = pageGutter;
      // Char count drives classification; count raw text so it's unaffected by
      // Markdown decoration (headings/tables) added for output.
      const scan = shouldScanImages(n, pageCount)
        ? judgePageImages(page, scans.get(n), items, repeatedDims)
        : null;
      const images = scan ? scan.images : null;
      const label = pageLabels?.[n - 1] ?? n;
      let pageMd = linesToMarkdown(lines, label);
      // A vector symbol chart (colored fills, no raster, no text values) gets
      // a visible note: the emitted rows are missing their data, the attached
      // figure is the faithful copy. Scan-gated like the image markers —
      // assert only what was seen.
      if (scan?.vectorChart) pageMd = appendVectorChartNote(pageMd, label);
      perPage.push({
        chars: countChars(linesToText(lines)),
        images,
        figureImages: scan ? scan.figureImages : null,
        // The page's text misrepresents a figure — Tier 2 convergence flagged
        // it as a flattened chart (only honored with visual evidence: raster
        // paint or the vector-chart fills — flattenedWithEvidence), a corrupt
        // chart table was omitted with a "see attached figure" note, or the
        // operator scan found a vector symbol chart whose values never reach
        // the text layer. Classification routes such pages into the figures
        // flow even when they paint no raster (a pure vector chart).
        flattened:
          hasOmittedChartTable(pageMd) ||
          flattenedWithEvidence(
            hasFlattenedFigure(lines),
            scan ? scan.images : null,
            scan?.vectorChart
          ),
      });
      // Scanned pages with images get a visible omission marker in the output
      // (null = unscanned on a sampled large doc — assert only what was seen).
      pageMarkdown.push(appendOmittedImagesNote(pageMd, images ?? 0, label));
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
  // Ride the repeated-image census too: the figure paths re-derive each page's
  // significant components for crop framing / decode gating, and must demote
  // the same decoration classification did or the crop frames the wrong thing.
  if (repeatedDims.size) summary.repeatedImageDims = [...repeatedDims];
  const markdown =
    decision === "convert" || decision === "ambiguous"
      ? pageMarkdown.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
      : null;

  return { decision, reason, summary, markdown };
}

// Walk a page's operator list without rasterizing: the raw raster-paint-op
// count plus the raster-gate scan (figure boxes, colored fills). Runs in the
// census pass so every page's xobject dims are known before any page is
// judged. Null when the operator list is unavailable.
async function scanPage(page) {
  try {
    const ops = await page.getOperatorList();
    let images = 0;
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
    return {
      images,
      scan: scanPageOps(ops.fnArray, ops.argsArray, pdfjsLib.OPS),
    };
  } catch {
    return null;
  }
}

// The judgment half of what used to be one countImages call: how many of the
// scanned page's raster components read as SIGNIFICANT figures (figure-sized,
// really pixel-bearing, not decoration — raster-gate.js). The significance
// count is what lets classification prompt on a single real chart while
// staying quiet for a lone logo.
//
// `textItems` (furniture-stripped getTextContent().items) feeds the
// background/text-density demotions: an image the page's text is printed OVER
// is a backdrop, not a figure. `repeatedDims` (the document census) demotes
// cross-page decoration. Also reports vectorChart — the colored-fill
// symbol-chart signal (raster-gate.js hasVectorChartFills).
function judgePageImages(page, scanned, textItems, repeatedDims) {
  if (!scanned) return { images: 0, figureImages: 0, vectorChart: false };
  const [vx0, vy0, vx1, vy1] = page.view;
  const figureImages = countSignificantImages(
    scanned.scan,
    (vx1 - vx0) * (vy1 - vy0),
    {
      view: page.view,
      textPoints: textPointsFromItems(textItems),
      repeatedDims,
    }
  );
  return {
    images: scanned.images,
    figureImages,
    vectorChart: hasVectorChartFills(scanned.scan),
  };
}
