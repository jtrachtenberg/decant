// Dev tool: regenerate the committed .docx test fixtures in test/fixtures/.
// Uses jszip, which is already present as mammoth's own dependency — this
// script is dev-time only and never ships.
//
//   node scripts/make-docx-fixtures.mjs
//
// Fixtures:
//   tiny.docx   — Heading1 + a paragraph with bold text (the happy path)
//   empty.docx  — a body with no text at all (the no-text passthrough path)

import { writeFile, mkdir } from "node:fs/promises";
import JSZip from "jszip";

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const document = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>${body}</w:body>
</w:document>`;

const TINY_BODY = `
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Decant fixture</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Plain paragraph with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> text.</w:t></w:r></w:p>`;

async function makeDocx(path, body) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/document.xml", document(body));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, buf);
  console.log(`${path}  (${buf.length} bytes)`);
}

await mkdir("test/fixtures", { recursive: true });
await makeDocx("test/fixtures/tiny.docx", TINY_BODY);
await makeDocx("test/fixtures/empty.docx", "<w:p/>");
