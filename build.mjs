// Decant build — bundles the content script and stages the unpacked extension
// into dist/. Load dist/ in Chrome via "Load unpacked".
//
//   node build.mjs           one-shot build
//   node build.mjs --watch   rebuild content script on change
//
// The pdf.js worker is copied verbatim from pdfjs-dist (not bundled): it's a
// module worker shipped ready-to-run, and pdf.js spawns it from the
// extension URL we set as workerSrc. Bundling it ourselves risks top-level
// await / ESM-worker mismatches for no benefit.

import * as esbuild from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const outdir = "dist";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Static assets copied as-is.
await cp("manifest.json", `${outdir}/manifest.json`);
await cp(
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  `${outdir}/pdf.worker.mjs`
);

const config = {
  entryPoints: { "content/intercept": "src/content/intercept.js" },
  outdir,
  bundle: true,
  format: "iife",
  target: "chrome120",
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log("watching src/ … (manifest/worker copied once at start)");
} else {
  await esbuild.build(config);
  console.log("build complete → dist/");
}
