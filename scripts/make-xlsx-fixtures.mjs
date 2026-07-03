// Dev tool: regenerate the committed .xlsx test fixtures in test/fixtures/.
// SheetJS writes them itself — no extra dependency.
//
//   node scripts/make-xlsx-fixtures.mjs
//
// Fixtures:
//   tiny.xlsx   — two sheets: a small table (with a pipe and a newline in
//                 cells, exercising escaping) and a second single-column one
//   empty.xlsx  — one sheet, no cells (the no-text passthrough path)
//   chart.xlsx  — a sheet plus an injected chart part (xl/charts) whose cached
//                 data is recovered into a table (Tier 1)
//
// SheetJS can't write charts, so the chart fixture is a normal SheetJS
// workbook re-opened with jszip to inject the chart part.

import { writeFile, mkdir } from "node:fs/promises";
import * as XLSXNs from "xlsx";
import JSZipNs from "jszip";

const XLSX = XLSXNs.default ?? XLSXNs;
const JSZip = JSZipNs.default ?? JSZipNs;

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

{
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([["Month", "Sales"], ["Jan", 10], ["Feb", 12]]),
    "Data"
  );
  const zip = await JSZip.loadAsync(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
  zip.file(
    "xl/charts/chart1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Sales</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart>
      <c:ser>
        <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Sales</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Jan</c:v></c:pt><c:pt idx="1"><c:v>Feb</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>12</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>
    </c:barChart></c:plotArea>
  </c:chart>
</c:chartSpace>`
  );
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile("test/fixtures/chart.xlsx", buf);
  console.log(`test/fixtures/chart.xlsx  (${buf.length} bytes)`);
}
