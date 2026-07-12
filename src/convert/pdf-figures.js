// PDF figure extraction — the first slice of extract-and-reference's "hard
// case" (SPEC M3). A born-digital PDF's charts are usually vector drawings:
// there is no embedded image to pull out — the chart IS the page's drawing
// operators. So instead of decoding XObjects, this renders the classifier's
// detected chart pages (summary.chartPageNumbers — text pages that also paint
// raster images) to PNG Files, named "<doc>-p7.png" so the model and the user
// can reference them by page. The model sees exactly what the full page-image
// layer would have shown it, but only for the pages that carry charts.
//
// Photo-bearing pages get a further upgrade: when a page's figure content IS
// a single embedded raster (raster-gate.js decides, conservatively), the
// XObject's own pixels are decoded and re-encoded (extractPdfRasterFigures)
// instead of re-rasterizing a 2× page render — native resolution, render-free.
//
// Browser-only: pdf.js's module import touches chrome.runtime (like
// inbrowser.js) and rendering needs OffscreenCanvas, so there are no Node
// tests — the smoke checklist covers it. Callers catch and degrade to the
// text-only conversion.

import * as pdfjsLib from "pdfjs-dist/build/pdf.mjs";
import { browser } from "../browser.js";
import { PDFJS_DOC_OPTIONS } from "./inbrowser.js";
import { fileBytes } from "./read-file.js";
import { selectChartPages } from "./classify.js";
import { MAX_SUBSET_PAGES } from "./pdf-subset.js";
import {
  MIN_INTRINSIC_PX,
  MAX_INTRINSIC_ASPECT,
  scanPageOps,
  significantFigureComponents,
  decodeCandidate,
  vectorChartBox,
  textPointsFromItems,
} from "./raster-gate.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("pdf.worker.mjs");

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

