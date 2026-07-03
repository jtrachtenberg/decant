// Unit tests for the PPTX engine (src/convert/pptx.js): the pure slide-XML
// extractor plus real zip parsing against the committed fixtures
// (regenerate with scripts/make-pptx-fixtures.mjs).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzePptx,
  extractSlideText,
  parseChartXml,
} from "../src/convert/pptx.js";

const fixture = async (name) => {
  const buf = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  });
};

const sp = (inner, ph = "") =>
  `<p:sp><p:nvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:txBody>${inner}</p:txBody></p:sp>`;

test("extractSlideText lifts the title and levels bullets", () => {
  const xml =
    sp(`<a:p><a:r><a:t>My Title</a:t></a:r></a:p>`, `<p:ph type="title"/>`) +
    sp(`<a:p><a:r><a:t>top</a:t></a:r></a:p><a:p><a:pPr lvl="2"/><a:r><a:t>deep</a:t></a:r></a:p>`);
  const s = extractSlideText(xml);
  assert.equal(s.title, "My Title");
  assert.deepEqual(s.bullets, [
    { level: 0, text: "top" },
    { level: 2, text: "deep" },
  ]);
});

test("extractSlideText joins split runs and decodes entities", () => {
  const s = extractSlideText(sp(`<a:p><a:r><a:t>R&amp;D </a:t></a:r><a:r><a:t>&#x2192; growth</a:t></a:r></a:p>`));
  assert.deepEqual(s.bullets, [{ level: 0, text: "R&D → growth" }]);
});

test("pictures count as visuals; charts are captured as references", () => {
  const s = extractSlideText(
    sp(`<a:p><a:r><a:t>x</a:t></a:r></a:p>`) +
      `<p:pic><p:blipFill/></p:pic>` +
      `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId7"/></a:graphicData></a:graphic></p:graphicFrame>`
  );
  assert.equal(s.images, 1); // the picture only
  assert.deepEqual(s.chartRefs, ["rId7"]); // the chart, resolved later
});

test("a chart namespace declaration alone is neither a visual nor a ref", () => {
  // Producers declare xmlns:c on every slide whether or not a chart exists.
  const s = extractSlideText(
    `<p:sld xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
      sp(`<a:p><a:r><a:t>text only</a:t></a:r></a:p>`) +
      `</p:sld>`
  );
  assert.equal(s.images, 0);
  assert.deepEqual(s.chartRefs, []);
});

test("extractSlideText pulls tables out without duplicating their text", () => {
  const s = extractSlideText(
    `<a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>H</a:t></a:r></a:p></a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody><a:p><a:r><a:t>v</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>`
  );
  assert.deepEqual(s.tables, [[["H"], ["v"]]]);
  assert.equal(s.bullets.length, 0);
});

test("tiny.pptx converts: slide headings, bullets, table (real zip)", async () => {
  const res = await analyzePptx(await fixture("tiny.pptx"));
  assert.equal(res.decision, "convert");
  assert.equal(res.summary.slides, 2);
  assert.match(res.markdown, /^## Slide 1: Quarterly Review$/m);
  assert.match(res.markdown, /^- Revenue up 12%$/m);
  assert.match(res.markdown, /^ {2}- Driven by R&D team$/m);
  assert.match(res.markdown, /^- Split runs join$/m);
  assert.match(res.markdown, /^## Slide 2$/m);
  assert.match(res.markdown, /\| Team \| Size \|/);
  assert.match(res.markdown, /\| Eng \| 14 \|/);
});

test("image.pptx → ambiguous with a visible omission marker (real zip)", async () => {
  const res = await analyzePptx(await fixture("image.pptx"));
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-images");
  assert.equal(res.summary.images, 1);
  assert.match(res.markdown, /## Slide 1: Architecture/);
  assert.match(res.markdown, /^\[image omitted: system diagram\]$/m);
});

test("omission markers carry the picture's name/descr when present", () => {
  const s = extractSlideText(
    `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 2" descr="Q3 funnel"/></p:nvPicPr></p:pic>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="5" name="Picture 3"/></p:nvPicPr></p:pic>` +
      `<p:pic></p:pic>`
  );
  assert.deepEqual(s.omitted, [
    "[image omitted: Q3 funnel]",
    "[image omitted: Picture 3]",
    "[image omitted]",
  ]);
});

