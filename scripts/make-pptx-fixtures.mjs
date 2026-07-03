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

async function makePptx(path, slides) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("ppt/presentation.xml", PRESENTATION);
  slides.forEach((xml, i) => zip.file(`ppt/slides/slide${i + 1}.xml`, xml));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, buf);
  console.log(`${path}  (${buf.length} bytes)`);
}

await mkdir("test/fixtures", { recursive: true });
await makePptx("test/fixtures/tiny.pptx", [SLIDE1, SLIDE2]);
await makePptx("test/fixtures/image.pptx", [IMAGE_SLIDE]);
await makePptx("test/fixtures/empty.pptx", [EMPTY_SLIDE]);
