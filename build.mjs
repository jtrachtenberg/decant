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
// esbuild's transpilation floor, matching each target's manifest floor: Firefox
// 140 is the gecko strict_min_version set below, Chrome 120 our MV3 baseline.
const target = firefox ? "firefox140" : "chrome120";

await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });

// Chrome gets manifest.json verbatim. Firefox derives its manifest from the same
// source, differing only where MV3 Firefox genuinely diverges from Chrome:
//   - background: FF runs a non-persistent event page (`scripts` + module type),
//     not a service worker (`service_worker`).
//   - name: AMO rejects a name over 45 characters (addons-linter JSON_INVALID),
//     where the Chrome Web Store allows 75 — the keyword-bearing store title
//     doesn't fit, so Firefox gets a shorter one. Both name the same product,
//     and both are catalogue keys (see src/_locales): the linter resolves
//     __MSG_ against default_locale, so the length rule applies to the English
//     message and to every translation of it.
//   - browser_specific_settings.gecko: FF requires an add-on id, a version floor
//     (see below), and — for anything submitted to AMO since 2025-11-03 — a
//     data_collection_permissions declaration, without which signing is refused.
//     Decant collects nothing of its own (conversion is local; converted files
//     go only where the user was already sending them), hence required: none;
//     the optional companion is the one path that puts content on the wire, so
//     it is disclosed as opt-in. Reasoning in docs/store/firefox-amo.txt.
//   - web_accessible_resources.use_dynamic_url: FF rejects it as an unknown key
//     (harmless load warning); it buys a rotating resource URL on Chrome for
//     fingerprint resistance, which FF already provides via a random per-install
//     UUID origin, so it's redundant there. Stripped for FF.
// Keeping this transform in the build (not a checked-in second manifest) means
// the shared keys can't drift between targets.
//
// The 140 floor is the first release that understands every key above:
// optional_host_permissions (adding your own chat site on the options page)
// landed in 128, and data_collection_permissions in 140. It is also the current
// ESR, so nothing in support still runs below it.
if (firefox) {
  const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
  manifest.background = { scripts: ["background.js"], type: "module" };
  manifest.name = "__MSG_extNameShort__";
  manifest.browser_specific_settings = {
    gecko: {
      id: "decant@decant.tools",
      strict_min_version: "140.0",
      data_collection_permissions: {
        required: ["none"],
        optional: ["websiteContent"],
      },
    },
    // Android shipped data_collection_permissions two releases later than
    // desktop, so it carries its own floor rather than inheriting 140.
    gecko_android: { strict_min_version: "142.0" },
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
// quickjs-eval.* is excluded: it is a JavaScript interpreter pdf.js loads only
// to run scripts embedded in PDF forms, and its sole consumer is
// pdf.sandbox.mjs, which we never bundle — so it can't load here. Shipping it
// would add ~464 KB of unreachable payload, and put a file named "eval"
// containing a JS engine into a package whose store listing declares no remote
// code. The *_nowasm_fallback.js siblings look similar but must stay: those are
// the asm.js paths pdf.worker.mjs really falls back to when WASM is
// unavailable.
await cp("node_modules/pdfjs-dist/wasm", `${outdir}/wasm`, {
  recursive: true,
  filter: (src) => !/quickjs-eval\./.test(src),
});
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
// Message catalogues, one directory per language. They must sit at the package
// root under exactly this name — that's where the browser looks — and the
// manifest's default_locale names the one every other locale falls back to,
// key by key. i18n.js imports the English file as well, so the bundle carries
// a copy for the no-runtime case; this is the copy the browser itself reads.
await cp("src/_locales", `${outdir}/_locales`, { recursive: true });
// Options page markup (its script is bundled below).
await mkdir(`${outdir}/options`, { recursive: true });
await cp("src/options/options.html", `${outdir}/options/options.html`);

const config = {
  entryPoints: {
    "content/intercept": "src/content/intercept.js",
    "content/main-world": "src/content/main-world.js",
    // Injected on demand into the captured page under activeTab (SPEC §3.11) —
    // never registered as a content script, so it ships as its own bundle
    // carrying the serializer plus the HTML engine (Turndown needs a DOM, and
    // the service worker hasn't got one).
    "capture/inject": "src/capture/inject.js",
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
