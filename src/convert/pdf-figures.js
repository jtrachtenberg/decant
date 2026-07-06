// PDF figure extraction — the first slice of extract-and-reference's "hard
// case" (SPEC M3). A born-digital PDF's charts are usually vector drawings:
// there is no embedded image to pull out — the chart IS the page's drawing
// operators. So instead of decoding XObjects, this renders the classifier's
// detected chart pages (summary.chartPageNumbers — text pages that also paint
// raster images) to PNG Files, named "<doc>-p7.png" so the model and the user
// can reference them by page. The model sees exactly what the full page-image
// layer would have shown it, but only for the pages that carry charts.
//
// Follow-ups (see extract-and-reference memory/SPEC): crop to the chart's
// region instead of the whole page, and decode standalone raster XObjects for
// photo-bearing PDFs.
//
// Browser-only: pdf.js's module import touches chrome.runtime (like
// inbrowser.js) and rendering needs OffscreenCanvas, so there are no Node
// tests — the smoke checklist covers it. Callers catch and degrade to the
// text-only conversion.

import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import { STANDARD_FONT_DATA_URL } from "./inbrowser.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

// Same page cap as the zip extractor's MAX_FIGURES: past the site's own
// attachment limit the caller slices — page renders don't contact-sheet well
// (a whole page in a 512px tile is unreadable), so unlike zip figures they
// are never sheeted.
export const MAX_PDF_FIGURE_PAGES = 8;

// 2× is crisp enough for chart text; past ~2048px on the long edge the
// destination model downscales anyway, so bigger renders just waste memory.
const RENDER_SCALE = 2;
const MAX_RENDER_EDGE = 2048;

// True when the analysis found chart pages to render — drives the ambiguous
// prompt's figures choice for PDFs the way figuresSupported does for zips.
export function pdfFiguresAvailable(meta) {
  return (meta?.chartPageNumbers?.length ?? 0) > 0;
}

// Render the chart pages to PNG Files. Resolves to [] when there's nothing
// to render; throws on pdf.js/canvas failure (caller falls back).
export async function extractPdfFigures(file, meta) {
  const pages = (meta?.chartPageNumbers ?? []).slice(0, MAX_PDF_FIGURE_PAGES);
  if (!pages.length) return [];

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  const pdf = await loadingTask.promise;
  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  const figures = [];
  try {
    for (const n of pages) {
      // Extrapolated chart pages on a sampled large doc are estimates; a
      // number past the real page count just doesn't render.
      if (n < 1 || n > pdf.numPages) continue;
      const page = await pdf.getPage(n);
      const base1 = page.getViewport({ scale: 1 });
      const scale = Math.min(
        RENDER_SCALE,
        MAX_RENDER_EDGE / Math.max(base1.width, base1.height)
      );
      const viewport = page.getViewport({ scale });
      const canvas = new OffscreenCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height)
      );
      const ctx = canvas.getContext("2d");
      // PDF pages assume a white ground; without it transparent regions come
      // out black in some viewers.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      const blob = await canvas.convertToBlob({ type: "image/png" });
      figures.push(new File([blob], `${base}-p${n}.png`, { type: "image/png" }));
    }
  } finally {
    await loadingTask.destroy();
  }
  return figures;
}
