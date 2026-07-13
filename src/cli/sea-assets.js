// SEA asset resolution for the packaged binary (CLI.md §7). A single-executable
// build has no node_modules, so the pdf.js runtime assets (worker, standard
// fonts, JPX/JBIG2/ICC WASM) can't be resolved off disk the way node-assets.js
// does. Instead the build embeds them all as ONE zip SEA asset ("assets.zip",
// browser-flat layout); at startup this unpacks it to a per-version temp dir and
// points the resolver there. pdf.js reads fonts/wasm from those paths via fs —
// Node's fetch has no file:// scheme (CLI.md §3.1), so plain paths are required.
//
// The unpack is cached by version: a second run reuses the extracted dir. JSZip
// is already bundled (the figures/xlsx engines depend on it), so no new dep.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import JSZipNs from "jszip";
import { setAssetResolver } from "../convert/assets.js";

const JSZip = JSZipNs.default ?? JSZipNs;

// pdf.js polyfills DOMMatrix/Path2D from @napi-rs/canvas when it detects Node,
// via createRequire(import.meta.url). In a SEA bundle that require is broken and
// the native canvas addon isn't present — but the CLI never rasterizes (text +
// the render-free figures tier only), so it needs these globals only to EXIST
// for pdf.js's module load. Provide a correct 2D-affine DOMMatrix (cheap
// insurance for any incidental geometry) and inert Path2D/OffscreenCanvas/
// ImageData; a canvas-requiring path (which the CLI never takes) would fail
// loudly rather than silently mis-render.
function installCanvasGlobals() {
  // pdf.js's Node block tries createRequire(import.meta.url) — undefined in the
  // bundle — and warns once at load. It's a dead path (we've set the globals
  // below), so drop just that benign line; every other warning passes through.
  const warn = console.warn;
  console.warn = (...a) => {
    const s = String(a[0] ?? "");
    if (s.includes("Cannot access the `require`") || s.includes("@napi-rs/canvas")) return;
    warn(...a);
  };
  if (!globalThis.DOMMatrix) globalThis.DOMMatrix = DOMMatrix2D;
  if (!globalThis.Path2D) globalThis.Path2D = class Path2D { addPath() {} };
  if (!globalThis.ImageData) {
    globalThis.ImageData = class ImageData {
      constructor(w, h) { this.width = w; this.height = h; }
    };
  }
  if (!globalThis.OffscreenCanvas) {
    globalThis.OffscreenCanvas = class OffscreenCanvas {
      constructor() { throw new Error("[decant] canvas rendering is unavailable in the CLI build"); }
    };
  }
}

// Minimal 2D affine matrix with the surface pdf.js uses (a–f, multiply, pre-
// multiply, translate, scale). Column-vector convention: p' = M·p.
class DOMMatrix2D {
  constructor(init) {
    if (Array.isArray(init) && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = init;
    } else {
      this.a = this.d = 1;
      this.b = this.c = this.e = this.f = 0;
    }
  }
  static #mul(m, n) {
    // m·n for two [a,b,c,d,e,f] affines.
    return [
      m.a * n.a + m.c * n.b,
      m.b * n.a + m.d * n.b,
      m.a * n.c + m.c * n.d,
      m.b * n.c + m.d * n.d,
      m.a * n.e + m.c * n.f + m.e,
      m.b * n.e + m.d * n.f + m.f,
    ];
  }
  #set(v) { [this.a, this.b, this.c, this.d, this.e, this.f] = v; return this; }
  multiplySelf(o) { return this.#set(DOMMatrix2D.#mul(this, o)); }
  preMultiplySelf(o) { return this.#set(DOMMatrix2D.#mul(o, this)); }
  translateSelf(tx = 0, ty = 0) { return this.#set(DOMMatrix2D.#mul(this, { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty })); }
  scaleSelf(sx = 1, sy = sx) { return this.#set(DOMMatrix2D.#mul(this, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })); }
  translate(tx, ty) { return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]).translateSelf(tx, ty); }
  scale(sx, sy) { return new DOMMatrix2D([this.a, this.b, this.c, this.d, this.e, this.f]).scaleSelf(sx, sy); }
}

export async function installSeaAssets(sea, version) {
  installCanvasGlobals();

  const dir = join(tmpdir(), `decant-assets-${version}`);
  const stamp = join(dir, ".ok");

  if (!existsSync(stamp)) {
    // sea.getAsset returns an ArrayBuffer of the embedded zip.
    const zip = await JSZip.loadAsync(sea.getAsset("assets.zip"));
    mkdirSync(dir, { recursive: true });
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const out = join(dir, entry.name);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, await entry.async("nodebuffer"));
    }
    writeFileSync(stamp, "");
  }

  // rel is browser-flat ("pdf.worker.mjs", "standard_fonts/", …). The worker is
  // loaded with ESM import(), which on Windows needs a file:// URL (a bare
  // "C:\…" path is rejected as scheme "c:"); the font/WASM dirs are read from
  // disk by pdf.js via fs, so they must stay plain paths (Node fetch has no
  // file:// scheme). pdf.js appends the filename to the dir assets, so keep
  // their trailing slash (join strips it).
  setAssetResolver((rel) => {
    if (rel === "pdf.worker.mjs") return pathToFileURL(join(dir, rel)).href;
    return rel.endsWith("/") ? join(dir, rel) + "/" : join(dir, rel);
  });
}
