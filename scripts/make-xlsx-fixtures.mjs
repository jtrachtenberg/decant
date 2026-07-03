// Dev tool: regenerate the committed .xlsx test fixtures in test/fixtures/.
// SheetJS writes them itself — no extra dependency.
//
//   node scripts/make-xlsx-fixtures.mjs
//
// Fixtures:
//   tiny.xlsx   — two sheets: a small table (with a pipe and a newline in
//                 cells, exercising escaping) and a second single-column one
//   empty.xlsx  — one sheet, no cells (the no-text passthrough path)

import { writeFile, mkdir } from "node:fs/promises";
import * as XLSXNs from "xlsx";

const XLSX = XLSXNs.default ?? XLSXNs;

await mkdir("test/fixtures", { recursive: true });

{
  const wb = XLSX.utils.book_new();
  const budget = XLSX.utils.aoa_to_sheet([
    ["Region", "Q1", "Q2", "Notes"],
    ["North", 100, 150, "on|track"],
    ["South", 80, 90, "supply\nissue"],
    ["", "", "", ""], // trailing empty row — must be trimmed
  ]);
  XLSX.utils.book_append_sheet(wb, budget, "Budget");
  const list = XLSX.utils.aoa_to_sheet([["Item"], ["alpha"], ["beta"]]);
  XLSX.utils.book_append_sheet(wb, list, "List");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await writeFile("test/fixtures/tiny.xlsx", buf);
  console.log(`test/fixtures/tiny.xlsx  (${buf.length} bytes)`);
}

{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[]]), "Empty");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  await writeFile("test/fixtures/empty.xlsx", buf);
  console.log(`test/fixtures/empty.xlsx  (${buf.length} bytes)`);
}