// The repeated-image census analyzePdf rode on the summary, as the Set the
// raster-gate opts take — so crop framing and decode gating demote the same
// cross-page decoration classification did. Null when the summary carries
// none (old metas, image-free docs).
const repeatedDimsFromMeta = (meta) =>
  meta?.repeatedImageDims?.length ? new Set(meta.repeatedImageDims) : null;

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
  const pages = selectChartPages(meta, MAX_PDF_FIGURE_PAGES);
  if (!pages.length) return [];

  const data = new Uint8Array(await fileBytes(file));
  const loadingTask = pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS });
  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  const figures = [];
  try {
    // Open inside the try so a failed open (corrupt/locked PDF) still tears
    // the worker down via the finally below.
    const pdf = await loadingTask.promise;
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
// The operator list carries each raster image's placement, so the figure
// region is essentially free: take the union of the page's SIGNIFICANT figure
// components (significantFigureComponents — the same clamp/merge/demotion
// call that made the page attach, so the crop frames what qualified it, never
// the background art or nav furniture around it), pad it to catch the axis
// labels / captions / legends drawn as text around the raster, and crop the
// page render to that box. The crops become the pages of the chart-pages
// mini-PDF (pdf-subset.js), so the model pays for the figure region, not the
// whole page.

const CROP_PAD_PT = 36; // half an inch: axis labels, captions, legends
// When the padded union effectively IS the page, cropping buys nothing —
// keep the vector page (it renders sharper than a raster crop anyway).
const MAX_CROP_PAGE_FRACTION = 0.85;
// Vertical padding for a vector-symbol-chart band (vectorChartBox): the box
// bounds only the colored fills, so the column-header rows above the top
// symbol row and any caption under the legend need headroom. Wider than
// CROP_PAD_PT because two stacked header lines (group + column names) are
// the norm for matrix charts.
const VECTOR_CHART_PAD_PT = 48;

// Union of the page's significant figure components in user space, or null
// when none qualify. The components are already view-clamped; the union is
// what the page attached FOR, so it's what the crop should frame.
async function figureBoxUserSpace(page, scan, repeatedDims = null) {
  const [vx0, vy0, vx1, vy1] = page.view;
  const content = await page.getTextContent();
  const comps = significantFigureComponents(scan, (vx1 - vx0) * (vy1 - vy0), {
    view: page.view,
    textPoints: textPointsFromItems(content.items),
    repeatedDims,
  });
  if (!comps.length) return null;
  return {
    x0: Math.min(...comps.map((c) => c.x0)),
    y0: Math.min(...comps.map((c) => c.y0)),
    x1: Math.max(...comps.map((c) => c.x1)),
    y1: Math.max(...comps.map((c) => c.y1)),
  };
}

// The worthwhile, padded figure box for a page in user space, or null when
// nothing boxable paints or the crop would barely beat a whole-page copy.
// Two sources, raster first: the union of significant figure components, else
// the vector-symbol-chart band (vectorChartBox — the flattened chart pages
// that paint no raster at all, previously always whole-page copies). Shared by
// the raster crop (Chrome) and the vector box crop (Firefox) so both agree on
// what and when to crop. Render-free — getOperatorList geometry only.
async function paddedFigureBox(page, repeatedDims = null) {
  const [vx0, vy0, vx1, vy1] = page.view;
  const ops = await page.getOperatorList();
  const scan = scanPageOps(ops.fnArray, ops.argsArray, pdfjsLib.OPS);
  const box = await figureBoxUserSpace(page, scan, repeatedDims);
  let padded = null;
  if (box) {
    // Pad for surrounding labels, clamp to the page box.
    padded = {
      x0: Math.max(vx0, box.x0 - CROP_PAD_PT),
      y0: Math.max(vy0, box.y0 - CROP_PAD_PT),
      x1: Math.min(vx1, box.x1 + CROP_PAD_PT),
      y1: Math.min(vy1, box.y1 + CROP_PAD_PT),
    };
  } else {
    // No raster figure — a symbol chart's colored fills, when the scan can
    // point at exactly one confident cluster. The x-range depends on page
    // orientation: a PORTRAIT page is document flow, where the chart owns the
    // text width and its row/end labels sit well outside the fills' bounds
    // (the MSIM matrices' row labels start 118 pt left of the first symbol;
    // the CERN donut has value labels flanking both sides) — full page width
    // is the only safe crop. A LANDSCAPE page is a slide-style layout whose
    // chart lives in its own panel with parallel side streams (a prose
    // column, a nav rail) that duplicate nothing of the chart — there the
    // band's own x-range plus the same pad frames it (the Discovery phase
    // chart and emissions tables; each keeps its adjacent legend inside the
    // pad). Generous vertical pad for the header rows either way. Any doubt
    // → null → whole-page copy, the pre-crop baseline.
    const band = vectorChartBox(scan);
    if (band) {
      const landscape = vx1 - vx0 > vy1 - vy0;
      padded = {
        x0: landscape ? Math.max(vx0, band.x0 - VECTOR_CHART_PAD_PT) : vx0,
        x1: landscape ? Math.min(vx1, band.x1 + VECTOR_CHART_PAD_PT) : vx1,
        y0: Math.max(vy0, band.y0 - VECTOR_CHART_PAD_PT),
        y1: Math.min(vy1, band.y1 + VECTOR_CHART_PAD_PT),
      };
    }
  }
  if (!padded) return null;
  const cropArea = (padded.x1 - padded.x0) * (padded.y1 - padded.y0);
  const pageArea = (vx1 - vx0) * (vy1 - vy0);
  if (!(cropArea > 0) || cropArea / pageArea > MAX_CROP_PAGE_FRACTION) {
    return null; // whole-page copy is as good or better
  }
  return padded;
}

// Crop each chart page's render to its padded figure box. Resolves to a Map
// of pageNumber → { png, widthPt, heightPt } holding only the pages where a
// crop is worthwhile — pages without one fall back to whole-page copies in
// the mini-PDF. `skipPages` (optional Set) excludes pages another path
// already handled (decoded raster figures). Throws on pdf.js/canvas failure
// (caller degrades to whole pages).
export async function extractPdfFigureCrops(file, meta, skipPages = null) {
  const pages = selectChartPages(meta, MAX_SUBSET_PAGES).filter(
    (n) => !skipPages?.has(n)
  );
  const crops = new Map();
  if (!pages.length) return crops;

  const data = new Uint8Array(await fileBytes(file));
  const loadingTask = pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS });
  try {
    // Open inside the try so a failed open (corrupt/locked PDF) still tears
    // the worker down via the finally below.
    const pdf = await loadingTask.promise;
    const repeatedDims = repeatedDimsFromMeta(meta);
    for (const n of pages) {
      if (n < 1 || n > pdf.numPages) continue;
      const page = await pdf.getPage(n);
      const padded = await paddedFigureBox(page, repeatedDims);
      if (!padded) continue;

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

// Render-free figure boxes for Firefox, where pdf.js canvas rendering hangs in
// the content-script sandbox (see rs-shim.js / intercept.js). Resolves to a Map
// of pageNumber → { x0, y0, x1, y1 } padded figure box in PDF user space, for
// the pages worth cropping. buildChartPagesPdf crops the vector page to the box
// via setCropBox — no rasterization — so it runs where extractPdfFigureCrops
// can't. Same figure-box geometry as the crop path, so the two agree on framing.
export async function extractPdfFigureBoxes(file, meta, skipPages = null) {
  const pages = selectChartPages(meta, MAX_SUBSET_PAGES).filter(
    (n) => !skipPages?.has(n)
  );
  const boxes = new Map();
  if (!pages.length) return boxes;

  const data = new Uint8Array(await fileBytes(file));
  const loadingTask = pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS });
  try {
    // Open inside the try so a failed open (corrupt/locked PDF) still tears
    // the worker down via the finally below.
    const pdf = await loadingTask.promise;
    const repeatedDims = repeatedDimsFromMeta(meta);
    for (const n of pages) {
      if (n < 1 || n > pdf.numPages) continue;
      const padded = await paddedFigureBox(await pdf.getPage(n), repeatedDims);
      if (padded) boxes.set(n, padded);
    }
  } finally {
    await loadingTask.destroy();
  }
  return boxes;
}

