// Chart-pages-only mini-PDF (extract-and-reference, SPEC M3): rebuild the
// upload as a PDF containing just the classifier's detected chart pages
// (summary.chartPageNumbers), attached next to the converted Markdown.
//
// Why a PDF and not images: chat surfaces count image attachments against a
// low per-message limit (claude.ai ~5), but a PDF is ONE document attachment
// regardless of page count — and the platform renders its pages natively, so
// there's no tile/resolution compromise at all. The model pays the page-image
// cost only for the chart pages, which is the extract-and-reference thesis in
// its purest form: an 88-page report with 11 chart pages becomes cheap
// Markdown text plus an 11-page visual appendix.
//
// Built with pdf-lib (pure JS, no chrome.*), so unlike the pdf.js modules
// this unit-tests in Node.

import {
  PDFDocument,
  PDFDict,
  PDFName,
  PDFRef,
  PDFStream,
  StandardFonts,
  rgb,
} from "pdf-lib";
import { fileBytes } from "./read-file.js";
import { selectChartPages } from "./classify.js";

// Page cap: each subset page still costs the platform's per-page image render
// (~hundreds of tokens), so a pathological chart-every-page document
// shouldn't smuggle the whole report back in. Generous for real reports —
// the WHO-scale case is ~11.
export const MAX_SUBSET_PAGES = 20;

// Every mini-PDF page is stamped "document page N" so the label rides in the
// page content itself — the model can associate a figure with the text's
// "[images omitted — page N]" markers no matter how the platform numbers or
// reorders attachment pages. Crop pages get a strip added above the figure;
// whole-page copies get the label overlaid in the top margin.
export const STAMP_STRIP_PT = 16;
const STAMP_FONT_PT = 10;

// Page references speak the document's printed numbering when the PDF defines
// page labels (physical page 17 of the WHO doc is printed "7" — its TOC and
// cross-references say "page 7", so the model must too). Shared by the in-page
// stamps and the Markdown association note so the two can't disagree.
const pageLabel = (meta, n) => meta?.pageLabels?.[n - 1] ?? n;

async function stamper(out) {
  const font = await out.embedFont(StandardFonts.Helvetica);
  // `box` (optional) frames a vector crop: positions the label at the top-left
  // of the visible cropBox instead of the whole page, so it rides inside the
  // cropped view. Without it, coordinates fall back to the full page.
  return (page, label, { strip, box = null }) => {
    const text = `document page ${label}`;
    const w = font.widthOfTextAtSize(text, STAMP_FONT_PT);
    const left = box ? box.x0 : 0;
    const right = box ? box.x1 : page.getWidth();
    const top = box ? box.y1 : page.getHeight();
    const y = top - (strip ? STAMP_STRIP_PT : 18);
    page.drawRectangle({
      x: strip ? left : left + 4,
      y,
      width: strip ? right - left : w + 10,
      height: strip ? STAMP_STRIP_PT : STAMP_FONT_PT + 4,
      color: rgb(0.93, 0.93, 0.95),
      opacity: strip ? 1 : 0.85,
    });
    page.drawText(text, {
      x: strip ? left + 6 : left + 9,
      y: y + 3.5,
      size: STAMP_FONT_PT,
      font,
      color: rgb(0.15, 0.15, 0.2),
    });
  };
}

