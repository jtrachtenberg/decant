// Dev tool: report a PDF's per-page composition and the conversion decision
// Decant would make for it. Read-only; never rasterizes. Uses the same
// classify.js logic the extension uses, so its verdict matches real behavior.
//
//   node scripts/inspect-pdf.mjs "<file.pdf>"
//   npm run inspect -- "<file.pdf>"
//
// Handy for calibrating thresholds and as a manual regression check against a
// corpus of tricky PDFs (clean text, scans, text-with-charts).

import { readFile } from "node:fs/promises";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  itemsToText,
  countChars,
  classifyDocument,
  IMAGE_OP_NAMES,
} from "../src/convert/classify.js";

const path = process.argv[2];
if (!path) {
  console.error('usage: node scripts/inspect-pdf.mjs "<file.pdf>"');
  process.exit(1);
}

const IMAGE_OPS = new Set(IMAGE_OP_NAMES.map((name) => pdfjs.OPS[name]));

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

const buf = await readFile(path);
const pdf = await pdfjs.getDocument({
  data: new Uint8Array(buf),
  verbosity: 0,
}).promise;

console.log(`\nFile:  ${path}`);
console.log(`Pages: ${pdf.numPages}\n`);
console.log(pad("pg", 5) + pad("chars", 9) + pad("images", 8) + "kind");
console.log("-".repeat(40));

const perPage = [];
for (let n = 1; n <= pdf.numPages; n++) {
  const page = await pdf.getPage(n);
  const text = itemsToText((await page.getTextContent()).items);
  const chars = countChars(text);

  let images = 0;
  try {
    const ops = await page.getOperatorList();
    for (const fn of ops.fnArray) if (IMAGE_OPS.has(fn)) images++;
  } catch {
    /* ignore */
  }

  perPage.push({ chars, images });
  const kind =
    chars < 50 ? (images ? "image/empty" : "empty") : images ? "text+image" : "text";
  console.log(pad(n, 5) + pad(chars, 9) + pad(images, 8) + kind);
}

console.log("-".repeat(40));
const { decision, reason, summary } = classifyDocument(perPage);
console.log(
  `\nSummary: ${summary.contentPages}/${summary.pageCount} text pages, ` +
    `${summary.chartPages} chart pages, ${summary.totalChars} chars, ` +
    `${summary.totalImages} images`
);
console.log(`Decision: ${decision.toUpperCase()} (${reason})\n`);
