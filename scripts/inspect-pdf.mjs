// Dev tool: report a PDF's per-page composition and the conversion decision
// Decant would make for it. Read-only; never rasterizes.
//
//   node scripts/inspect-pdf.mjs "<file.pdf>"
//   npm run inspect -- "<file.pdf>"
//
// Runs the SHARED analyzePdf() engine the extension and the CLI use (via the
// CLI's Node asset resolver, like bench-pdf.mjs), observing its per-page loop
// through the onPage seam rather than re-deriving the signals here. That is the
// whole point of the tool: a parallel copy of the analysis drifts, and a
// drifted copy reports a routing decision the extension would never make. (It
// did: this file used to mirror the loop, and on a 47-page text document with
// one significant figure it printed CONVERT while the extension prompted
// ambiguous — the mirror had no cross-page gutter, no standard-font metrics,
// no WASM raster decoders and no repeated-fill census.) Everything below is
// formatting; the numbers come from the engine.
//
// Handy for calibrating thresholds and as a manual regression check against a
// corpus of tricky PDFs (clean text, scans, text-with-charts).

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { installNodeAssets } from "../src/cli/node-assets.js";
import {
  columnConvergence,
  selectChartPages,
  extrapolateImages,
  MAX_ANALYZE_PAGES,
} from "../src/convert/classify.js";
import { decodeCandidate, vectorChartBox } from "../src/convert/raster-gate.js";
import { MAX_SUBSET_PAGES } from "../src/convert/pdf-subset.js";

// Resolve pdf.js assets before importing the engine (inbrowser.js reads its
// asset URLs at module load — CLI.md §3.1). classify.js / raster-gate.js /
// pdf-subset.js above import nothing browser-specific, so they load statically.
installNodeAssets();
const { analyzePdf } = await import("../src/convert/inbrowser.js");

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

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// --- Observe the engine -----------------------------------------------------
// One analyzePdf() run over the document; every row below is derived from what
// its loop handed back. The two things computed here rather than there are
// pure read-outs of the same inputs the engine already judged with: the
// convergence score (a QA metric the classifier itself doesn't consume) and
// raster-gate's decode-eligibility / crop-band gates, called with the very
// scan + pageArea + significance options the engine passed to
// countSignificantImages.
const pages = [];
// Vector-symbol-chart crop bands (QA readout): what pdf-figures.js would
// crop each "v" page to, or whole-page when the box isn't confident.
const chartBands = [];
// Decoded symbol keys (QA readout): pages where an icon-key plan formed, its
// entry labels/usage counts, and whether the strict accounting closed.
const symbolPages = [];
let census = { repeatedDims: new Set(), repeatedFills: new Set() };

