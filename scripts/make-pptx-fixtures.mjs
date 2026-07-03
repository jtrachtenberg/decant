// Dev tool: regenerate the committed .pptx test fixtures in test/fixtures/.
// Hand-built minimal OOXML via jszip (a direct dependency).
//
//   node scripts/make-pptx-fixtures.mjs
//
// Fixtures:
//   tiny.pptx   — slide 1: title + leveled bullets (with an entity);
//                 slide 2: bullets + a small table. Text-only → convert.
//   image.pptx  — one slide with text and a p:pic → the ambiguous path.
//   empty.pptx  — one slide with no text runs → passthrough.
//   chart.pptx  — slide referencing a chart part (via .rels) whose cached
//                 series data is recovered into a table → convert (Tier 1).

import { writeFile, mkdir } from "node:fs/promises";
import JSZipNs from "jszip";

const JSZip = JSZipNs.default ?? JSZipNs;

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`;

const PRESENTATION = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

// The chart namespace is declared like real producers do (on every slide,
// chart or not) — regression cover for the namespace-vs-usage distinction in
// the engine's chart counter.
const slide = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">
  <p:cSld><p:spTree>${body}</p:spTree></p:cSld>
</p:sld>`;

const titleShape = (text) => `
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>
      <p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:txBody></p:sp>`;

const bodyShape = (paras) => `
    <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr>
      <p:txBody>${paras}</p:txBody></p:sp>`;

const SLIDE1 = slide(
  titleShape("Quarterly Review") +
    bodyShape(`
      <a:p><a:r><a:t>Revenue up 12%</a:t></a:r></a:p>
      <a:p><a:pPr lvl="1"/><a:r><a:t>Driven by R&amp;D team</a:t></a:r></a:p>
      <a:p><a:r><a:t>Split </a:t></a:r><a:r><a:t>runs join</a:t></a:r></a:p>`)
);

const SLIDE2 = slide(
  bodyShape(`<a:p><a:r><a:t>Headcount</a:t></a:r></a:p>`) + `
    <p:graphicFrame><a:tbl>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Team</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Size</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
      <a:tr><a:tc><a:txBody><a:p><a:r><a:t>Eng</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>14</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
    </a:tbl></p:graphicFrame>`
);

const IMAGE_SLIDE = slide(
  titleShape("Architecture") +
    bodyShape(`<a:p><a:r><a:t>See diagram</a:t></a:r></a:p>`) +
    `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Picture 2" descr="system diagram"/></p:nvPicPr><p:blipFill><a:blip r:embed="rId9"/></p:blipFill></p:pic>`
);

const EMPTY_SLIDE = slide(bodyShape(`<a:p/>`));

// A chart graphicFrame references its data part by r:id (resolved via the
// slide's .rels). Two series over three shared categories, plus a title.
const CHART_SLIDE = slide(
  titleShape("Sales") +
    `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="5" name="Chart 1"/></p:nvGraphicFramePr>
      <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart r:id="rId2"/></a:graphicData></a:graphic></p:graphicFrame>`
);

const SLIDE1_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart1.xml"/>
</Relationships>`;

const ser = (name, cats, vals) => `
        <c:ser>
          <c:tx><c:strRef><c:strCache><c:pt idx="0"><c:v>${name}</c:v></c:pt></c:strCache></c:strRef></c:tx>
          <c:cat><c:strRef><c:strCache><c:ptCount val="${cats.length}"/>${cats
    .map((c, i) => `<c:pt idx="${i}"><c:v>${c}</c:v></c:pt>`)
    .join("")}</c:strCache></c:strRef></c:cat>
          <c:val><c:numRef><c:numCache><c:ptCount val="${vals.length}"/>${vals
    .map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)
    .join("")}</c:numCache></c:numRef></c:val>
        </c:ser>`;

const CHART1 = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <c:chart>
    <c:title><c:tx><c:rich><a:p><a:r><a:t>Revenue by Quarter</a:t></a:r></a:p></c:rich></c:tx></c:title>
    <c:plotArea><c:barChart>
      ${ser("Revenue", ["Q1", "Q2", "Q3"], [10, 15, 23])}
      ${ser("Cost", ["Q1", "Q2", "Q3"], [5, 7, 9])}
    </c:barChart></c:plotArea>
  </c:chart>
</c:chartSpace>`;

async function makePptx(path, slides, extra = {}) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("ppt/presentation.xml", PRESENTATION);
  slides.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml));
  for (const [p, content] of Object.entries(extra)) zip.file(p, content);
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, buf);
  console.log(`${path}  (${buf.length} bytes)`);
}

await mkdir("test/fixtures", { recursive: true });
await makePptx("test/fixtures/tiny.pptx", [SLIDE1, SLIDE2]);
await makePptx("test/fixtures/image.pptx", [IMAGE_SLIDE]);
await makePptx("test/fixtures/empty.pptx", [EMPTY_SLIDE]);
await makePptx("test/fixtures/chart.pptx", [CHART_SLIDE], {
  "ppt/slides/_rels/slide1.xml.rels": SLIDE1_RELS,
  "ppt/charts/chart1.xml": CHART1,
});
