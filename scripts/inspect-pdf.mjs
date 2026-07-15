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
  appendVectorChartNote,
  appendSymbolKeyNote,
  countChars,
  columnConvergence,
  classifyDocument,
  hasFlattenedFigure,
  flattenedWithEvidence,
  selectChartPages,
  shouldScanImages,
  extrapolateImages,
  createFurnitureDetector,
  stripFurniture,
  MAX_ANALYZE_PAGES,
  IMAGE_OP_NAMES,
} from "../src/convert/classify.js";
import {
  scanPageOps,
  decodeCandidate,
  countSignificantImages,
  hasVectorChartFills,
  vectorChartBox,
  textPointsFromItems,
  imageDimsKey,
  REPEATED_DIMS_MIN_PAGES,
} from "../src/convert/raster-gate.js";
import { symbolKeyPlan, symbolLabelItems } from "../src/convert/symbol-key.js";
import { MAX_SUBSET_PAGES } from "../src/convert/pdf-subset.js";

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

// Furniture pass, mirroring analyzePdf: running headers / nav rails repeated
// at the same position across many pages are stripped before reconstruction.
// The repeated-image census rides the same pass (intrinsic dims recurring
// across pages mark decoration — raster-gate.js isRepeatedImage), sampled
// exactly like the extension's image scan.
const furnitureDetector = createFurnitureDetector();
const dimsPages = new Map(); // imageDimsKey → Set of page numbers
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  furnitureDetector.addPage((await page.getTextContent()).items);
  if (!shouldScanImages(n, pdf.numPages)) continue;
  try {
    const ops = await page.getOperatorList();
    const scan = scanPageOps(ops.fnArray, ops.argsArray, pdfjs.OPS);
    for (const x of scan.xobjects) {
      if (x.w == null || x.h == null) continue;
      const key = imageDimsKey(x.w, x.h);
      if (!dimsPages.has(key)) dimsPages.set(key, new Set());
      dimsPages.get(key).add(n);
    }
  } catch {
    /* operator list unavailable — census just sees less */
  }
}
const furnitureKeys = furnitureDetector.keys();
const repeatedDims = new Set();
for (const [key, pages] of dimsPages) {
  if (pages.size >= REPEATED_DIMS_MIN_PAGES) repeatedDims.add(key);
}
const pageItems = async (n) =>
  stripFurniture(
    (await (await pdf.getPage(n)).getTextContent()).items,
    furnitureKeys
  );

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
  let plan = null;
  for (let n = 1; n <= pageArg; n++) {
    const items = await pageItems(n);
    // Icon-key decoding parity with analyzePdf: inject usage labels before
    // reconstruction on every scanned page (symbol-key.js, ADR 0017).
    plan = null;
    if (shouldScanImages(n, pdf.numPages)) {
      try {
        const ops = await (await pdf.getPage(n)).getOperatorList();
        plan = symbolKeyPlan(
          scanPageOps(ops.fnArray, ops.argsArray, pdfjs.OPS),
          items
        );
      } catch {
        /* operator list unavailable */
      }
    }
    const res = reconstructPage(
      plan ? [...items, ...symbolLabelItems(plan)] : items,
      gutter
    );
    gutter = res.gutter;
    lines = res.lines;
  }
  const conv = columnConvergence(lines);
  const chars = countChars(linesToText(lines));
  const page = await pdf.getPage(pageArg);
  const images = await countImages(page);
  // Vector-chart note parity with analyzePdf: the drill-down should show the
  // exact Markdown the extension emits, symbol-chart marker included — and
  // stood down when the decoded symbol key accounts for every colored fill.
  let vectorChart = false;
  try {
    const ops = await page.getOperatorList();
    vectorChart = hasVectorChartFills(
      scanPageOps(ops.fnArray, ops.argsArray, pdfjs.OPS)
    );
  } catch {
    /* ignore */
  }
  if (plan?.suppress) vectorChart = false;
  // Match the extension: markers speak the document's printed page labels
  // when the PDF defines them, physical index otherwise.
  const labels = await pdf.getPageLabels().catch(() => null);
  const label = labels?.[pageArg - 1] ?? pageArg;
  let md = linesToMarkdown(lines, label);
  if (plan) md = appendSymbolKeyNote(md, plan.entries.map((e) => e.label));
  if (vectorChart) md = appendVectorChartNote(md, label);
  md = appendOmittedImagesNote(md, images, label);
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
// Vector-symbol-chart crop bands (QA readout): what pdf-figures.js would
// crop each "v" page to, or whole-page when the box isn't confident.
const chartBands = [];
// Decoded symbol keys (QA readout): pages where an icon-key plan formed, its
// entry labels/usage counts, and whether the strict accounting closed.
const symbolPages = [];
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const items = await pageItems(n);

  let images = null;
  let figureImages = null;
  let decodable = false;
  let vectorChart = false;
  let scan = null;
  if (shouldScanImages(n, pdf.numPages)) {
    images = 0;
    figureImages = 0;
    try {
      const ops = await page.getOperatorList();
      for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
      scan = scanPageOps(ops.fnArray, ops.argsArray, pdfjs.OPS);
    } catch {
      /* operator list unavailable */
    }
  }
  // Icon-key decoding parity with analyzePdf (symbol-key.js, ADR 0017):
  // inject usage labels before reconstruction; a closed accounting stands the
  // vector-chart escalation down.
  const plan = scan ? symbolKeyPlan(scan, items) : null;
  if (plan) {
    symbolPages.push({
      page: n,
      suppress: plan.suppress,
      entries: plan.entries.map((e) => `${e.label} ×${e.usages.length}`),
    });
  }
  const lines = reconstructLines(
    plan ? [...items, ...symbolLabelItems(plan)] : items
  );
  const chars = countChars(linesToText(lines));
  const conv = columnConvergence(lines);
  // Does the page carry the pre-existing *table* low-confidence marker (the
  // column-split + tabular signal)? Match its text specifically — now that
  // convergence wiring adds its own flattened-figure marker, a bare
  // `l.marker` check would count every flagged page as redundant.
  const marker = lines.some(
    (l) => l.marker && /low structural confidence/.test(l.cells[0]?.text || "")
  );

  if (scan) {
    try {
      const [vx0, vy0, vx1, vy1] = page.view;
      const pageArea = (vx1 - vx0) * (vy1 - vy0);
      // Geometry for the background demotion, mirroring analyzePdf: page view
      // for the full-bleed/text-density checks, text anchor points (furniture
      // stripped, as in the extension) for the under-text checks, and the
      // repeated-image census for the cross-page decoration demotion.
      const opts = {
        view: page.view,
        textPoints: textPointsFromItems(items),
        repeatedDims,
      };
      // Significance (classification's single-figure ambiguity trigger).
      figureImages = countSignificantImages(scan, pageArea, opts);
      // Raster-decode eligibility (pdf-figures.js extractPdfRasterFigures):
      // geometric gates only — the g_/fingerprint repetition checks need the
      // full decode pass, so a "d" here is necessary-not-sufficient.
      decodable = !!decodeCandidate(scan, pageArea, opts);
      // Vector symbol chart (colored categorical fills, values not in text),
      // stood down when the decoded key accounts for every colored fill.
      vectorChart = hasVectorChartFills(scan) && !plan?.suppress;
      // The crop band the figures flow would use (pdf-figures.js
      // paddedFigureBox: the fills' band + 48pt pads — full page width on
      // portrait pages, the band's own x-range on landscape slide layouts —
      // skipped past 85% of the page). Recorded for the QA readout below.
      if (vectorChart) {
        const band = vectorChartBox(scan);
        if (band) {
          const landscape = vx1 - vx0 > vy1 - vy0;
          const x0 = landscape ? Math.max(vx0, band.x0 - 48) : vx0;
          const x1 = landscape ? Math.min(vx1, band.x1 + 48) : vx1;
          const y0 = Math.max(vy0, band.y0 - 48);
          const y1 = Math.min(vy1, band.y1 + 48);
          const frac =
            ((x1 - x0) * (y1 - y0)) / ((vx1 - vx0) * (vy1 - vy0));
          chartBands.push({
            page: n,
            x0,
            x1,
            y0,
            y1,
            frac,
            fullWidth: !landscape,
            crops: frac <= 0.85,
          });
        } else {
          chartBands.push({ page: n, y0: null, y1: null, frac: 1, crops: false });
        }
      }
    } catch {
      /* ignore */
    }
  }

  // flattened mirrors the extension's perPage signal (analyzePdf): the
  // flattened-figure marker joins the figures flow only with visual evidence
  // (raster paint or the vector-chart fill signal — flattenedWithEvidence);
  // a vector chart joins even with zero raster images.
  perPage.push({
    chars,
    images,
    figureImages,
    conv,
    marker,
    decodable,
    vectorChart,
    symbolKey: !!plan,
    flattened: flattenedWithEvidence(
      hasFlattenedFigure(lines),
      images,
      vectorChart
    ),
  });
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
  // Trailing " f" = the page carries a significant figure (the single-page
  // ambiguity trigger); " d" = its figure is a single decodable raster
  // XObject (would take the native-pixels path instead of a render crop);
  // " v" = the colored-fill scan reads the page as a vector symbol chart
  // (joins the figures flow as a flattened page); " k" = an icon-key plan
  // decoded symbols to text (symbol-key.js — see the readout below).
  console.log(
    pad(i + 1, 5) + pad(chars, 9) + pad(sampled + images, 8) + pad(convCol, 8) +
      kind + (perPage[i].figureImages ? " f" : "") +
      (perPage[i].decodable ? " d" : "") +
      (perPage[i].vectorChart ? " v" : "") +
      (perPage[i].symbolKey ? " k" : "")
  );
});

