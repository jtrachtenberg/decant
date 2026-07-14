// Node figure assembly for the CLI's --mode figures (CLI.md §4). This is the
// headless equivalent of the browser's "Convert + attach figures" choice
// (content/intercept.js), reusing the same extraction functions — but only the
// render-free paths that run without a canvas:
//
//   - PPTX/DOCX: extractFigures() pulls the media zip entries (pure JSZip).
//     No contact sheet — that's a chat-surface workaround for per-message image
//     limits; the CLI writes to a directory, so every figure lands as its own
//     file.
//   - PDF: extractPdfFigureBoxes() (pdf.js geometry, no rasterization) feeds
//     buildChartPagesPdf() (pdf-lib) to emit a chart-pages-only mini-PDF cropped
//     to each figure's box — the same artifact Firefox produces in-browser.
//     Canvas-only tiers (page renders, raster XObject re-encode) are left for a
//     later pass; a document that would need them still gets its text + the
//     cropped mini-PDF.
//
// Returns { files, note, attachedFigurePages }: the figure Files to write
// alongside the Markdown, the association note to append to the Markdown (naming
// the figures so the model can cross-reference them), and the count of page
// image-layers reattached (PDF mini-PDF pages) so savings can net them out.

import { extractFigures, figuresSupported } from "../convert/figures.js";
import { extractPdfFigureBoxes } from "../convert/pdf-figures.js";
import { buildChartPagesPdf } from "../convert/pdf-subset.js";

const isPdf = (file) =>
  file.type === "application/pdf" || /\.pdf$/i.test(file.name);

export async function assembleFigures(file, meta) {
  if (figuresSupported(file)) return zipFigures(file);
  if (isPdf(file)) return pdfFigures(file, meta);
  return { files: [], note: null, attachedFigurePages: 0 };
}

async function zipFigures(file) {
  const figs = await extractFigures(file);
  if (!figs.length) return { files: [], note: null, attachedFigurePages: 0 };
  const note =
    `The document's images are attached as separate files, in document order: ` +
    `${figs.map((f) => `"${f.name}"`).join(", ")}.`;
  return { files: figs, note, attachedFigurePages: 0 };
}

async function pdfFigures(file, meta) {
  const boxes = await extractPdfFigureBoxes(file, meta);
  const subset = await buildChartPagesPdf(file, meta, null, boxes);
  if (!subset) return { files: [], note: null, attachedFigurePages: 0 };
  // Page references use the document's own printed labels when the PDF defines
  // them (matching the in-Markdown "[images omitted — page N]" markers).
  const labelOf = (n) => meta?.pageLabels?.[n - 1] ?? n;
  const note =
    `The figures from this document are attached as "${subset.file.name}" ` +
    `(${subset.pages
      .map((p, i) => `its page ${i + 1} = document page ${labelOf(p)}`)
      .join("; ")}).`;
  return {
    files: [subset.file],
    note,
    attachedFigurePages: subset.pages.length,
  };
}