// --- Standalone raster XObjects: decode the figure's own pixels -------------
//
// For a page whose figure IS a single embedded raster (a photo, a scanned
// diagram — raster-gate.js's conservative call), the render-crop path
// re-rasterizes an already-raster image at page scale. Better: pull the
// decoded bitmap out of pdf.js's object registry and re-encode it directly —
// native resolution, no page render at all (getOperatorList only, so it can
// run even where canvas rendering can't; the JPEG re-encode still needs plain
// OffscreenCanvas, which is far less than the pdf.js render pipeline).
//
// Any caption/axis text drawn AROUND the raster is page text — it's already
// in the converted Markdown, so decoding only the pixels loses nothing the
// crop would have kept. (For vector charts the labels are NOT in the raster,
// which is exactly what the gate's raster-dominance check screens out.)

// Long-edge cap for the re-encode, matching the render path's reasoning: the
// destination model downscales past ~2048 anyway, and photos re-encoded as
// JPEG at this size stay small; beyond it they just bloat the mini-PDF.
const MAX_DECODE_EDGE = MAX_RENDER_EDGE;
const DECODE_JPEG_QUALITY = 0.9;

// pdf.js ImageKind values (raw-data form of a decoded image).
const KIND_RGB_24BPP = 2;
const KIND_RGBA_32BPP = 3;

// Resolve a page-level image object. The callback form never throws on a
// not-yet-resolved id — it fires when the worker delivers it. A dependency
// the worker never resolves would hang; the caller's timeout guard covers it.
const resolveObj = (page, objId) =>
  new Promise((res) => page.objs.get(objId, res));

// Decoded imgData → white-backed JPEG bytes at capped scale, or null when the
// shape isn't one we recognize (exotic kind, missing bitmap/data) — the page
// then falls back to the crop path.
async function encodeJpegFigure(imgData) {
  const { width, height } = imgData ?? {};
  if (!width || !height) return null;

  // Source drawable: modern pdf.js transfers an ImageBitmap; the raw-data
  // form carries typed-array pixels plus a kind tag.
  let source = imgData.bitmap instanceof ImageBitmap ? imgData.bitmap : null;
  let raw = null;
  if (!source && imgData.data) {
    if (imgData.kind === KIND_RGBA_32BPP) {
      // Copy element-wise: the typed array may be a byteOffset view into a
      // larger transfer buffer, so .buffer alone is not the pixels.
      raw = new Uint8ClampedArray(imgData.data.length);
      raw.set(imgData.data);
    } else if (imgData.kind === KIND_RGB_24BPP) {
      raw = new Uint8ClampedArray(width * height * 4);
      const d = imgData.data;
      for (let i = 0, j = 0; j < raw.length; i += 3, j += 4) {
        raw[j] = d[i];
        raw[j + 1] = d[i + 1];
        raw[j + 2] = d[i + 2];
        raw[j + 3] = 255;
      }
    } else {
      return null; // 1bpp grayscale etc. — not photo material
    }
  }
  if (!source && !raw) return null;

  if (raw) {
    const full = new OffscreenCanvas(width, height);
    full.getContext("2d").putImageData(new ImageData(raw, width, height), 0, 0);
    source = full;
  }

  const s = Math.min(1, MAX_DECODE_EDGE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s));
  const h = Math.max(1, Math.round(height * s));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d");
  // JPEG has no alpha: composite any transparency onto white, matching the
  // page renders.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  // NOTE: never .close() imgData.bitmap — it belongs to pdf.js's cache.

  const blob = await canvas.convertToBlob({
    type: "image/jpeg",
    quality: DECODE_JPEG_QUALITY,
  });
  return new Uint8Array(await blob.arrayBuffer());
}

