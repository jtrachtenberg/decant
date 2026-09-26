// Unit tests for the PPTX engine (src/convert/pptx.js): the pure slide-XML
// extractor plus real zip parsing against the committed fixtures
// (regenerate with scripts/make-pptx-fixtures.mjs).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import JSZipNs from "jszip";
import { analyzePptx, extractSlideText } from "../src/convert/pptx.js";

const JSZip = JSZipNs.default ?? JSZipNs;

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

// --- B7 / B8: SmartArt, other graphic frames, presentation order ------------

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const slideXml = (body, attrs = "") =>
  `<p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r"${attrs}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
const titled = (t) => sp(`<a:p><a:r><a:t>${t}</a:t></a:r></a:p>`, `<p:ph type="title"/>`);

async function deck({ slides, order, rels = {}, parts = {} }) {
  const z = new JSZip();
  const ids = order ?? Object.keys(slides);
  z.file(
    "ppt/presentation.xml",
    `<p:presentation xmlns:p="p" xmlns:r="r"><p:sldIdLst>${ids
      .map((n, k) => `<p:sldId id="${256 + k}" r:id="rIdS${n}"/>`)
      .join("")}</p:sldIdLst></p:presentation>`
  );
  z.file(
    "ppt/_rels/presentation.xml.rels",
    `<Relationships>${Object.keys(slides)
      .map((n) => `<Relationship Id="rIdS${n}" Type="${REL}/slide" Target="slides/slide${n}.xml"/>`)
      .join("")}</Relationships>`
  );
  for (const [n, xml] of Object.entries(slides)) z.file(`ppt/slides/slide${n}.xml`, xml);
  for (const [n, xml] of Object.entries(rels)) z.file(`ppt/slides/_rels/slide${n}.xml.rels`, xml);
  for (const [p, xml] of Object.entries(parts)) z.file(p, xml);
  return new File([await z.generateAsync({ type: "uint8array" })], "deck.pptx");
}

test("SmartArt text is recovered from the diagram data part (B7)", async () => {
  const frame = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Diagram 3"/></p:nvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
    <dgm:relIds xmlns:dgm="d" r:dm="rId2" r:lo="rId3" r:qs="rId4" r:cs="rId5"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const file = await deck({
    slides: { 1: slideXml(titled("Process") + frame) },
    rels: { 1: `<Relationships><Relationship Id="rId2" Target="../diagrams/data1.xml"/></Relationships>` },
    parts: {
      "ppt/diagrams/data1.xml": `<dgm:dataModel xmlns:dgm="d" xmlns:a="a"><dgm:ptLst>
        <dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>Plan</a:t></a:r></a:p></dgm:t></dgm:pt>
        <dgm:pt modelId="2"><dgm:t><a:p><a:r><a:t>Build</a:t></a:r></a:p></dgm:t></dgm:pt>
        <dgm:pt modelId="3"><dgm:t><a:p><a:r><a:t>Ship</a:t></a:r></a:p></dgm:t></dgm:pt>
      </dgm:ptLst></dgm:dataModel>`,
    },
  });
  const res = await analyzePptx(file);
  assert.equal(res.decision, "convert");
  assert.match(res.markdown, /- Plan\n- Build\n- Ship/);
});

test("an unresolvable SmartArt or an OLE object is marked and prompts (B7)", async () => {
  const dgm = `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">
    <dgm:relIds xmlns:dgm="d" r:dm="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`;
  const ole = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Worksheet Object"/></p:nvGraphicFramePr>
    <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/presentationml/2006/ole"><p:oleObj/></a:graphicData></a:graphic></p:graphicFrame>`;
  const res = await analyzePptx(await deck({ slides: { 1: slideXml(titled("Numbers") + dgm + ole) } }));
  assert.equal(res.decision, "ambiguous");
  assert.match(res.markdown, /\[diagram omitted\]/);
  assert.match(res.markdown, /\[object omitted: Worksheet Object\]/);
});

test("slides follow the presentation's sldIdLst, not part filenames (B8)", async () => {
  const res = await analyzePptx(
    await deck({
      slides: { 1: slideXml(titled("Second")), 2: slideXml(titled("First")) },
      order: [2, 1],
    })
  );
  assert.match(res.markdown, /## Slide 1: First[\s\S]*## Slide 2: Second/);
});

test("a hidden slide is labelled, not presented as a normal slide (B8)", async () => {
  const res = await analyzePptx(
    await deck({
      slides: { 1: slideXml(titled("Visible")), 2: slideXml(titled("Backup"), ' show="0"') },
    })
  );
  assert.match(res.markdown, /## Slide 1: Visible/);
  assert.match(res.markdown, /## Slide 2 \(hidden\): Backup/);
});
