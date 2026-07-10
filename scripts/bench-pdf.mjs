// Dev tool: benchmark Decant's PDF conversion on real documents — the numbers
// behind the README's Benchmarks table. Runs the same extraction pipeline the
// extension does (reconstructPage → linesToMarkdown, classify.js verdict) and
// reports measured sizes plus the savings badge's own token estimate
// (savings.js: ~4 chars/token for text, IMAGE_TOKENS_PER_PAGE per page for the
// image layer). Never rasterizes.
//
//   node scripts/bench-pdf.mjs "<file.pdf>" [more.pdf ...]

import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  reconstructPage,
  linesToText,
  linesToMarkdown,
  appendOmittedImagesNote,
  countChars,
  classifyDocument,
  hasFlattenedFigure,
  hasOmittedChartTable,
  shouldScanImages,
  extrapolateImages,
  IMAGE_OP_NAMES,
} from "../src/convert/classify.js";
import { scanPageOps, countSignificantImages } from "../src/convert/raster-gate.js";
import { estimateTokens, IMAGE_TOKENS_PER_PAGE } from "../src/convert/savings.js";

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node scripts/bench-pdf.mjs "<file.pdf>" [more.pdf ...]');
  process.exit(1);
}

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]));

function fmtBytes(n) {
  return n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

for (const path of paths) {
  const buf = await readFile(path);
  const t0 = performance.now();
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), verbosity: 0 });
  const pdf = await task.promise;
  const labels = await pdf.getPageLabels().catch(() => null);

  // Mirror analyzePdf (inbrowser.js): per-page signals for the classifier,
  // Markdown assembled the same way, column gutter carried page-to-page.
  const perPage = [];
  const pageMarkdown = [];
  let gutter = null;
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const { lines, gutter: pageGutter } = reconstructPage(content.items, gutter);
    gutter = pageGutter;
    let images = null;
    let figureImages = null;
    if (shouldScanImages(n, pdf.numPages)) {
      images = 0;
      figureImages = 0;
      try {
        const ops = await page.getOperatorList();
        for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
        const scan = scanPageOps(ops.fnArray, ops.argsArray, pdfjs.OPS);
        const [vx0, vy0, vx1, vy1] = page.view;
        figureImages = countSignificantImages(scan, (vx1 - vx0) * (vy1 - vy0));
      } catch {
        /* operator list unavailable */
      }
    }
    const label = labels?.[n - 1] ?? n;
    const pageMd = linesToMarkdown(lines, label);
    perPage.push({
      chars: countChars(linesToText(lines)),
      images,
      figureImages,
      flattened: hasFlattenedFigure(lines) || hasOmittedChartTable(pageMd),
    });
    pageMarkdown.push(appendOmittedImagesNote(pageMd, images ?? 0, label));
  }
  const { decision, reason, summary } = classifyDocument(
    extrapolateImages(perPage)
  );
  const markdown =
    decision === "convert" || decision === "ambiguous"
      ? pageMarkdown.join("\n\n---\n\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"
      : null;
  const ms = performance.now() - t0;
  await task.destroy();

  console.log(`\nFile:      ${path}`);
  console.log(`PDF:       ${fmtBytes(buf.length)}, ${pdf.numPages} pages`);
  console.log(`Decision:  ${decision.toUpperCase()} (${reason})`);
  console.log(
    `Signals:   ${summary.contentPages} text pages, ${summary.chartPages} ` +
      `figure pages, ${summary.totalChars} chars, ${summary.totalImages} images`
  );
  if (markdown) {
    const mdTokens = estimateTokens(markdown.length);
    const originalTokens = mdTokens + pdf.numPages * IMAGE_TOKENS_PER_PAGE;
    const pct = Math.round(((originalTokens - mdTokens) / originalTokens) * 100);
    console.log(`Markdown:  ${fmtBytes(markdown.length)}`);
    console.log(
      `Tokens:    ~${originalTokens} as PDF (text ~${mdTokens} + ` +
        `${pdf.numPages} pages × ${IMAGE_TOKENS_PER_PAGE} image tokens) → ` +
        `~${mdTokens} as Markdown (~${pct}% saved)`
    );
  } else {
    console.log(`Markdown:  none — ${decision} (no savings claimed)`);
  }
  console.log(`Time:      ${(ms / 1000).toFixed(1)} s`);
}
console.log();