const buf = await readFile(path);
const { decision, reason, summary } = await analyzePdf(
  new File([buf], basename(path), { type: "application/pdf" }),
  {
    onPage(p) {
      census = p.census;
      const { chars, images, figureImages, garbled, garbledTotal } = p.signals;
      // Does the page carry the pre-existing *table* low-confidence marker (the
      // column-split + tabular signal)? Match its text specifically — now that
      // convergence wiring adds its own flattened-figure marker, a bare
      // `l.marker` check would count every flagged page as redundant.
      const marker = p.lines.some(
        (l) => l.marker && /low structural confidence/.test(l.cells[0]?.text || "")
      );
      // Raster-decode eligibility (pdf-figures.js extractPdfRasterFigures):
      // geometric gates only — the g_/fingerprint repetition checks need the
      // full decode pass, so a "d" here is necessary-not-sufficient.
      const decodable =
        !!p.scan && !!decodeCandidate(p.scan, p.pageArea, p.imageOpts);
      pages.push({
        page: p.page,
        chars,
        images,
        figureImages,
        conv: columnConvergence(p.lines),
        marker,
        decodable,
        vectorChart: p.vectorChart,
        symbolKey: !!p.symbolPlan,
        garble: p.garble,
        garbled,
        garbledTotal,
        markdown: p.markdown,
      });
      if (p.symbolPlan) {
        symbolPages.push({
          page: p.page,
          suppress: p.symbolPlan.suppress,
          entries: p.symbolPlan.entries.map((e) => `${e.label} ×${e.usages.length}`),
        });
      }
      // The crop band the figures flow would use (pdf-figures.js
      // paddedFigureBox: the fills' band + 48pt pads — full page width on
      // portrait pages, the band's own x-range on landscape slide layouts —
      // skipped past 85% of the page).
      if (!p.vectorChart) return;
      const [vx0, vy0, vx1, vy1] = p.view;
      const band = vectorChartBox(p.scan);
      if (!band) {
        chartBands.push({ page: p.page, y0: null, y1: null, frac: 1, crops: false });
        return;
      }
      const landscape = vx1 - vx0 > vy1 - vy0;
      const x0 = landscape ? Math.max(vx0, band.x0 - 48) : vx0;
      const x1 = landscape ? Math.min(vx1, band.x1 + 48) : vx1;
      const y0 = Math.max(vy0, band.y0 - 48);
      const y1 = Math.min(vy1, band.y1 + 48);
      const frac = ((x1 - x0) * (y1 - y0)) / ((vx1 - vx0) * (vy1 - vy0));
      chartBands.push({
        page: p.page,
        x0,
        x1,
        y0,
        y1,
        frac,
        fullWidth: !landscape,
        crops: frac <= 0.85,
      });
    },
  }
);
const pageCount = summary.pageCount;

// --- `--page N`: show the exact Markdown Decant would emit for one page -----
// The Tier 2 QA drill-down. A flagged page that dumps as garbled label
// fragments is a true positive (the marker belongs); one that dumps as a
// clean pipe table or readable prose is a false positive (the threshold or
// metric is wrong). This is the engine's own emitted page Markdown, verbatim.
if (pageArg != null) {
  if (!Number.isInteger(pageArg) || pageArg < 1 || pageArg > pageCount) {
    console.error(`--page must be 1–${pageCount}`);
    process.exit(1);
  }
  const p = pages[pageArg - 1];
  const low = p.chars >= 50 && p.conv.score < CONV_THRESHOLD;

  console.log(`\nFile:  ${path}`);
  console.log(`Page:  ${pageArg} of ${pageCount}`);
  console.log(
    `Signals: ${p.chars} chars, ${p.images ?? "unscanned"} images, ` +
      `convergence ${p.conv.score.toFixed(2)} (columns=${p.conv.columns}, bands=${p.conv.bands})`
  );
  console.log(
    `Verdict: ${
      p.chars < 50
        ? "not a text page — convergence N/A"
        : low
          ? `BELOW ${CONV_THRESHOLD} → would be flagged low-confidence`
          : `at/above ${CONV_THRESHOLD} → not flagged`
    }`
  );
  console.log("\n=== Markdown Decant would emit for this page ===\n");
  console.log(p.markdown || "(nothing extracted)");
  console.log("\n=== end ===\n");
  process.exit(0);
}

console.log(`\nFile:  ${path}`);
console.log(`Pages: ${pageCount}\n`);
console.log(
  pad("pg", 5) + pad("chars", 9) + pad("images", 8) + pad("conv", 8) + "kind"
);
console.log("-".repeat(48));

// Above MAX_ANALYZE_PAGES the engine samples the operator-list scan and
// extrapolates; the same fill-in is applied here so the table's image column
// reads like the counts classification actually saw.
if (pageCount > MAX_ANALYZE_PAGES) {
  console.log(
    `(> ${MAX_ANALYZE_PAGES} pages — image counts sampled; "~" rows are extrapolated)\n`
  );
}

