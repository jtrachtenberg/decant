// Node asset resolver for the CLI surface (CLI.md §3.1). The engines resolve
// their pdf.js runtime assets through getAssetUrl() with browser-flat names
// ("pdf.worker.mjs", "standard_fonts/", "wasm/", "iccs/"); under Node those live
// inside the installed pdfjs-dist package under a different layout (the worker is
// in build/). This maps each name to a file:// URL pdf.js can fetch and injects
// it via setAssetResolver — which MUST run before any engine module loads, so
// the CLI calls installNodeAssets() and only then dynamically imports the core.
//
// A packaged binary (SEA, CLI.md §7) has no node_modules; it will call
// setAssetResolver directly against its unpacked asset dir instead of this.

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setAssetResolver } from "../convert/assets.js";

export function pdfjsDistDir() {
  const require = createRequire(import.meta.url);
  // Resolve a known file inside the package, then walk up to the package root —
  // some packages don't export package.json, so don't resolve that directly.
  // legacy/build/pdf.mjs → legacy/build → legacy → <root>.
  return dirname(dirname(dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))));
}

export function installNodeAssets(baseDir = pdfjsDistDir()) {
  // Two shapes, because pdf.js consumes the assets two different ways:
  //   - The worker is loaded with ESM import(), which on Windows REQUIRES a
  //     file:// URL — a bare "C:\…\pdf.worker.mjs" is read as URL scheme "c:"
  //     and rejected ("fake worker failed"). file:// works on every OS.
  //   - standard_fonts/wasm/iccs are read from disk by pdf.js's Node loader via
  //     fs, and Node's fetch() has no file:// scheme, so those must stay PLAIN
  //     paths (a file:// URL there fails to load the fonts/WASM). pdf.js appends
  //     the filename to the dir assets, so those keep a trailing "/".
  // standard_fonts/, wasm/, iccs/ live at the package root; the worker matching
  // the legacy build Node loads (#pdfjs) is under legacy/build/.
  const dir = (p) => join(baseDir, ...p) + "/";
  const map = {
    "pdf.worker.mjs": pathToFileURL(join(baseDir, "legacy", "build", "pdf.worker.mjs")).href,
    "standard_fonts/": dir(["standard_fonts"]),
    "wasm/": dir(["wasm"]),
    "iccs/": dir(["iccs"]),
  };
  setAssetResolver((rel) => {
    const url = map[rel];
    if (!url) throw new Error(`[decant] unknown asset "${rel}"`);
    return url;
  });
}
