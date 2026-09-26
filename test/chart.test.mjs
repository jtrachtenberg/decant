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

test("parseChartXml bounds a hostile idx instead of allocating from it", () => {
  // A crafted part with a huge idx must not force a multi-GB dense array (which
  // would crash the tab before the passthrough catch can run). The parse should
  // return quickly with the in-range point kept and the out-of-range one dropped.
  const t0 = Date.now();
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser>
        <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="99999999"><c:v>9</c:v></c:pt></c:numCache></c:val>
      </c:ser>`
    )
  );
  assert.ok(Date.now() - t0 < 2000, "parse must not hang on a hostile idx");
  assert.equal(parsed.rows[0].length, 2); // Category + one series
  assert.equal(parsed.rows[1][1], "1"); // in-range point survives
  assert.ok(parsed.rows.length <= 100_001); // capped, not ~100M rows
});

test("parseChartXml survives an out-of-range numeric entity", () => {
  // fromCodePoint throws above 0x10FFFF; a malformed entity must not abort the
  // whole conversion — the raw text is kept.
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser>
        <c:cat><c:strCache><c:pt idx="0"><c:v>bad &#x110000; here</c:v></c:pt></c:strCache></c:cat>
        <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:val>
      </c:ser>`
    )
  );
  assert.equal(parsed.rows[1][0], "bad &#x110000; here");
});

test("parseChartXml returns null when there's no usable cached data", () => {
  assert.equal(parseChartXml("<c:chartSpace></c:chartSpace>"), null);
  assert.equal(parseChartXml("<c:chartSpace><c:ser></c:ser></c:chartSpace>"), null);
});

test("chartTablesFromZip isolates a part whose read throws (M2)", async () => {
  // A corrupt deflate stream rejects on read; one bad part must not abort the
  // whole recovery and discard an otherwise-good conversion.
  const ser = (v) =>
    `<c:ser><c:val><c:numCache><c:pt idx="0"><c:v>${v}</c:v></c:pt></c:numCache></c:val></c:ser>`;
  const mockZip = {
    files: { "xl/charts/chart1.xml": {}, "xl/charts/chart2.xml": {} },
    file(p) {
      return {
        async: async () => {
          if (p.endsWith("chart1.xml")) throw new Error("corrupt deflate stream");
          return chartPart("Second", ser(2));
        },
      };
    },
  };
  const tables = await chartTablesFromZip(mockZip, "xl/charts");
  assert.deepEqual(tables.map((t) => t.title), ["Second"]); // chart1 skipped, not fatal
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

test("a point with no <c:v> is a gap, not the next point's value (B10)", () => {
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser><c:val><c:numCache>
        <c:pt idx="0"></c:pt><c:pt idx="1"/><c:pt idx="2"><c:v>7</c:v></c:pt>
      </c:numCache></c:val></c:ser>`
    )
  );
  assert.deepEqual(parsed.rows.map((r) => r[1]), ["Series 1", "", "", "7"]);
});

test("percent and date format codes are applied to cached values (B10)", () => {
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser>
        <c:cat><c:numRef><c:numCache><c:formatCode>mmm\\-yy</c:formatCode>
          <c:pt idx="0"><c:v>44927</c:v></c:pt><c:pt idx="1"><c:v>44958</c:v></c:pt></c:numCache></c:numRef></c:cat>
        <c:val><c:numRef><c:numCache><c:formatCode>0.0%</c:formatCode>
          <c:pt idx="0"><c:v>0.25</c:v></c:pt><c:pt idx="1"><c:v>0.1234</c:v></c:pt></c:numCache></c:numRef></c:val>
      </c:ser>`
    )
  );
  assert.deepEqual(parsed.rows.slice(1), [
    ["2023-01-01", "25.0%"],
    ["2023-02-01", "12.3%"],
  ]);
});

test("a 1904-dated chart uses the 1904 epoch (B10)", () => {
  const parsed = parseChartXml(
    `<c:chartSpace><c:date1904 val="1"/>` +
      chartPart(
        "",
        `<c:ser><c:cat><c:numCache><c:formatCode>yyyy-mm-dd</c:formatCode><c:pt idx="0"><c:v>0</c:v></c:pt></c:numCache></c:cat>
          <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:val></c:ser>`
      ) +
      `</c:chartSpace>`
  );
  assert.equal(parsed.rows[1][0], "1904-01-01");
});

test("multi-level categories join their levels instead of overwriting (B10)", () => {
  const parsed = parseChartXml(
    chartPart(
      "",
      `<c:ser>
        <c:cat><c:multiLvlStrRef><c:multiLvlStrCache><c:ptCount val="4"/>
          <c:lvl><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt><c:pt idx="2"><c:v>Q1</c:v></c:pt><c:pt idx="3"><c:v>Q2</c:v></c:pt></c:lvl>
          <c:lvl><c:pt idx="0"><c:v>2023</c:v></c:pt><c:pt idx="2"><c:v>2024</c:v></c:pt></c:lvl>
        </c:multiLvlStrCache></c:multiLvlStrRef></c:cat>
        <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt><c:pt idx="2"><c:v>3</c:v></c:pt><c:pt idx="3"><c:v>4</c:v></c:pt></c:numCache></c:val>
      </c:ser>`
    )
  );
  assert.deepEqual(parsed.rows.map((r) => r[0]), ["Category", "2023 / Q1", "2023 / Q2", "2024 / Q1", "2024 / Q2"]);
});

test("scatter series are recovered as (x, y) pairs (B6)", () => {
  const parsed = parseChartXml(
    `<c:chartSpace><c:chart><c:plotArea><c:scatterChart>
      <c:ser><c:tx><c:v>Trials</c:v></c:tx>
        <c:xVal><c:numRef><c:numCache><c:pt idx="0"><c:v>1.5</c:v></c:pt><c:pt idx="1"><c:v>2.5</c:v></c:pt></c:numCache></c:numRef></c:xVal>
        <c:yVal><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:yVal>
      </c:ser></c:scatterChart></c:plotArea></c:chart></c:chartSpace>`
  );
  assert.deepEqual(parsed.rows, [
    ["Series", "X", "Y"],
    ["Trials", "1.5", "10"],
    ["Trials", "2.5", "20"],
  ]);
});

test("chartPartsFromZip counts chartEx and data-less parts as omitted (B6)", async () => {
  const { chartPartsFromZip } = await import("../src/convert/chart.js");
  const zip = new JSZip();
  const ser = `<c:ser><c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:val></c:ser>`;
  zip.file("word/charts/chart1.xml", chartPart("Kept", ser));
  zip.file("word/charts/chart2.xml", "<c:chartSpace/>");
  zip.file("word/charts/chartEx1.xml", "<cx:chartSpace/>");
  const { tables, omitted } = await chartPartsFromZip(zip, "word/charts");
  assert.deepEqual(tables.map((t) => t.title), ["Kept"]);
  assert.equal(omitted, 2);
});
