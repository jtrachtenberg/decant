// The SEA binary's asset unpack (src/cli/sea-assets.js — S1/B14). The embedded
// pdf.js worker is import()ed from wherever the assets land, so they must land
// in a fresh, private directory — never a fixed shared path another local user
// could pre-plant — and a planted directory from an older layout is ignored.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZipNs from "jszip";

const JSZip = JSZipNs.default ?? JSZipNs;

test("assets unpack to a fresh 0700 dir; a planted legacy dir is never used", async () => {
  const base = await mkdtemp(join(tmpdir(), "decant-sea-test-"));
  // The old predictable location, pre-planted with a .ok stamp and a worker.
  const planted = join(base, "decant-assets-0.3.0");
  await mkdir(planted);
  await writeFile(join(planted, ".ok"), "");
  await writeFile(join(planted, "pdf.worker.mjs"), "planted");

  const zip = new JSZip();
  zip.file("pdf.worker.mjs", "genuine");
  zip.file("standard_fonts/FoxitSans.pfb", "font");
  const buf = await zip.generateAsync({ type: "arraybuffer" });

  // os.tmpdir() reads TMPDIR on POSIX and TEMP/TMP on Windows.
  const vars = ["TMPDIR", "TEMP", "TMP"];
  const prev = vars.map((v) => process.env[v]);
  for (const v of vars) process.env[v] = base;
  try {
    const { installSeaAssets } = await import("../src/cli/sea-assets.js");
    const { getAssetUrl } = await import("../src/convert/assets.js");
    await installSeaAssets({ getAsset: () => buf });

    const worker = fileURLToPath(getAssetUrl("pdf.worker.mjs"));
    const dir = dirname(worker);
    assert.notEqual(dir, planted);
    assert.equal(dirname(dir), base);
    assert.equal(await readFile(worker, "utf8"), "genuine");
    assert.equal(await readFile(join(getAssetUrl("standard_fonts/"), "FoxitSans.pfb"), "utf8"), "font");
    if (process.platform !== "win32") {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
  } finally {
    vars.forEach((v, i) => {
      if (prev[i] === undefined) delete process.env[v];
      else process.env[v] = prev[i];
    });
  }
});
