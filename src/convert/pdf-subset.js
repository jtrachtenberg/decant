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

import { PDFDocument } from "pdf-lib";

// Page cap: each subset page still costs the platform's per-page image render
// (~hundreds of tokens), so a pathological chart-every-page document
// shouldn't smuggle the whole report back in. Generous for real reports —
// the WHO-scale case is ~11.
export const MAX_SUBSET_PAGES = 20;

// Build "<doc>-charts.pdf" from the chart pages, or null when there's nothing
// to subset. Throws on documents pdf-lib can't load (e.g. encrypted) — the
// caller falls back to rendered page images.
//
// `crops` (optional, from pdf-figures.js extractPdfFigureCrops) maps a page
// number to { png, widthPt, heightPt }: that page is embedded as a tight
// figure crop instead of a whole-page copy, so the model pays for the figure
// region only. Pages without a crop copy whole (vector, full fidelity).
//
// Returns { file, pages } — `pages` is the document page number behind each
// mini-PDF page, in order, so the caller can write the association footer
// into the Markdown ("charts.pdf page 1 = document page 17").
export async function buildChartPagesPdf(file, meta, crops = null) {
  const wanted = (meta?.chartPageNumbers ?? []).slice(0, MAX_SUBSET_PAGES);
  if (!wanted.length) return null;

  const src = await PDFDocument.load(await file.arrayBuffer());
  // Extrapolated chart pages on a sampled large doc are estimates; numbers
  // past the real page count just drop out.
  const pages = wanted.filter((n) => n >= 1 && n <= src.getPageCount());
  if (!pages.length) return null;

  const out = await PDFDocument.create();
  for (const n of pages) {
    const crop = crops?.get?.(n);
    if (crop) {
      const img = await out.embedPng(crop.png);
      const page = out.addPage([crop.widthPt, crop.heightPt]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: crop.widthPt,
        height: crop.heightPt,
      });
    } else {
      const [copied] = await out.copyPages(src, [n - 1]);
      out.addPage(copied);
    }
  }
  const bytes = await out.save();

  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  return {
    file: new File([bytes], `${base}-charts.pdf`, { type: "application/pdf" }),
    pages,
  };
}
