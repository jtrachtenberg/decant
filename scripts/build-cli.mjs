// Build the CLI as a single self-contained executable via Node SEA (CLI.md §7).
//
//   node scripts/build-cli.mjs                 → build/cli/decant  (this OS)
//   node scripts/build-cli.mjs --node node.exe --platform win --out decant.exe
//
// One recipe, every OS: bundle the CLI + engines to one file, embed the pdf.js
// assets as a zip, generate the SEA blob, then inject it into a copy of a Node
// binary with postject. Pass --node to inject into a DIFFERENT Node binary than
// the one running this script — that's how a Windows decant.exe is produced from
// any host: download the matching win-x64 node.exe and point --node at it.
//
// Steps that need the target's own tools (Authenticode signing for Windows,
// codesign for macOS) are out of scope here — the unsigned binary runs; signing
// is a packaging concern layered on top.

import * as esbuild from "esbuild";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  readFile,
  writeFile,
  mkdir,
  rm,
  copyFile,
  readdir,
  chmod,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import JSZipNs from "jszip";

const JSZip = JSZipNs.default ?? JSZipNs;
const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT_DIR = "build/cli";
// Which OS the target Node binary is for — decides the binary suffix and the
// postject macho flag. Defaults to the host running this script.
const platform = arg("--platform", process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux");
const nodeBin = arg("--node", process.execPath);
const outBin = arg("--out", join(OUT_DIR, platform === "win" ? "decant.exe" : "decant"));

const pdfjsDir = dirname(
  dirname(dirname(require.resolve("pdfjs-dist/legacy/build/pdf.mjs")))
);

// postject writes the blob at the Node binary's fuse sentinel. The canonical
// value is NODE_SEA_FUSE_fce680ab2cc2b0ff, but a given build can carry its own,
// so detect it from the target binary — keeps this correct whether injecting the
// host node or a downloaded win-x64 node.exe.
async function detectFuse(binPath) {
  const buf = await readFile(binPath);
  const m = buf.toString("latin1").match(/NODE_SEA_FUSE_[0-9a-f]+/);
  if (!m) {
    throw new Error(`no SEA fuse sentinel in ${binPath} — not a SEA-capable Node binary?`);
  }
  return m[0];
}

// pdf.js ships quickjs-eval.* (a JS interpreter for scripts embedded in PDF
// forms) in wasm/, but its only consumer is pdf.sandbox.mjs, which no surface
// bundles — so it is ~464 KB no build can reach. build.mjs drops it from the
// extension package for the same reason.
const UNREACHABLE_ASSET = /quickjs-eval\./;

async function addDir(zip, prefix, srcDir) {
  for (const name of await readdir(srcDir)) {
    if (UNREACHABLE_ASSET.test(name)) continue;
    zip.file(`${prefix}/${name}`, await readFile(join(srcDir, name)));
  }
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  // 1. Bundle the CLI + engines to one CJS file. platform:node resolves #pdfjs
  //    to the legacy build (the "node" condition) and keeps node: builtins —
  //    including node:sea — external.
  const bundle = join(OUT_DIR, "decant.cjs");
  await esbuild.build({
    entryPoints: ["src/cli/decant.mjs"],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    legalComments: "none",
    logLevel: "info",
  });

  // 2. Embed the pdf.js runtime assets as one zip (browser-flat layout, matching
  //    the names getAssetUrl resolves). Unpacked at startup by sea-assets.js.
  const zip = new JSZip();
  zip.file("pdf.worker.mjs", await readFile(join(pdfjsDir, "legacy", "build", "pdf.worker.mjs")));
  await addDir(zip, "standard_fonts", join(pdfjsDir, "standard_fonts"));
  await addDir(zip, "wasm", join(pdfjsDir, "wasm"));
  await addDir(zip, "iccs", join(pdfjsDir, "iccs"));
  const assetsZip = join(OUT_DIR, "assets.zip");
  await writeFile(assetsZip, await zip.generateAsync({ type: "nodebuffer" }));

  // 3. SEA config → 4. blob.
  const cfg = join(OUT_DIR, "sea-config.json");
  await writeFile(
    cfg,
    JSON.stringify(
      {
        main: bundle,
        output: join(OUT_DIR, "sea-prep.blob"),
        disableExperimentalSEAWarning: true,
        assets: { "assets.zip": assetsZip },
      },
      null,
      2
    )
  );
  execFileSync(process.execPath, ["--experimental-sea-config", cfg], { stdio: "inherit" });

  // 5. Copy the target Node binary and inject the blob at the fuse.
  await copyFile(nodeBin, outBin);
  const { inject } = require("postject");
  await inject(outBin, "NODE_SEA_BLOB", await readFile(join(OUT_DIR, "sea-prep.blob")), {
    sentinelFuse: await detectFuse(outBin),
    machoSegmentName: platform === "mac" ? "NODE_SEA" : undefined,
  });
  if (platform !== "win") await chmod(outBin, 0o755);

  console.log(`\nbuilt ${outBin} (${platform}) — bundle + ${Object.keys(zip.files).length} embedded assets`);
  if (nodeBin === process.execPath && platform !== (process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : "linux")) {
    console.log("note: --platform differs from the host but --node was not given; the host binary was used.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
