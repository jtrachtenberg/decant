// Dev tool: regenerate the committed .docx test fixtures in test/fixtures/.
// Uses jszip, which is already present as mammoth's own dependency — this
// script is dev-time only and never ships.
//
//   node scripts/make-docx-fixtures.mjs
//
// Fixtures:
//   tiny.docx   — Title style (with a bookmark, the Google-Docs pattern),
//                 Heading1, and a paragraph with bold + punctuation — covers
//                 style mapping, anchor stripping, and unescaping
//   empty.docx  — a body with no text at all (the no-text passthrough path)

import { writeFile, mkdir } from "node:fs/promises";
import JSZip from "jszip";

const CT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

// mammoth resolves style *names* through styles.xml — without it a
// p[style-name='Title'] mapping can never match.
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="http://example.com/class?x=1" TargetMode="External"/>
</Relationships>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style>
</w:styles>`;

const document = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${body}</w:body>
</w:document>`;

const TINY_BODY = `
    <w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:bookmarkStart w:id="0" w:name="_fixture.anchor"/><w:bookmarkEnd w:id="0"/><w:r><w:t>Fixture title.</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Decant fixture</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Plain paragraph with </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:t xml:space="preserve"> text!</w:t></w:r></w:p>
    <w:p><w:r><w:t xml:space="preserve">Mon 11a-12:30p (online): </w:t></w:r><w:hyperlink r:id="rId2"><w:r><w:t>class folder</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Note: </w:t></w:r><w:r><w:t>bring an oud.</w:t></w:r></w:p>`;

async function makeDocx(path, body) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", CT);
  zip.file("_rels/.rels", RELS);
  zip.file("word/_rels/document.xml.rels", DOC_RELS);
  zip.file("word/styles.xml", STYLES);
  zip.file("word/document.xml", document(body));
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  await writeFile(path, buf);
  console.log(`${path}  (${buf.length} bytes)`);
}

await mkdir("test/fixtures", { recursive: true });
await makeDocx("test/fixtures/tiny.docx", TINY_BODY);
await makeDocx("test/fixtures/empty.docx", "<w:p/>");
