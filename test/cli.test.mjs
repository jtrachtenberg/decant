// CLI surface / headless-parity tests (CLI.md). Three layers:
//   1. The shared convertFile() runs under Node — the whole point of the §3
//      de-browserifying seams. Exercises the real engines, not a stub.
//   2. The forced modes (--mode markdown | figures) — decantCC generates each
//      variant in its own pass (CLI.md §4).
//   3. The `decant` binary's contract: stdout payload and the scriptable exit
//      codes decantCC branches on.
//
//   node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZipNs from "jszip";

const JSZip = JSZipNs.default ?? JSZipNs;
const fixture = (rel) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli/decant.mjs", import.meta.url));

const fileOf = async (rel, type) =>
  new File([await readFile(fixture(rel))], rel.split("/").pop(), { type });

// A minimal .pptx with one text slide AND a real embedded media part (≥ the 4KB
// junk filter) — the fixtures reference images without embedding the bytes, so
// figure extraction needs its own. Written to a temp file for the binary tests.
async function makePptxWithImage() {
  const z = new JSZip();
  z.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>`);
  z.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  z.file("ppt/presentation.xml", `<?xml version="1.0"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`);
  z.file("ppt/slides/slide1.xml", `<?xml version="1.0"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Quarterly Review</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`);
  // A PNG signature + padding to clear MIN_FIGURE_BYTES; extractFigures gates on
  // extension + size, not pixel validity.
  z.file("ppt/media/image1.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(5000, 7)]));
  return z.generateAsync({ type: "nodebuffer" });
}

// --- Layer 1: convertFile() headless over the real engines -----------------

test("convertFile runs under Node via the asset seam (PDF → Markdown)", async () => {
  const { installNodeAssets } = await import("../src/cli/node-assets.js");
  installNodeAssets();
  const { convertFile } = await import("../src/convert/index.js");

  const res = await convertFile(
    await fileOf("tables/two_col_table.pdf", "application/pdf")
  );
  assert.equal(res.action, "converted");
  assert.equal(res.reason, "text");
  const md = await res.file.text();
  assert.match(md, /Reason for exclusion/); // real table extraction, not a stub
  assert.equal(res.file.name, "two_col_table.md");
});

test("the worker asset resolves to a file:// URL, dir assets to plain paths", async () => {
  // pdf.js loads the worker with ESM import(), which on Windows rejects a bare
  // "C:\…" path (read as scheme "c:") — it must be a file:// URL. The font/WASM
  // dirs, by contrast, are read via fs and must stay plain paths (Node fetch has
  // no file:// scheme). Regression guard for the "fake worker failed" bug.
  const { installNodeAssets } = await import("../src/cli/node-assets.js");
  const { getAssetUrl } = await import("../src/convert/assets.js");
  installNodeAssets();
  assert.match(getAssetUrl("pdf.worker.mjs"), /^file:\/\//);
  assert.doesNotMatch(getAssetUrl("standard_fonts/"), /^file:/);
});

test("convertFile passes an empty document through", async () => {
  const { installNodeAssets } = await import("../src/cli/node-assets.js");
  installNodeAssets();
  const { convertFile } = await import("../src/convert/index.js");

  const res = await convertFile(
    await fileOf(
      "empty.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
  );
  assert.equal(res.action, "passthrough");
});

// --- Layer 2: forced modes -------------------------------------------------

test("assembleFigures pulls a PPTX's embedded media as a sibling file", async () => {
  const { installNodeAssets } = await import("../src/cli/node-assets.js");
  installNodeAssets();
  const { assembleFigures } = await import("../src/cli/figures.js");
  const { engineFor } = await import("../src/convert/index.js");

  const file = new File([await makePptxWithImage()], "deck.pptx", {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
  const analysis = await engineFor(file)(file);
  const { files, note } = await assembleFigures(file, analysis.summary);
  assert.equal(files.length, 1);
  assert.equal(files[0].name, "deck-fig1.png");
  assert.match(note, /attached as separate files/);
});

// --- Layer 3: the binary's stdout + exit-code contract ---------------------

const run = (...args) =>
  spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });

test("convert emits Markdown to stdout and exits 0", () => {
  const r = run("convert", fixture("tables/two_col_table.pdf"), "--quiet");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Reason for exclusion/);
});

test("passthrough exits 10 with clean stdout", () => {
  const r = run("convert", fixture("empty.docx"), "--quiet");
  assert.equal(r.status, 10);
  assert.equal(r.stdout, "");
});

test("--mode markdown forces text-only conversion (exit 0)", () => {
  const r = run("convert", fixture("tables/two_col_table.pdf"), "--mode", "markdown", "--quiet");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Reason for exclusion/);
});

test("--mode figures writes Markdown + figure files to --out-dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "decant-cli-"));
  const pptx = join(dir, "deck.pptx");
  await writeFile(pptx, await makePptxWithImage());

  const out = join(dir, "out");
  const r = run("convert", pptx, "--mode", "figures", "--out-dir", out, "--quiet");
  assert.equal(r.status, 0);

  const written = (await readdir(out)).sort();
  assert.deepEqual(written, ["deck-fig1.png", "deck.md"]);
  const md = await readFile(join(out, "deck.md"), "utf8");
  assert.match(md, /attached as separate files/); // association note appended
});

test("a permission-restricted PDF converts as text in both modes", async () => {
  // pdf.js decrypts a restricted (owner-encrypted, empty user password) PDF for
  // text; pdf-lib refuses encrypted input, so --mode figures must DEGRADE to
  // text-only rather than crash with exit 2. --mode markdown is pdf.js-only and
  // should just work.
  const md = run("convert", fixture("encrypted.pdf"), "--mode", "markdown", "--quiet");
  assert.equal(md.status, 0);
  assert.match(md.stdout, /Reason for exclusion/);

  const dir = await mkdtemp(join(tmpdir(), "decant-enc-"));
  const out = join(dir, "out");
  const fig = run("convert", fixture("encrypted.pdf"), "--mode", "figures", "--out-dir", out, "--quiet");
  assert.equal(fig.status, 0); // degraded, not crashed
  const written = await readdir(out);
  assert.ok(written.includes("encrypted.md"));
  assert.ok(!written.some((f) => f.endsWith(".pdf"))); // no silently-corrupt charts PDF
});

test("--mode figures requires --out-dir (usage error, exit 1)", () => {
  const r = run("convert", fixture("tiny.pptx"), "--mode", "figures");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires --out-dir/);
});

test("--json emits the envelope with decision + savings", () => {
  const r = run("convert", fixture("tables/two_col_table.pdf"), "--json", "--quiet");
  assert.equal(r.status, 0);
  const env = JSON.parse(r.stdout);
  assert.equal(env.action, "converted");
  assert.equal(env.reason, "text");
  assert.ok(env.markdown.includes("Reason for exclusion"));
  assert.ok(env.savings && env.savings.originalTokens > 0);
  assert.equal(env.meta.pageCount, 2);
});

test("--mode companion is deferred (usage error, exit 1)", () => {
  const r = run("convert", fixture("tiny.pptx"), "--mode", "companion");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not implemented/);
});

test("a missing input is a conversion error (exit 2)", () => {
  const r = run("convert", "/no/such/file.pdf");
  assert.equal(r.status, 2);
});

test("an unknown command is a usage error (exit 1)", () => {
  const r = run("frobnicate");
  assert.equal(r.status, 1);
});