console.log("-".repeat(48));
const { decision, reason, summary } = classifyDocument(filled);
console.log(
  `\nSummary: ${summary.contentPages}/${summary.pageCount} text pages, ` +
    `${summary.chartPages} chart pages, ${summary.totalChars} chars, ` +
    `${summary.totalImages} images` +
    (repeatedDims.size
      ? `\nRepeated-image census: ${repeatedDims.size} cross-page dims demoted as decoration`
      : "")
);
console.log(`Decision: ${decision.toUpperCase()} (${reason})`);

// What the figures flow would actually attach: the capped, value-ranked page
// selection every figure path shares (selectChartPages) — flattened chart
// pages first, then significant-figure pages, then the rest.
if (summary.chartPageNumbers.length) {
  const attached = selectChartPages(summary, MAX_SUBSET_PAGES);
  const scanNote = summary.scanPageNumbers?.length
    ? `, ${summary.scanPageNumbers.length} image-only scans cap-exempt`
    : "";
  console.log(
    `Attached (cap ${MAX_SUBSET_PAGES}${scanNote}): ${attached.length} of ` +
      `${summary.chartPageNumbers.length} figure pages → ${attached.join(", ")}` +
      (summary.flattenedPageNumbers.length
        ? `
  flattened chart pages (priority): ${summary.flattenedPageNumbers.join(", ")}`
        : "")
  );
  for (const b of chartBands) {
    console.log(
      `  vector-chart crop p${b.page}: ` +
        (b.crops
          ? `y ${b.y0.toFixed(0)}–${b.y1.toFixed(0)} (${(b.frac * 100).toFixed(0)}% of page, ` +
            (b.fullWidth ? "full width" : `x ${b.x0.toFixed(0)}–${b.x1.toFixed(0)}`) + ")"
          : `whole page (${b.y0 == null ? "no confident band" : `band ${(b.frac * 100).toFixed(0)}% > 85%`})`)
    );
  }
}

// Symbol-key readout: pages whose repeated textless icons decoded against a
// key legend, with the per-class usage counts and the suppression verdict
// (closed accounting = the vector-chart note and attachment stand down).
for (const s of symbolPages) {
  console.log(
    `Symbol key p${s.page}: ${s.entries.join("; ")} — ` +
      (s.suppress
        ? "accounting closed (note + attachment stand down)"
        : "PARTIAL (note + attachment kept)")
  );
}

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