test("parseChartXml turns cached series into category × series rows", () => {
  const chart = `<c:chartSpace xmlns:c="x" xmlns:a="y">
    <c:chart><c:title><c:tx><c:rich><a:p><a:r><a:t>My </a:t></a:r><a:r><a:t>Chart</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart>
      <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Rev</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:cat><c:strRef><c:strCache><c:pt idx="0"><c:v>Q1</c:v></c:pt><c:pt idx="1"><c:v>Q2</c:v></c:pt></c:strCache></c:strRef></c:cat>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
      <c:ser><c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>Cost</c:v></c:pt></c:strCache></c:strRef></c:tx>
        <c:val><c:numRef><c:numCache><c:pt idx="0"><c:v>3</c:v></c:pt><c:pt idx="1"><c:v>4</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser>
    </c:barChart></c:plotArea></c:chart></c:chartSpace>`;
  const parsed = parseChartXml(chart);
  assert.equal(parsed.title, "My Chart");
  assert.deepEqual(parsed.rows, [
    ["Category", "Rev", "Cost"],
    ["Q1", "10", "3"],
    ["Q2", "20", "4"],
  ]);
});

test("parseChartXml handles sparse idx gaps and a series without a name", () => {
  const chart = `<c:chartSpace>
    <c:ser>
      <c:cat><c:strCache><c:pt idx="0"><c:v>A</c:v></c:pt><c:pt idx="2"><c:v>C</c:v></c:pt></c:strCache></c:cat>
      <c:val><c:numCache><c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="2"><c:v>9</c:v></c:pt></c:numCache></c:val>
    </c:ser></c:chartSpace>`;
  const parsed = parseChartXml(chart);
  assert.deepEqual(parsed.rows, [
    ["Category", "Series 1"],
    ["A", "1"],
    ["", ""], // idx 1 gap → empty row, preserved positionally
    ["C", "9"],
  ]);
});

test("parseChartXml returns null when there's no usable cached data", () => {
  assert.equal(parseChartXml("<c:chartSpace></c:chartSpace>"), null);
  assert.equal(parseChartXml("<c:chartSpace><c:ser></c:ser></c:chartSpace>"), null);
});

test("chart.pptx recovers the cached chart data as a table → convert (real zip)", async () => {
  const res = await analyzePptx(await fixture("chart.pptx"));
  assert.equal(res.decision, "convert"); // nothing lost → no prompt
  assert.equal(res.summary.images, 0);
  assert.equal(res.summary.chartsRecovered, 1);
  assert.match(res.markdown, /## Slide 1: Sales/);
  assert.match(res.markdown, /\*\*Revenue by Quarter\*\*/);
  assert.match(res.markdown, /\| Category \| Revenue \| Cost \|/);
  assert.match(res.markdown, /\| Q3 \| 23 \| 9 \|/);
  assert.doesNotMatch(res.markdown, /chart omitted/);
});

test("empty and whitespace-only descr/name fall through to generic markers", () => {
  const s = extractSlideText(
    `<p:pic><p:nvPicPr><p:cNvPr id="1" name="" descr=""/></p:nvPicPr></p:pic>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="2" name="  " descr="   "/></p:nvPicPr></p:pic>` +
      `<p:pic><p:nvPicPr><p:cNvPr id="3" name="Picture 9" descr=" "/></p:nvPicPr></p:pic>`
  );
  assert.deepEqual(s.omitted, [
    "[image omitted]",
    "[image omitted]",
    "[image omitted: Picture 9]", // blank descr falls back to the real name
  ]);
});

test("empty.pptx passes through with no-text (real zip)", async () => {
  const res = await analyzePptx(await fixture("empty.pptx"));
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});
