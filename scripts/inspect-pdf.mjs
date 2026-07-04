// Dev tool: report a PDF's per-page composition and the conversion decision
// Decant would make for it. Read-only; never rasterizes. Uses the same
// classify.js logic the extension uses, so its verdict matches real behavior.
//
//   node scripts/inspect-pdf.mjs "<file.pdf>"
//   npm run inspect -- "<file.pdf>"
//
// Handy for calibrating thresholds and as a manual regression check against a
// corpus of tricky PDFs (clean text, scans, text-with-charts).

import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  reconstructPage,
  reconstructLines,
  linesToText,
  linesToMarkdown,
  appendOmittedImagesNote,
  countChars,
  columnConvergence,
  classifyDocument,
  shouldScanImages,
  extrapolateImages,
  MAX_ANALYZE_PAGES,
  IMAGE_OP_NAMES,
} from "../src/convert/classify.js";

// Args: the file path, plus an optional `--page N` that dumps the Markdown
// Decant would emit for one page (the Tier 2 QA drill-down) instead of the
// whole-document table.
const args = process.argv.slice(2);
let path = null;
let pageArg = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--page") pageArg = Number(args[++i]);
  else if (!path) path = args[i];
}
if (!path) {
  console.error('usage: node scripts/inspect-pdf.mjs "<file.pdf>" [--page N]');
  process.exit(1);
}

// Tier 2 QA (SPEC §3.9): a page's column-clustering convergence. Text pages
// below this score are candidate chart/figure "label soup" — the wiring under
// evaluation would flag them. Tunable per run so a corpus can be swept:
//   CONV_THRESHOLD=0.45 npm run inspect -- "<file.pdf>"
const CONV_THRESHOLD = Number(process.env.CONV_THRESHOLD || 0.5);

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]));

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const buf = await readFile(path);
const pdf = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  verbosity: 0,
}).promise;

// --- `--page N`: show the exact Markdown Decant would emit for one page -----
// The Tier 2 QA drill-down. A flagged page that dumps as garbled label
// fragments is a true positive (the marker belongs); one that dumps as a
// clean pipe table or readable prose is a false positive (the threshold or
// metric is wrong). Reads exactly what the extension does: reconstructPage +
// linesToMarkdown + the image-omission note, with the column gutter threaded
// from page 1 so cross-page reflow matches real behavior.
async function countImages(page) {
  try {
    const ops = await page.getOperatorList();
    let images = 0;
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
    return images;
  } catch {
    return 0;
  }
}

if (pageArg != null) {
  if (!Number.isInteger(pageArg) || pageArg < 1 || pageArg > pdf.numPages) {
    console.error(`--page must be 1–${pdf.numPages}`);
    process.exit(1);
  }
  let gutter = null;
  let lines = [];
  for (let n = 1; n <= pageArg; n++) {
    const content = await (await pdf.getPage(n)).getTextContent();
    const res = reconstructPage(content.items, gutter);
    gutter = res.gutter;
    lines = res.lines;
  }
  const conv = columnConvergence(lines);
  const chars = countChars(linesToText(lines));
  const images = await countImages(await pdf.getPage(pageArg));
  const md = appendOmittedImagesNote(linesToMarkdown(lines), images);
  const low = chars >= 50 && conv.score < CONV_THRESHOLD;

  console.log(`\nFile:  ${path}`);
  console.log(`Page:  ${pageArg} of ${pdf.numPages}`);
  console.log(
    `Signals: ${chars} chars, ${images} images, ` +
      `convergence ${conv.score.toFixed(2)} (columns=${conv.columns}, bands=${conv.bands})`
  );
  console.log(
    `Verdict: ${
      chars < 50
        ? "not a text page — convergence N/A"
        : low
          ? `BELOW ${CONV_THRESHOLD} → would be flagged low-confidence`
          : `at/above ${CONV_THRESHOLD} → not flagged`
    }`
  );
  console.log("\n=== Markdown Decant would emit for this page ===\n");
  console.log(md || "(nothing extracted)");
  console.log("\n=== end ===\n");
  process.exit(0);
}

console.log(`\nFile:  ${path}`);
console.log(`Pages: ${pdf.numPages}\n`);
console.log(
  pad("pg", 5) + pad("chars", 9) + pad("images", 8) + pad("conv", 8) + "kind"
);
console.log("-".repeat(48));

