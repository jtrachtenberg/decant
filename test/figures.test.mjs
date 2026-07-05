// Unit tests for the extract-and-reference module (src/convert/figures.js).
// Fixtures are synthetic zips built in-memory with JSZip — extractFigures
// reads media entries straight out of the upload's zip, so a constructed
// package exercises exactly the production path without binary fixtures.

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZipNs from "jszip";
import {
  extractFigures,
  figuresSupported,
  MIN_FIGURE_BYTES,
  MAX_FIGURES,
} from "../src/convert/figures.js";

const JSZip = JSZipNs.default ?? JSZipNs;

// A payload comfortably over the junk-filter floor.
const big = (fill) => new Uint8Array(MIN_FIGURE_BYTES + 100).fill(fill);

async function zipFile(name, entries) {
  const zip = new JSZip();
  for (const [path, bytes] of Object.entries(entries)) zip.file(path, bytes);
  const buf = await zip.generateAsync({ type: "uint8array" });
  return new File([buf], name, { type: "application/zip" });
}

test("figuresSupported gates by extension", () => {
  assert.equal(figuresSupported(new File([], "deck.pptx")), true);
  assert.equal(figuresSupported(new File([], "Report.DOCX")), true); // case-insensitive
  assert.equal(figuresSupported(new File([], "paper.pdf")), false);
  assert.equal(figuresSupported(new File([], "book.xlsx")), false);
  assert.equal(figuresSupported(null), false);
});

test("extracts pptx media as Files named after the upload", async () => {
  const file = await zipFile("q3 deck.pptx", {
    "ppt/media/image1.png": big(1),
    "ppt/media/image2.jpeg": big(2),
  });
  const figs = await extractFigures(file);
  assert.equal(figs.length, 2);
  assert.deepEqual(
    figs.map((f) => [f.name, f.type]),
    [
      ["q3 deck-fig1.png", "image/png"],
      ["q3 deck-fig2.jpeg", "image/jpeg"],
    ]
  );
});

test("docx media root is word/media", async () => {
  const file = await zipFile("memo.docx", {
    "word/media/image1.png": big(1),
    "ppt/media/image9.png": big(9), // wrong root for a docx — ignored
  });
  const figs = await extractFigures(file);
  assert.deepEqual(figs.map((f) => f.name), ["memo-fig1.png"]);
});

test("media order is numeric, not lexical (image10 after image2)", async () => {
  const file = await zipFile("deck.pptx", {
    "ppt/media/image10.png": big(10),
    "ppt/media/image2.png": big(2),
    "ppt/media/image1.png": big(1),
  });
  const figs = await extractFigures(file);
  const firstBytes = await Promise.all(
    figs.map(async (f) => new Uint8Array(await f.arrayBuffer())[0])
  );
  assert.deepEqual(firstBytes, [1, 2, 10]);
});

test("junk filter drops sub-threshold media; vector metafiles are skipped", async () => {
  const file = await zipFile("deck.pptx", {
    "ppt/media/image1.png": new Uint8Array(64), // logo-sized — junk
    "ppt/media/image2.emf": big(2), // vector metafile — chat surfaces reject
    "ppt/media/image3.png": big(3),
  });
  const figs = await extractFigures(file);
  assert.deepEqual(figs.map((f) => f.name), ["deck-fig1.png"]);
});

test("attachment cap keeps the first MAX_FIGURES in document order", async () => {
  const entries = {};
  for (let i = 1; i <= MAX_FIGURES + 3; i++) {
    entries[`ppt/media/image${i}.png`] = big(i);
  }
  const figs = await extractFigures(await zipFile("deck.pptx", entries));
  assert.equal(figs.length, MAX_FIGURES);
  const firstBytes = new Uint8Array(await figs[0].arrayBuffer())[0];
  assert.equal(firstBytes, 1); // capped from the front, not the back
});

test("unsupported types and empty packages resolve to []", async () => {
  assert.deepEqual(await extractFigures(new File(["x"], "paper.pdf")), []);
  const empty = await zipFile("deck.pptx", { "ppt/slides/slide1.xml": "<a/>" });
  assert.deepEqual(await extractFigures(empty), []);
});