// Build "<doc>-charts.pdf" from the chart pages, or null when there's nothing
// to subset. Throws on documents pdf-lib can't load (e.g. encrypted) — the
// caller falls back to rendered page images.
//
// `crops` (optional, from pdf-figures.js extractPdfFigureCrops or
// extractPdfRasterFigures) maps a page number to { png | jpg, widthPt,
// heightPt }: that page is embedded as a tight raster figure instead of a
// whole-page copy — `png` for rendered crops, `jpg` for decoded photo
// XObjects (photos as PNG would bloat the mini-PDF for nothing). `boxes` (optional, from
// extractPdfFigureBoxes) maps a page number to a { x0, y0, x1, y1 } user-space
// figure box: the whole vector page is copied but its CropBox is set to the box,
// so the platform shows only the figure — the render-free crop used on Firefox,
// where rasterization can't run. Either way the model sees the figure region,
// not the whole page. Pages with neither copy whole (vector, full fidelity).
//
// Returns { file, pages } — `pages` is the document page number behind each
// mini-PDF page, in order, so the caller can write the association footer
// into the Markdown ("charts.pdf page 1 = document page 17").
export async function buildChartPagesPdf(file, meta, crops = null, boxes = null) {
  const wanted = selectChartPages(meta, MAX_SUBSET_PAGES);
  if (!wanted.length) return null;

  const src = await PDFDocument.load(await fileBytes(file));
  // Extrapolated chart pages on a sampled large doc are estimates; numbers
  // past the real page count just drop out.
  const pages = wanted.filter((n) => n >= 1 && n <= src.getPageCount());
  if (!pages.length) return null;

  const out = await PDFDocument.create();
  const stamp = await stamper(out);
  const labelOf = (n) => pageLabel(meta, n);
  // Copy every vector page in ONE copyPages call: pdf-lib's object copier
  // dedupes shared refs only within a call, so per-page calls re-copy every
  // resource the chart pages share (fonts, form XObjects, ICC profiles) once
  // PER PAGE — a document with a heavily shared resource tree ballooned 4×
  // past its own source size that way, over the API's request ceiling.
  const vectorPages = pages.filter((n) => !crops?.get?.(n));
  const copiedPages = await out.copyPages(src, vectorPages.map((n) => n - 1));
  const copiedByPage = new Map(vectorPages.map((n, i) => [n, copiedPages[i]]));
  for (const n of pages) {
    const crop = crops?.get?.(n);
    const box = boxes?.get?.(n);
    if (crop) {
      // Raster crop: grow a strip above the figure for the stamp, so the label
      // never covers chart content.
      const img = crop.jpg
        ? await out.embedJpg(crop.jpg)
        : await out.embedPng(crop.png);
      const page = out.addPage([crop.widthPt, crop.heightPt + STAMP_STRIP_PT]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: crop.widthPt,
        height: crop.heightPt,
      });
      stamp(page, labelOf(n), { strip: true });
    } else if (box) {
      // Vector crop: copy the whole page, then clamp its CropBox to the figure
      // box so only the figure shows. The label overlays the top of that box
      // (no room to grow a strip within a fixed page).
      const page = out.addPage(copiedByPage.get(n));
      page.setCropBox(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
      stamp(page, labelOf(n), { strip: false, box });
    } else {
      // Whole-page copies can't grow, so the label overlays the top margin.
      const page = out.addPage(copiedByPage.get(n));
      stamp(page, labelOf(n), { strip: false });
    }
  }
  stripXmpMetadata(out);
  const bytes = await out.save();

  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  return {
    file: new File([bytes], `${base}-charts.pdf`, { type: "application/pdf" }),
    pages,
  };
}

// Copied resources drag their XMP packets along: every /Metadata key on a
// page, image, or form XObject points at an /XML stream (tens of KB each —
// 1.3 MB across one 10-page subset) that no viewer needs to render the
// figure. Delete the keys AND their target streams: pdf-lib serializes every
// indirect object it holds, reachable or not, so orphaning the stream alone
// wouldn't shrink the file.
function stripXmpMetadata(doc) {
  const metadataKey = PDFName.of("Metadata");
  const doomed = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    const dict =
      obj instanceof PDFDict ? obj : obj instanceof PDFStream ? obj.dict : null;
    const target = dict?.get(metadataKey);
    if (!target) continue;
    dict.delete(metadataKey);
    if (target instanceof PDFRef) doomed.push(target);
  }
  for (const ref of doomed) doc.context.delete(ref);
}

// One canonical wording for the chart-pages association note, shared by the
// extension (content/intercept.js) and the CLI (cli/figures.js) so the
// model-facing text can't drift between surfaces. Page references use the
// document's printed labels when the PDF defines them (pageLabel) — matching
// the in-page stamps above and the "[images omitted — page N]" markers in the
// Markdown.
export function chartPagesNote(subset, meta) {
  return (
    `The figures from this document are attached as "${subset.file.name}" ` +
    `(${subset.pages
      .map((p, i) => `its page ${i + 1} = document page ${pageLabel(meta, p)}`)
      .join("; ")}).`
  );
}
