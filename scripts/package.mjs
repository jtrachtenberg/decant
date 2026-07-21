// Decant packaging — zips a built extension into a store-upload artifact.
//
//   node scripts/package.mjs            dist/         → release/decant-<version>-chrome.zip
//   node scripts/package.mjs --firefox  dist-firefox/ → release/decant-<version>-firefox.zip
//
// Run via `npm run package` / `npm run package:firefox`, which chain the
// matching build first so a zip can never carry stale bundles.
//
// Stores expect manifest.json at the ZIP ROOT. Zipping the build directory
// itself nests everything one level down and gets the upload rejected, so
// entries are added at paths relative to the build dir, not including it.

import JSZip from "jszip";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

const firefox = process.argv.includes("--firefox");
const buildDir = firefox ? "dist-firefox" : "dist";
const target = firefox ? "firefox" : "chrome";
const outDir = "release";

// The built manifest, not the source one: the Firefox build derives its
// manifest in build.mjs, so the artifact's own version is the honest label.
let version;
try {
  ({ version } = JSON.parse(await readFile(join(buildDir, "manifest.json"), "utf8")));
} catch {
  console.error(
    `No ${buildDir}/manifest.json — run \`npm run build${firefox ? ":firefox" : ""}\` first.`
  );
  process.exit(1);
}

// Plain recursive walk rather than readdir's recursive option, whose Dirent
// shape has shifted across Node versions.
async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

const zip = new JSZip();
let count = 0;
for await (const file of walk(buildDir)) {
  // Zip entries are always forward-slashed, including on Windows.
  const name = relative(buildDir, file).split(/[\\/]/).join("/");
  zip.file(name, await readFile(file));
  count++;
}

const buffer = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 },
});

await mkdir(outDir, { recursive: true });
const outPath = join(outDir, `decant-${version}-${target}.zip`);
await writeFile(outPath, buffer);

const mb = (buffer.length / 1024 / 1024).toFixed(1);
console.log(`packaged ${count} files → ${outPath} (${mb} MB)`);
