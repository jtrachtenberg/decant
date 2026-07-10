// Decant build — bundles the content script and stages the unpacked extension.
//
//   node build.mjs                Chrome/Chromium build → dist/
//   node build.mjs --firefox      Firefox build          → dist-firefox/
//   node build.mjs --watch        rebuild on change (add --firefox to target FF)
//
// Load dist/ in Chrome via "Load unpacked"; load dist-firefox/manifest.json in
// Firefox via about:debugging → "Load Temporary Add-on".
//
// manifest.json is the Chrome manifest verbatim; the Chrome build copies it
// untouched, so Chrome's runtime is identical to a single-target build. The
// Firefox build derives its manifest from the same file (see below) and uses a
// lower esbuild target + its own output dir. The chrome.*/browser.* namespace is
// bridged at runtime by src/browser.js and the Firefox ReadableStream/blob
// quirks by src/content/rs-shim.js + src/convert/read-file.js, all self-gating,
// so the same bundles run on either browser.
//
// The pdf.js worker is copied verbatim from pdfjs-dist (not bundled): it's a
// module worker shipped ready-to-run, and pdf.js spawns it from the
// extension URL we set as workerSrc. Bundling it ourselves risks top-level
// await / ESM-worker mismatches for no benefit.

import * as esbuild from "esbuild";
import { cp, mkdir, rm, readFile, writeFile } from "node:fs/promises";

const watch = process.argv.includes("--watch");
const firefox = process.argv.includes("--firefox");

const outdir = firefox ? "dist-firefox" : "dist";
// esbuild's transpilation floor. Firefox 121 is the gecko strict_min_version in
// manifest.json (first release that ignores the MV3 service_worker key and runs
// the background.scripts fallback); Chrome 120 matches our MV3 baseline.
const target = firefox ? "firefox121" : "chrome120";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Chrome gets manifest.json verbatim. Firefox derives its manifest from the same
// source, differing only where MV3 Firefox genuinely diverges from Chrome:
//   - background: FF runs a non-persistent event page (`scripts` + module type),
//     not a service worker (`service_worker`).
//   - browser_specific_settings.gecko: FF requires an add-on id.
//   - web_accessible_resources.use_dynamic_url: FF rejects it as an unknown key
//     (harmless load warning); it buys a rotating resource URL on Chrome for
//     fingerprint resistance, which FF already provides via a random per-install
//     UUID origin, so it's redundant there. Stripped for FF.
// Keeping this transform in the build (not a checked-in second manifest) means
// the shared keys can't drift between targets.
if (firefox) {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  manifest.background = { scripts: ["background.js"], type: "module" };
  manifest.browser_specific_settings = {
    gecko: { id: "decant@decant.tools", strict_min_version: "121.0" },
  };
  for (const entry of manifest.web_accessible_resources ?? []) {
    delete entry.use_dynamic_url;
  }
  await writeFile(`${outdir}/manifest.json`, JSON.stringify(manifest, null, 2) + "\n");
} else {
  await cp("manifest.json", `${outdir}/manifest.json`);
}
await cp(
  "node_modules/pdfjs-dist/build/pdf.worker.mjs",
  `${outdir}/pdf.worker.mjs`
);
// Standard-font metrics pdf.js loads for the 14 non-embedded base PDF fonts
// (referenced via standardFontDataUrl in inbrowser.js). Copied verbatim.
await cp(
  "node_modules/pdfjs-dist/standard_fonts",
  `${outdir}/standard_fonts`,
  { recursive: true }
);
// WASM decoders pdf.js fetches at render time from the wasmUrl option
// (inbrowser.js): openjpeg.wasm (JPXDecode — JPEG2000, the norm in
// print-production PDFs), jbig2.wasm (JBIG2 scans), qcms_bg.wasm (ICC color
// management). Without these every JPX image silently fails to decode and
// photos render as black/blank regions. iccs/ is the CMYK ICC profile the
// iccUrl option points at, same failure shape for CMYK color conversion.
await cp("node_modules/pdfjs-dist/wasm", `${outdir}/wasm`, { recursive: true });
await cp("node_modules/pdfjs-dist/iccs", `${outdir}/iccs`, { recursive: true });
// Ship the project license and third-party attributions with the extension so
// the packaged artifact carries them (pdf.js is Apache-2.0; see THIRD-PARTY-NOTICES).
await cp("LICENSE", `${outdir}/LICENSE`);
await cp("THIRD-PARTY-NOTICES", `${outdir}/THIRD-PARTY-NOTICES`);
// Toolbar / store icons referenced by manifest.json's "icons" block. These
// must be copied explicitly — the manifest points at them by bare filename,
// so a missing copy is a silent load warning + broken icon.
for (const icon of ["decant_icon16.png", "decant_icon48.png", "decant_icon.png"]) {
  await cp(icon, `${outdir}/${icon}`);
}
// Options page markup (its script is bundled below).
await mkdir(`${outdir}/options`, { recursive: true });
await cp("src/options/options.html", `${outdir}/options/options.html`);

const config = {
  entryPoints: {
    "content/intercept": "src/content/intercept.js",
    background: "src/background.js",
    "options/options": "src/options/options.js",
  },
  outdir,
  bundle: true,
  format: "iife",
  target,
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(config);
  await ctx.watch();
  console.log(`watching src/ … → ${outdir}/ (target ${target}; manifest/worker copied once at start)`);
} else {
  await esbuild.build(config);
  console.log(`build complete → ${outdir}/ (target ${target})`);
}
