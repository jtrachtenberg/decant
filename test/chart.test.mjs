// Unit tests for the shared OOXML chart-data recovery (src/convert/chart.js):
// the pure parseChartXml, plus chartTablesFromZip against an in-memory zip.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import JSZipNs from "jszip";
import { parseChartXml, chartTablesFromZip } from "../src/convert/chart.js";

const JSZip = JSZipNs.default ?? JSZipNs;

const chartPart = (title, sers) => `<c:chartSpace xmlns:c="x" xmlns:a="y">
  <c:chart>${title ? `<c:title><c:tx><c:rich><a:p><a:r><a:t>${title}</a:t></a:r></a:p></c:rich></c:tx></c:title>` : ""}
  <c:plotArea><c:barChart>${sers}</c:barChart></c:plotArea></c:chart></c:chartSpace>`;

test("parseChartXml turns cached series into category × series rows", () => {
  const parsed = parseChartXml(
    chartPart(
      "My Chart",
      `<c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Rev</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
      <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Cost</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>`
    )
  );
  assert.equal(parsed.title, "My Chart");
  assert.deepEqual(parsed.rows, [
    ["Category", "Rev", "Cost"],
    ["Q1", "10", "3"],
    ["Q2", "20", "4"],
  ]);
});

test("parseChartXml handles sparse idx gaps and a series without a name", () => {
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser>
        <c:cat><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="2"><c:v>C</c:v></c:pt></c:strCache></c:cat>
        <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>9</c:v></c:pt></c:numCache></c:val>
      </c:ser>`
    )
  );
  assert.deepEqual(parsed.rows, [
    ["Category", "Series 1"],
    ["A", "1"],
    ["", ""], // idx 1 gap → empty row, preserved positionally
    ["C", "9"],
  ]);
});

test("parseChartXml decodes entities in names, categories, and values", () => {
  const parsed = parseChartXml(
    chartPart(
      "R&amp;D",
      `<c:ser><c:tx><c:v>A &amp; B</c:v></c:tx>
        <c:cat><c:strCache><c:pt idx="0"><c:v>x &lt; y</c:v></c:pt></c:strCache></c:cat>
        <c:val><c:numCache><c:pt idx="0"><c:v>5</c:v></c:pt></c:numCache></c:val></c:ser>`
    )
  );
  assert.equal(parsed.title, "R&D");
  assert.deepEqual(parsed.rows, [
    ["Category", "A & B"],
    ["x < y", "5"],
  ]);
});

test("parseChartXml returns null when there's no usable cached data", () => {
  assert.equal(parseChartXml("<c:chartSpace></c:chartSpace>"), null);
  assert.equal(parseChartXml("<c:chartSpace><c:ser></c:ser></c:chartSpace>"), null);
});

test("chartTablesFromZip enumerates chart parts in order, skips unparseable", async () => {
  const zip = new JSZip();
  const ser = (v) =>
    `<c:ser><c:val><c:numCache><c:pt idx="0"><c:v>${v}</c:v></c:pt></c:numCache></c:val></c:ser>`;
  zip.file("xl/charts/chart2.xml", chartPart("Second", ser(2)));
  zip.file("xl/charts/chart1.xml", chartPart("First", ser(1)));
  zip.file("xl/charts/chart10.xml", chartPart("Tenth", ser(10)));
  zip.file("xl/charts/colors1.xml", "<not a chart/>"); // ignored (not chartN)
  zip.file("xl/charts/chart3.xml", "<c:chartSpace/>"); // no data → skipped

  const tables = await chartTablesFromZip(zip, "xl/charts");
  assert.deepEqual(
    tables.map((t) => t.title),
    ["First", "Second", "Tenth"] // numeric order, chart3 skipped
  );
});
