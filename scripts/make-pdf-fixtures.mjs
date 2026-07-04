// Dev tool: regenerate the committed PDF test fixtures in test/fixtures/tables/.
// Writes minimal, hand-assembled PDFs (no writer dependency) whose text is
// positioned with explicit text matrices, so pdf.js reads back the same glyph
// geometry the real converter sees. Dev-time only; never ships.
//
//   node scripts/make-pdf-fixtures.mjs
//
// Fixtures:
//   two_col_table.pdf — page 1 is a 2-column long-text table (Indicator |
//     Reason for exclusion) whose right cells wrap to two lines, mirroring the
//     WHO SDG-3 "indicators not included" table that regressed to column-major
//     prose. Page 2 is clean 2-column prose that must STAY prose. Together they
//     are the row-correspondence discriminator's true-positive + true-negative.

import { writeFile, mkdir } from "node:fs/promises";

// Escape the three characters that are special inside a PDF literal string.
function esc(t) {
  return t.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

// A page's text as a content stream: each fragment gets its own text matrix, so
// its pdf.js transform is [size, 0, 0, size, x, y] (origin bottom-left).
function contentStream(items) {
  let s = "";
  for (const it of items) {
    const size = it.size || 10;
    s += `BT /F1 ${size} Tf 1 0 0 1 ${it.x} ${it.y} Tm (${esc(it.text)}) Tj ET\n`;
  }
  return s;
}

// Assemble a valid single-font PDF from an array of pages (each an array of
// { x, y, text, size } placements). Object layout: 1 catalog, 2 page tree, then
// one Page per page, then one Contents stream per page, then the shared font.
function buildPdf(pages) {
  const nPages = pages.length;
  const fontNum = 3 + 2 * nPages;
  const objs = new Map();
  objs.set(1, `<< /Type /Catalog /Pages 2 0 R >>`);
  const kids = pages.map((_, i) => `${3 + i} 0 R`).join(" ");
  objs.set(2, `<< /Type /Pages /Kids [${kids}] /Count ${nPages} >>`);
  for (let p = 1; p <= nPages; p++) {
    const contentNum = 2 + nPages + p;
    objs.set(
      2 + p,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`
    );
    const stream = contentStream(pages[p - 1]);
    objs.set(
      contentNum,
      `<< /Length ${stream.length} >>\nstream\n${stream}endstream`
    );
  }
  objs.set(fontNum, `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let n = 1; n <= fontNum; n++) {
    offsets[n] = Buffer.byteLength(pdf, "latin1");
    pdf += `${n} 0 obj\n${objs.get(n)}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${fontNum + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= fontNum; n++) {
    pdf += String(offsets[n]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${fontNum + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// --- Page 1: 2-column long-text table --------------------------------------
// Left column x=72 (short-to-medium indicator), right column x=320 (long reason
// wrapped to two lines). Each row's two cells share a top; rows are separated by
// a clear vertical gap so both columns segment into matching blocks.
const LEFT_X = 72;
const RIGHT_X = 320;
const ROWS = [
  [
    "3.1.1 Maternal mortality ratio",
    ["Target set at the global level; progress not", "assessed at the regional level"],
  ],
  [
    "3.2.1 Under-five mortality rate",
    ["Country-level reporting incomplete for the", "current reporting cycle"],
  ],
  [
    "3.3.1 New HIV infections per 1000",
    ["Insufficient disaggregated data to assess", "regional progress reliably"],
  ],
  [
    "3.4.1 Cardiovascular disease mortality",
    ["Baseline not established for the assessment", "period under review"],
  ],
  [
    "3.5.2 Alcohol per capita consumption",
    ["Methodology under revision; values withheld", "pending validation"],
  ],
];

const tablePage = [
  { x: LEFT_X, y: 740, size: 13, text: "List of indicators not included in the assessment" },
  { x: LEFT_X, y: 710, text: "Indicator" },
  { x: RIGHT_X, y: 710, text: "Reason for exclusion" },
];
ROWS.forEach(([indicator, reason], i) => {
  const top = 680 - i * 44;
  tablePage.push({ x: LEFT_X, y: top, text: indicator });
  reason.forEach((line, k) => tablePage.push({ x: RIGHT_X, y: top - k * 12, text: line }));
});

// --- Page 2: clean 2-column prose (must stay prose) -------------------------
const prosePage = [];
for (let k = 0; k < 10; k++) {
  const y = 700 - k * 14;
  prosePage.push({ x: LEFT_X, y, text: `Left running prose line ${k} continues here` });
  prosePage.push({ x: RIGHT_X, y, text: `Right running prose line ${k} continues here` });
}

await mkdir("test/fixtures/tables", { recursive: true });
const pdf = buildPdf([tablePage, prosePage]);
await writeFile("test/fixtures/tables/two_col_table.pdf", pdf);
console.log(`test/fixtures/tables/two_col_table.pdf  (${pdf.length} bytes)`);
