// Dev tool: benchmark Decant's PDF conversion on real documents — the numbers
// behind the README's Benchmarks table. Runs the SHARED analyzePdf() engine the
// extension and the CLI use (via the CLI's Node asset resolver), so what it
// reports is exactly what ships — no re-implemented loop to drift (CLI.md §2,
// C0). Reports measured sizes plus the savings badge's own token estimate
// (savings.js: ~4 chars/token for text, IMAGE_TOKENS_PER_PAGE per page for the
// image layer). Never rasterizes.
//
//   node scripts/bench-pdf.mjs "<file.pdf>" [more.pdf ...]

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { installNodeAssets } from "../src/cli/node-assets.js";
import { estimateTokens, IMAGE_TOKENS_PER_PAGE } from "../src/convert/savings.js";

// Resolve pdf.js assets before importing the engine (inbrowser.js reads its
// asset URLs at module load — CLI.md §3.1).
installNodeAssets();
const { analyzePdf } = await import("../src/convert/inbrowser.js");

const paths = process.argv.slice(2);
if (!paths.length) {
  console.error('usage: node scripts/bench-pdf.mjs "<file.pdf>" [more.pdf ...]');
  process.exit(1);
}

function fmtBytes(n) {
  return n >= 1048576
    ? `${(n / 1048576).toFixed(1)} MB`
    : `${Math.round(n / 1024)} KB`;
}

for (const path of paths) {
  const buf = await readFile(path);
  const t0 = performance.now();
  const { decision, reason, summary, markdown } = await analyzePdf(
    new File([buf], basename(path), { type: "application/pdf" })
  );
  const ms = performance.now() - t0;

  console.log(`\nFile:      ${path}`);
  console.log(`PDF:       ${fmtBytes(buf.length)}, ${summary.pageCount} pages`);
  console.log(`Decision:  ${decision.toUpperCase()} (${reason})`);
  console.log(
    `Signals:   ${summary.contentPages} text pages, ${summary.chartPages} ` +
      `figure pages, ${summary.totalChars} chars, ${summary.totalImages} images`
  );
  if (markdown) {
    const mdTokens = estimateTokens(markdown.length);
    const originalTokens = mdTokens + summary.pageCount * IMAGE_TOKENS_PER_PAGE;
    const pct = Math.round(((originalTokens - mdTokens) / originalTokens) * 100);
    console.log(`Markdown:  ${fmtBytes(markdown.length)}`);
    console.log(
      `Tokens:    ~${originalTokens} as PDF (text ~${mdTokens} + ` +
        `${summary.pageCount} pages × ${IMAGE_TOKENS_PER_PAGE} image tokens) → ` +
        `~${mdTokens} as Markdown (~${pct}% saved)`
    );
  } else {
    console.log(`Markdown:  none — ${decision} (no savings claimed)`);
  }
  console.log(`Time:      ${(ms / 1000).toFixed(1)} s`);
}
console.log();