// Decode each chart page's standalone raster figure, when it has exactly one
// (raster-gate.js). Resolves to a Map of pageNumber → { jpg, widthPt,
// heightPt } — the same shape buildChartPagesPdf takes for crops, so decoded
// pages slot straight into the mini-PDF (jpg instead of png). Pages the gate
// declines are simply absent; the caller runs the crop/box path for those.
// Throws on pdf.js failure (caller degrades to crops).
export async function extractPdfRasterFigures(file, meta) {
  const pages = selectChartPages(meta, MAX_SUBSET_PAGES);
  const out = new Map();
  if (!pages.length) return out;

  const data = new Uint8Array(await fileBytes(file));
  const loadingTask = pdfjsLib.getDocument({ data, ...PDFJS_DOC_OPTIONS });
  try {
    // Open inside the try so a failed open (corrupt/locked PDF) still tears
    // the worker down via the finally below.
    const pdf = await loadingTask.promise;
    const repeatedDims = repeatedDimsFromMeta(meta);
    // First pass: gate each page, resolve + intrinsic-check its candidate.
    const found = [];
    const dimsPages = new Map(); // "WxH" → Set of page numbers (fingerprint)
    for (const n of pages) {
      if (n < 1 || n > pdf.numPages) continue;
      const page = await pdf.getPage(n);
      const ops = await page.getOperatorList();
      const [vx0, vy0, vx1, vy1] = page.view;
      // Same geometry the significance call sees (view clamp + background
      // demotion), so decode never upgrades a page classification demoted.
      const content = await page.getTextContent();
      const cand = decodeCandidate(
        scanPageOps(ops.fnArray, ops.argsArray, pdfjsLib.OPS),
        (vx1 - vx0) * (vy1 - vy0),
        {
          view: page.view,
          textPoints: textPointsFromItems(content.items),
          repeatedDims,
        }
      );
      if (!cand) continue;
      // G3a: a globally-cached id means pdf.js saw this image on ≥2 pages —
      // letterhead/logo territory, never a figure.
      if (cand.objId.startsWith("g_")) continue;

      const imgData = await resolveObj(page, cand.objId);
      const w = imgData?.width;
      const h = imgData?.height;
      // Authoritative intrinsic check (op args carry dims in v6 but the
      // resolved object is the source of truth across builds).
      if (!w || !h) continue;
      if (Math.min(w, h) < MIN_INTRINSIC_PX) continue;
      if (Math.max(w, h) / Math.min(w, h) > MAX_INTRINSIC_ASPECT) continue;

      const fp = `${w}x${h}`;
      if (!dimsPages.has(fp)) dimsPages.set(fp, new Set());
      dimsPages.get(fp).add(n);
      found.push({ n, fp, box: cand.box, imgData });
    }

    // Second pass: G3b — identical dimensions recurring across pages is
    // furniture (or two coincidentally same-sized photos; dropping those to
    // the crop path costs only sharpness — the safe direction).
    for (const f of found) {
      if (dimsPages.get(f.fp).size !== 1) continue;
      // Per-figure guard: one malformed image drops only its own page to the
      // crop path, not every decode in the document.
      let jpg = null;
      try {
        jpg = await encodeJpegFigure(f.imgData);
      } catch {
        continue;
      }
      if (!jpg) continue;
      out.set(f.n, {
        jpg,
        widthPt: f.box.x1 - f.box.x0,
        heightPt: f.box.y1 - f.box.y0,
      });
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}
