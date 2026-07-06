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
import { IMAGE_OP_NAMES } from "./classify.js";
import { MAX_SUBSET_PAGES } from "./pdf-subset.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.mjs");

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjsLib.OPS[name]));

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

// Render one page to an OffscreenCanvas at a capped scale.
async function renderPage(page) {
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
  return { canvas, viewport };
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
      const { canvas } = await renderPage(page);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      figures.push(new File([blob], `${base}-p${n}.png`, { type: "image/png" }));
    }
  } finally {
    await loadingTask.destroy();
  }
  return figures;
}

// --- Figure crops: tighten chart pages to the figures themselves ------------
//
// The operator list carries each raster image's transform, so its placement
// on the page is essentially free: replay save/restore/transform to know the
// CTM at each paint op, take the union of the image boxes (charts often paint
// as several tiles), pad it to catch the axis labels / captions / legends
// drawn as text around the raster, and crop the page render to that box. The
// crops become the pages of the chart-pages mini-PDF (pdf-subset.js), so the
// model pays for the figure region, not the whole page.

const CROP_PAD_PT = 36; // half an inch: axis labels, captions, legends
const MIN_IMAGE_EDGE_PT = 30; // icons / logos / bullets aren't figures
// When the padded union effectively IS the page, cropping buys nothing —
// keep the vector page (it renders sharper than a raster crop anyway).
const MAX_CROP_PAGE_FRACTION = 0.85;

// 2×3 matrices in PDF's row-vector convention. composed = apply m, then n.
const compose = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

// Union of the page's raster-image boxes in user space, or null when nothing
// figure-sized paints. An image op paints the unit square through the CTM.
async function figureBoxUserSpace(page) {
  const ops = await page.getOperatorList();
  const { OPS } = pdfjsLib;
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let box = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = compose(ops.argsArray[i], ctm);
    else if (IMAGE_OPS.has(fn)) {
      const corners = [
        apply(ctm, 0, 0),
        apply(ctm, 1, 0),
        apply(ctm, 0, 1),
        apply(ctm, 1, 1),
      ];
      const xs = corners.map((c) => c[0]);
      const ys = corners.map((c) => c[1]);
      const b = {
        x0: Math.min(...xs),
        y0: Math.min(...ys),
        x1: Math.max(...xs),
        y1: Math.max(...ys),
      };
      if (b.x1 - b.x0 < MIN_IMAGE_EDGE_PT || b.y1 - b.y0 < MIN_IMAGE_EDGE_PT) {
        continue;
      }
      box = box
        ? {
            x0: Math.min(box.x0, b.x0),
            y0: Math.min(box.y0, b.y0),
            x1: Math.max(box.x1, b.x1),
            y1: Math.max(box.y1, b.y1),
          }
        : b;
    }
  }
  return box;
}

// Crop each chart page's render to its padded figure box. Resolves to a Map
// of pageNumber → { png, widthPt, heightPt } holding only the pages where a
// crop is worthwhile — pages without one fall back to whole-page copies in
// the mini-PDF. Throws on pdf.js/canvas failure (caller degrades to whole
// pages).
export async function extractPdfFigureCrops(file, meta) {
  const pages = (meta?.chartPageNumbers ?? []).slice(0, MAX_SUBSET_PAGES);
  const crops = new Map();
  if (!pages.length) return crops;

  const data = new Uint8Array(await file.arrayBuffer());
  const loadingTask = pdfjsLib.getDocument({
    data,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  });
  const pdf = await loadingTask.promise;
  try {
    for (const n of pages) {
      if (n < 1 || n > pdf.numPages) continue;
      const page = await pdf.getPage(n);
      const box = await figureBoxUserSpace(page);
      if (!box) continue;

      // Pad for surrounding labels, clamp to the page box.
      const [vx0, vy0, vx1, vy1] = page.view;
      const padded = {
        x0: Math.max(vx0, box.x0 - CROP_PAD_PT),
        y0: Math.max(vy0, box.y0 - CROP_PAD_PT),
        x1: Math.min(vx1, box.x1 + CROP_PAD_PT),
        y1: Math.min(vy1, box.y1 + CROP_PAD_PT),
      };
      const cropArea = (padded.x1 - padded.x0) * (padded.y1 - padded.y0);
      const pageArea = (vx1 - vx0) * (vy1 - vy0);
      if (!(cropArea > 0) || cropArea / pageArea > MAX_CROP_PAGE_FRACTION) {
        continue; // whole-page copy is as good or better
      }

      const { canvas, viewport } = await renderPage(page);
      // User space → canvas pixels (convertToViewportPoint handles the PDF
      // y-flip and any page rotation).
      const [ax, ay] = viewport.convertToViewportPoint(padded.x0, padded.y0);
      const [bx, by] = viewport.convertToViewportPoint(padded.x1, padded.y1);
      const sx = Math.max(0, Math.floor(Math.min(ax, bx)));
      const sy = Math.max(0, Math.floor(Math.min(ay, by)));
      const sw = Math.min(canvas.width - sx, Math.ceil(Math.abs(bx - ax)));
      const sh = Math.min(canvas.height - sy, Math.ceil(Math.abs(by - ay)));
      if (sw < 8 || sh < 8) continue;

      const cropCanvas = new OffscreenCanvas(sw, sh);
      cropCanvas.getContext("2d").drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      const blob = await cropCanvas.convertToBlob({ type: "image/png" });
      crops.set(n, {
        png: new Uint8Array(await blob.arrayBuffer()),
        widthPt: padded.x1 - padded.x0,
        heightPt: padded.y1 - padded.y0,
      });
    }
  } finally {
    await loadingTask.destroy();
  }
  return crops;
}
