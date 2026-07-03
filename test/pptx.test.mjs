// Unit tests for the PPTX engine (src/convert/pptx.js): the pure slide-XML
// extractor plus real zip parsing against the committed fixtures
// (regenerate with scripts/make-pptx-fixtures.mjs).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { analyzePptx, extractSlideText } from "../src/convert/pptx.js";

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

test("extractSlideText counts pictures and charts as visuals", () => {
  const s = extractSlideText(
    sp(`<a:p><a:r><a:t>x</a:t></a:r></a:p>`) +
      `<p:pic><p:blipFill/></p:pic>` +
      `<p:graphicFrame><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></p:graphicFrame>`
  );
  assert.equal(s.images, 2);
});

test("a chart namespace declaration alone is not a visual (real-producer XML)", () => {
  // Producers declare xmlns:c on every slide whether or not a chart exists.
  const s = extractSlideText(
    `<p:sld xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart">` +
      sp(`<a:p><a:r><a:t>text only</a:t></a:r></a:p>`) +
      `</p:sld>`
  );
  assert.equal(s.images, 0);
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

test("image.pptx → ambiguous with the visuals count (real zip)", async () => {
  const res = await analyzePptx(await fixture("image.pptx"));
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-images");
  assert.equal(res.summary.images, 1);
  assert.match(res.markdown, /## Slide 1: Architecture/);
});

test("empty.pptx passes through with no-text (real zip)", async () => {
  const res = await analyzePptx(await fixture("empty.pptx"));
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});