// Mirror the extension: above MAX_ANALYZE_PAGES the operator-list scan is
// sampled and extrapolated, so the verdict here matches real behavior.
if (pdf.numPages > MAX_ANALYZE_PAGES) {
  console.log(
    `(> ${MAX_ANALYZE_PAGES} pages — image counts sampled; "~" rows are extrapolated)\n`
  );
}

const perPage = [];
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const lines = reconstructLines((await page.getTextContent()).items);
  const chars = countChars(linesToText(lines));
  const conv = columnConvergence(lines);
  // Does the page carry the pre-existing *table* low-confidence marker (the
  // column-split + tabular signal)? Match its text specifically — now that
  // convergence wiring adds its own flattened-figure marker, a bare
  // `l.marker` check would count every flagged page as redundant.
  const marker = lines.some(
    (l) => l.marker && /low structural confidence/.test(l.cells[0]?.text || "")
  );

  let images = null;
  if (shouldScanImages(n, pdf.numPages)) {
    images = 0;
    try {
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
    } catch {
      /* ignore */
    }
  }

  perPage.push({ chars, images, conv, marker });
}

// Text pages scoring below the threshold — the pages the Tier 2 marker would
// flag as low-confidence chart/figure content.
const flagged = [];
const filled = extrapolateImages(perPage);
filled.forEach(({ chars, images }, i) => {
  const sampled = perPage[i].images == null ? "~" : "";
  const kind =
    chars < 50 ? (images ? "image/empty" : "empty") : images ? "text+image" : "text";
  // Convergence only means something on a page with real text; sub-threshold
  // text pages are the candidates to eyeball.
  const isText = chars >= 50;
  const conv = perPage[i].conv;
  const low = isText && conv.score < CONV_THRESHOLD;
  if (low) flagged.push({ page: i + 1, marker: perPage[i].marker });
  // Trailing "m" on a flagged row = the page already carries the existing
  // low-confidence marker (so a convergence flag would be redundant there).
  const convCol = isText
    ? conv.score.toFixed(2) + (low ? (perPage[i].marker ? " *m" : " *") : "")
    : "—";
  console.log(
    pad(i + 1, 5) + pad(chars, 9) + pad(sampled + images, 8) + pad(convCol, 8) + kind
  );
});

console.log("-".repeat(48));
const { decision, reason, summary } = classifyDocument(filled);
console.log(
  `\nSummary: ${summary.contentPages}/${summary.pageCount} text pages, ` +
    `${summary.chartPages} chart pages, ${summary.totalChars} chars, ` +
    `${summary.totalImages} images`
);
console.log(`Decision: ${decision.toUpperCase()} (${reason})`);

// Tier 2 convergence readout: which text pages fall below the threshold (the
// ones the marker would flag). On a clean prose/table document this list
// should be empty or near-empty; a chart-heavy report should light up its
// figure pages. Sweep CONV_THRESHOLD to find where real content and label
// soup separate on your corpus.
const textScores = perPage
  .filter((p) => p.chars >= 50)
  .map((p) => p.conv.score);
if (textScores.length) {
  const lo = Math.min(...textScores).toFixed(2);
  const hi = Math.max(...textScores).toFixed(2);
  const pages = (list) => list.map((f) => f.page).join(", ");
  console.log(
    `Convergence (threshold ${CONV_THRESHOLD}): ${textScores.length} text pages, ` +
      `range ${lo}–${hi}` +
      (flagged.length
        ? `; ${flagged.length} below → pages ${pages(flagged)}`
        : "; none below threshold")
  );
  // The wiring question, answered across the whole document: of the pages
  // convergence would flag, how many already carry the existing low-confidence
  // marker (redundant) vs are caught only by convergence (new coverage)?
  if (flagged.length) {
    const redundant = flagged.filter((f) => f.marker);
    const unique = flagged.filter((f) => !f.marker);
    console.log(
      `  already marked (redundant): ${redundant.length}` +
        (redundant.length ? ` → pages ${pages(redundant)}` : "")
    );
    console.log(
      `  convergence-only (new coverage): ${unique.length}` +
        (unique.length ? ` → pages ${pages(unique)}` : "")
    );
  }
}
console.log();
