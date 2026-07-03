// In-browser XLSX/XLS engine (shape A) — SheetJS parses the workbook, each
// sheet becomes a Markdown table under a per-sheet heading. Spreadsheets sit
// on the parsing side of the parsing-vs-recognition line (zipped XML / BIFF),
// so like DOCX there's no classifier pass — the judgment calls are:
//
//   - Empty workbook (no cells anywhere) → passthrough, never attach an
//     empty file.
//   - Very large sheets → passthrough with reason "too-large": a Markdown
//     table of a 100k-cell workbook costs more tokens than it saves, which
//     is exactly backwards. The cap is generous for human-scale sheets.
//   - Embedded charts/images: the community SheetJS build doesn't parse
//     drawings, so they can't be detected — a known fidelity limitation
//     (unlike PDFs/DOCX there's no "ambiguous" prompt). Noted in README.
//
// analyzeXlsx() returns the same { decision, reason, summary, markdown }
// shape as analyzePdf/analyzeDocx, so resultFromAnalysis() wraps all three.

import * as XLSXNs from "xlsx";

const XLSX = XLSXNs.default ?? XLSXNs;

// Above this many populated cells the workbook passes through unconverted.
export const MAX_CELLS = 50_000;

// Render one sheet's rows (array-of-arrays, as from sheet_to_json with
// header:1) to a Markdown table. Pure — exported for direct unit testing.
// The first row is treated as the header row, matching the overwhelmingly
// common spreadsheet layout.
export function rowsToMarkdownTable(rows) {
  // Drop fully-empty trailing rows and columns — sheets are often padded.
  const cell = (v) =>
    String(v ?? "")
      .replace(/\r?\n/g, " ")
      .replace(/\|/g, "\\|")
      .trim();
  const grid = rows.map((r) => (Array.isArray(r) ? r.map(cell) : []));
  while (grid.length && grid[grid.length - 1].every((c) => !c)) grid.pop();
  let width = Math.max(0, ...grid.map((r) => r.length));
  while (width > 0 && grid.every((r) => !(r[width - 1] || "").length)) width--;
  if (!grid.length || width === 0) return "";

  const row = (cells) => {
    const out = [];
    for (let i = 0; i < width; i++) out.push(cells[i] || "");
    return `| ${out.join(" | ")} |`;
  };
  const lines = [row(grid[0]), `| ${Array(width).fill("---").join(" | ")} |`];
  for (let i = 1; i < grid.length; i++) lines.push(row(grid[i]));
  return lines.join("\n");
}

export async function analyzeXlsx(file) {
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });

  const sections = [];
  let cellCount = 0;
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: false, // formatted strings, so dates/currency read as displayed
      defval: "",
      blankrows: false,
    });
    cellCount += rows.reduce(
      (n, r) => n + r.filter((v) => String(v ?? "").trim()).length,
      0
    );
    const table = rowsToMarkdownTable(rows);
    if (table) sections.push({ name, table });
  }

  const summary = { sheets: wb.SheetNames.length, tables: sections.length, cellCount };
  if (!sections.length) {
    return { decision: "passthrough", reason: "no-text", summary, markdown: null };
  }
  if (cellCount > MAX_CELLS) {
    return { decision: "passthrough", reason: "too-large", summary, markdown: null };
  }

  // A single-sheet workbook doesn't need the sheet heading; multi-sheet
  // workbooks get one section per sheet.
  const markdown =
    sections.length === 1
      ? sections[0].table + "\n"
      : sections.map((s) => `## Sheet: ${s.name}\n\n${s.table}`).join("\n\n") + "\n";

  return { decision: "convert", reason: "table", summary, markdown };
}
