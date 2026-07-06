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

import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

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

async function stamper(out) {
  const font = await out.embedFont(StandardFonts.Helvetica);
  return (page, n, { strip }) => {
    const text = `document page ${n}`;
    const w = font.widthOfTextAtSize(text, STAMP_FONT_PT);
    const y = page.getHeight() - (strip ? STAMP_STRIP_PT : 18);
    page.drawRectangle({
      x: strip ? 0 : 4,
      y,
      width: strip ? page.getWidth() : w + 10,
      height: strip ? STAMP_STRIP_PT : STAMP_FONT_PT + 4,
      color: rgb(0.93, 0.93, 0.95),
      opacity: strip ? 1 : 0.85,
    });
    page.drawText(text, {
      x: strip ? 6 : 9,
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
  const stamp = await stamper(out);
  for (const n of pages) {
    const crop = crops?.get?.(n);
    if (crop) {
      // Crop pages grow a strip above the figure for the stamp, so the label
      // never covers chart content.
      const img = await out.embedPng(crop.png);
      const page = out.addPage([crop.widthPt, crop.heightPt + STAMP_STRIP_PT]);
      page.drawImage(img, {
        x: 0,
        y: 0,
        width: crop.widthPt,
        height: crop.heightPt,
      });
      stamp(page, n, { strip: true });
    } else {
      // Whole-page copies can't grow, so the label overlays the top margin.
      const [copied] = await out.copyPages(src, [n - 1]);
      const page = out.addPage(copied);
      stamp(page, n, { strip: false });
    }
  }
  const bytes = await out.save();

  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  return {
    file: new File([bytes], `${base}-charts.pdf`, { type: "application/pdf" }),
    pages,
  };
}
