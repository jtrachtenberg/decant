// Input-size ceilings (src/convert/limits.js — B4/S8, the July review's L15).
// A small zip/XML bomb used to OOM the tab; it must now pass through before
// any engine parses it, while ordinary packages and non-zip files are
// untouched.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZipNs from "jszip";
import {
  zipEntrySizes,
  sizeVerdict,
  MAX_INPUT_BYTES,
  MAX_MARKUP_BYTES,
  MAX_INFLATED_BYTES,
} from "../src/convert/limits.js";
import { installNodeAssets } from "../src/cli/node-assets.js";

// index.js pulls in the PDF engine, which resolves its assets at load.
installNodeAssets();
const { engineFor } = await import("../src/convert/index.js");

const JSZip = JSZipNs.default ?? JSZipNs;
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function zipFile(name, parts, type = DOCX) {
  const z = new JSZip();
  for (const [p, body] of Object.entries(parts)) z.file(p, body);
  const buf = await z.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return new File([buf], name, { type });
}

// A highly compressible document.xml just over the markup ceiling: a few
// hundred KB on disk.
const bombXml = () =>
  `<w:document><w:body>${"<w:p><w:r><w:t>x</w:t></w:r></w:p>".repeat(
    Math.ceil((MAX_MARKUP_BYTES + 1024) / 34)
  )}</w:body></w:document>`;

test("zipEntrySizes reads declared sizes from the central directory", async () => {
  const f = await zipFile("a.docx", { "word/document.xml": "<a/>".repeat(1000), "media/x.bin": "12345" });
  const { entries } = await zipEntrySizes(f);
  const byName = Object.fromEntries(entries.map((e) => [e.name, e.size]));
  assert.equal(byName["word/document.xml"], 4000);
  assert.equal(byName["media/x.bin"], 5);
});

test("a non-zip (legacy CFB .xls, plain text) has no directory to check", async () => {
  assert.equal(await zipEntrySizes(new File(["just text, no zip here"], "a.xls")), null);
  assert.equal(await sizeVerdict(new File(["x"], "a.xls"), "zip"), null);
});

test("prepended bytes before the archive are tolerated", async () => {
  const inner = await zipFile("a.docx", { "word/document.xml": "<a/>" });
  const f = new File([new Uint8Array(100), await inner.arrayBuffer()], "a.docx");
  const { entries } = await zipEntrySizes(f);
  assert.equal(entries.find((e) => e.name === "word/document.xml").size, 4);
});

test("a directory that claims to be a zip but doesn't parse is refused", async () => {
  // A bare EOCD record whose directory points past the file start.
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, 1, true);
  v.setUint16(10, 1, true);
  v.setUint32(12, 46, true);
  v.setUint32(16, 1000, true);
  const verdict = await sizeVerdict(new File([eocd], "a.docx"), "zip");
  assert.equal(verdict.decision, "passthrough");
  assert.equal(verdict.reason, "bad-zip");
});

test("an XML bomb DOCX passes through as too-large without being parsed (B4)", async () => {
  const f = await zipFile("bomb.docx", { "word/document.xml": bombXml() });
  assert.ok(f.size < 2 * 1024 * 1024, `bomb is ${f.size} bytes on disk`);
  const verdict = await sizeVerdict(f, "zip");
  assert.equal(verdict.reason, "too-large");
  assert.equal(verdict.summary.limit, "markup");

  // Through the real engine seam: no mammoth parse, a fast passthrough.
  const t0 = Date.now();
  const res = await engineFor(f)(f);
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "too-large");
  assert.ok(Date.now() - t0 < 2000);
});

test("media counts toward the inflated ceiling, not the markup one", async () => {
  // Fake a huge media entry by editing the declared size in the directory.
  const f = await zipFile("big.pptx", { "ppt/slides/slide1.xml": "<a/>", "ppt/media/v.bin": "x" });
  const buf = new Uint8Array(await f.arrayBuffer());
  const dv = new DataView(buf.buffer);
  // Find the media entry's central-directory header and inflate its size.
  for (let i = 0; i < buf.length - 4; i++) {
    if (dv.getUint32(i, true) === 0x02014b50) {
      const nameLen = dv.getUint16(i + 28, true);
      const name = new TextDecoder().decode(buf.subarray(i + 46, i + 46 + nameLen));
      if (name === "ppt/media/v.bin") dv.setUint32(i + 24, MAX_INFLATED_BYTES + 1, true);
    }
  }
  const verdict = await sizeVerdict(new File([buf], "big.pptx"), "zip");
  assert.equal(verdict.summary.limit, "inflated");
});

test("an ordinary package and small files pass every ceiling", async () => {
  const f = await zipFile("ok.docx", { "word/document.xml": "<w:document/>" });
  assert.equal(await sizeVerdict(f, "zip"), null);
  assert.equal(await sizeVerdict(new File(["<p>hi</p>"], "a.html"), "markup"), null);
  assert.equal(await sizeVerdict(new File(["%PDF-1.7"], "a.pdf"), "raw"), null);
});

test("raw and markup ceilings use File.size only", async () => {
  // A File-like whose size is over the cap; its bytes are never read.
  const huge = { size: MAX_INPUT_BYTES + 1, name: "big.pdf", slice() { throw new Error("read"); } };
  assert.equal((await sizeVerdict(huge, "raw")).summary.limit, "input");
  const html = { size: MAX_MARKUP_BYTES + 1, name: "big.html", slice() { throw new Error("read"); } };
  assert.equal((await sizeVerdict(html, "markup")).summary.limit, "markup");
});

test("a legacy CFB .xls is never read as a zip, even with an EOCD-like tail", async () => {
  const bytes = new Uint8Array(64);
  bytes.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  new DataView(bytes.buffer).setUint32(64 - 22, 0x06054b50, true);
  assert.equal(await zipEntrySizes(new File([bytes], "old.xls")), null);
});