// Text pages scoring below the threshold — the pages the Tier 2 marker would
// flag as low-confidence chart/figure content.
const flagged = [];
const filled = extrapolateImages(pages);
filled.forEach(({ chars, images }, i) => {
  const sampled = pages[i].images == null ? "~" : "";
  const kind =
    chars < 50 ? (images ? "image/empty" : "empty") : images ? "text+image" : "text";
  // Convergence only means something on a page with real text; sub-threshold
  // text pages are the candidates to eyeball.
  const isText = chars >= 50;
  const conv = pages[i].conv;
  const low = isText && conv.score < CONV_THRESHOLD;
  if (low) flagged.push({ page: i + 1, marker: pages[i].marker });
  // Trailing "m" on a flagged row = the page already carries the existing
  // low-confidence marker (so a convergence flag would be redundant there).
  const convCol = isText
    ? conv.score.toFixed(2) + (low ? (pages[i].marker ? " *m" : " *") : "")
    : "—";
  // Trailing " f" = the page carries a significant figure (the single-page
  // ambiguity trigger); " d" = its figure is a single decodable raster
  // XObject (would take the native-pixels path instead of a render crop);
  // " v" = the colored-fill scan reads the page as a vector symbol chart
  // (joins the figures flow as a flattened page); " k" = an icon-key plan
  // decoded symbols to text (symbol-key.js — see the readout below).
  console.log(
    pad(i + 1, 5) + pad(chars, 9) + pad(sampled + images, 8) + pad(convCol, 8) +
      kind + (pages[i].figureImages ? " f" : "") +
      (pages[i].decodable ? " d" : "") +
      (pages[i].vectorChart ? " v" : "") +
      (pages[i].symbolKey ? " k" : "") +
      // " g" = the page's text layer is undecodable (its glyph runs were
      // dropped); " G" = undecodable end to end, so it is also cap-exempt.
      (pages[i].garbledTotal
        ? ` G${(pages[i].garble.ratio * 100).toFixed(0)}%`
        : pages[i].garbled
          ? ` g${(pages[i].garble.ratio * 100).toFixed(0)}%`
          : "")
  );
});

console.log("-".repeat(48));
console.log(
  `\nSummary: ${summary.contentPages}/${summary.pageCount} text pages, ` +
    `${summary.chartPages} chart pages, ${summary.totalChars} chars, ` +
    `${summary.totalImages} images` +
    (census.repeatedDims.size
      ? `\nRepeated-image census: ${census.repeatedDims.size} cross-page dims demoted as decoration`
      : "") +
    (census.repeatedFills.size
      ? `\nRepeated-fill census: ${census.repeatedFills.size} cross-page fills demoted as furniture`
      : "")
);
console.log(`Decision: ${decision.toUpperCase()} (${reason})`);

// What the figures flow would actually attach: the capped, value-ranked page
// selection every figure path shares (selectChartPages) — flattened chart
// pages first, then significant-figure pages, then the rest.
if (summary.chartPageNumbers.length) {
  const attached = selectChartPages(summary, MAX_SUBSET_PAGES);
  const exempt = [
    summary.scanPageNumbers?.length
      ? `${summary.scanPageNumbers.length} image-only scans`
      : null,
    summary.unreadablePageNumbers?.length
      ? `${summary.unreadablePageNumbers.length} undecodable-text pages`
      : null,
  ].filter(Boolean);
  const scanNote = exempt.length ? `, ${exempt.join(" + ")} cap-exempt` : "";
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
const textScores = pages.filter((p) => p.chars >= 50).map((p) => p.conv.score);
if (textScores.length) {
  const lo = Math.min(...textScores).toFixed(2);
  const hi = Math.max(...textScores).toFixed(2);
  const pageList = (list) => list.map((f) => f.page).join(", ");
  console.log(
    `Convergence (threshold ${CONV_THRESHOLD}): ${textScores.length} text pages, ` +
      `range ${lo}–${hi}` +
      (flagged.length
        ? `; ${flagged.length} below → pages ${pageList(flagged)}`
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
        (redundant.length ? ` → pages ${pageList(redundant)}` : "")
    );
    console.log(
      `  convergence-only (new coverage): ${unique.length}` +
        (unique.length ? ` → pages ${pageList(unique)}` : "")
    );
  }
}
console.log();
