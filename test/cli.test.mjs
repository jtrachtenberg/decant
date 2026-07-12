// CLI surface / headless-parity tests (CLI.md, C0). Two layers:
//   1. The shared convertFile() runs under Node — the whole point of the §3
//      de-browserifying seams. Exercises the real engines, not a stub.
//   2. The `decant` binary's contract: stdout payload and the scriptable exit
//      codes decantCC branches on.
//
//   node --test

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fixture = (rel) => fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli/decant.mjs", import.meta.url));

const fileOf = async (rel, type) =>
  new File([await readFile(fixture(rel))], rel.split("/").pop(), { type });

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

// --- Layer 2: the binary's stdout + exit-code contract ---------------------

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

test("unimplemented forced modes fail with exit 1 (C1)", () => {
  const r = run("convert", fixture("tiny.pptx"), "--mode", "figures");
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
