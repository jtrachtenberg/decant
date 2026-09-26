// The PDF figure paths' document handling (src/convert/pdf-figures.js — B17/O8)
// under Node. Rendering and JPEG encoding need a browser canvas, so the
// raster-decode test swaps in an inert OffscreenCanvas: what's under test is
// the page walk — gating, the repeated-dimension rule, the per-object resolve
// — and that every path opens and tears down the document through withPdf.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { installNodeAssets } from "../src/cli/node-assets.js";

installNodeAssets();
const { analyzePdf } = await import("../src/convert/inbrowser.js");
const { extractPdfFigureBoxes, extractPdfRasterFigures } = await import(
  "../src/convert/pdf-figures.js"
);

function crc32(b) {
  let crc = 0xffffffff;
  for (let n = 0; n < b.length; n++) {
    let c = (crc ^ b[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// A noisy RGB PNG (noise keeps it from reading as a flat decoration).
function png(w, h, seed) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = (x * seed) & 255;
      raw[o + 1] = (y + seed) & 255;
      raw[o + 2] = ((x ^ y) + seed) & 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Three text pages, each with one large photo; `dims(p)` sizes page p's image.
async function photoPdf(dims) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < 3; p++) {
    const page = doc.addPage([612, 792]);
    const [w, h] = dims(p);
    page.drawImage(await doc.embedPng(png(w, h, p + 1)), { x: 72, y: 300, width: 468, height: 400 });
    for (let r = 0; r < 20; r++) {
      page.drawText(`Body text line ${r} on page ${p + 1} describing the figure above in detail.`, {
        x: 72, y: 280 - r * 12, size: 9, font,
      });
    }
  }
  return new File([await doc.save()], "photos.pdf", { type: "application/pdf" });
}

function withFakeCanvas(fn) {
  const saved = ["OffscreenCanvas", "ImageBitmap", "ImageData"].map((k) => [k, globalThis[k]]);
  globalThis.ImageBitmap = class {};
  globalThis.ImageData = class { constructor(d, w, h) { Object.assign(this, { data: d, width: w, height: h }); } };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return { fillRect() {}, drawImage() {}, putImageData() {}, set fillStyle(_) {} }; }
    async convertToBlob() { return new Blob([new Uint8Array([0xff, 0xd8, 0xff])]); }
  };
  return fn().finally(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete globalThis[k];
      else globalThis[k] = v;
    }
  });
}

test("raster decode keeps unique-size photos and encodes one page at a time (B17)", async () => {
  const file = await photoPdf((p) => [600 + p * 37, 500 + p * 23]);
  const { summary } = await analyzePdf(file);
  assert.deepEqual(summary.chartPageNumbers, [1, 2, 3]);
  const out = await withFakeCanvas(() => extractPdfRasterFigures(file, summary));
  assert.deepEqual([...out.keys()], [1, 2, 3]);
  for (const v of out.values()) {
    assert.ok(v.jpg instanceof Uint8Array);
    assert.equal(v.widthPt, 468);
    assert.equal(v.heightPt, 400);
  }
});

test("same-size images recurring across pages still fall to the crop path (G3b)", async () => {
  const file = await photoPdf(() => [600, 500]);
  const { summary } = await analyzePdf(file);
  const out = await withFakeCanvas(() => extractPdfRasterFigures(file, summary));
  assert.equal(out.size, 0);
});

test("render-free figure boxes run through the shared open/teardown (O8)", async () => {
  const file = await photoPdf((p) => [600 + p * 37, 500 + p * 23]);
  const { summary } = await analyzePdf(file);
  const boxes = await extractPdfFigureBoxes(file, summary);
  assert.ok(boxes.size >= 1);
  for (const b of boxes.values()) assert.ok(b.x1 > b.x0 && b.y1 > b.y0);
});
