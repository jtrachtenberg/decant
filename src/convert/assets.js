// Asset-URL resolution seam — the surface-agnostic front for the pdf.js runtime
// assets (worker, standard fonts, JPX/JBIG2/ICC WASM) that inbrowser.js and
// pdf-figures.js need at load time (ARCHITECTURE.md §3; CLI.md §3.1).
//
// The browser extension resolves these through browser.runtime.getURL against
// the packaged extension root — the default here when no resolver is injected.
// Non-browser surfaces (the CLI, and the SEA binary) have no runtime.getURL, so
// they inject their own resolver with setAssetResolver() BEFORE the engines
// load — mapping each browser-flat asset name (e.g. "standard_fonts/") to a
// file:// URL pdf.js can fetch. Keeping the seam here (no node:* imports) means
// this module bundles cleanly into the browser build; the Node resolver lives in
// the Node-only src/cli/node-assets.js.

import { browser } from "../browser.js";

let resolver = null;

// Install a surface-specific resolver: (relPath: string) => string (a URL).
// Call before importing any engine module, since inbrowser.js resolves its
// asset URLs at module load.
export function setAssetResolver(fn) {
  resolver = fn;
}

export function getAssetUrl(relPath) {
  if (resolver) return resolver(relPath);
  if (browser?.runtime?.getURL) return browser.runtime.getURL(relPath);
  throw new Error(
    `[decant] no asset resolver for "${relPath}" — a non-browser surface must ` +
      `call setAssetResolver() before loading the converter engines`
  );
}
