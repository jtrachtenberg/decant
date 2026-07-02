// Unit tests for the DOCX engine (src/convert/docx.js): pure decision logic
// plus the real mammoth conversion against the committed fixtures
// (regenerate with scripts/make-docx-fixtures.mjs).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeDocx,
  docxAnalysis,
  stripDataUriImages,
} from "../src/convert/docx.js";

const fixture = async (name) => {
  const buf = await readFile(new URL(`./fixtures/${name}`, import.meta.url));
  return new File([buf], name, {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
};

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("stripDataUriImages removes and counts inline images", () => {
  const { markdown, images } = stripDataUriImages(
    `Before\n\n![](${PNG_URI})\n\n![chart](${PNG_URI})\n\nAfter`
  );
  assert.equal(images, 2);
  assert.equal(markdown, "Before\n\nAfter");
});

test("stripDataUriImages leaves ordinary links and images alone", () => {
  const md = "See ![alt](https://example.com/x.png) and [a link](https://example.com).";
  const { markdown, images } = stripDataUriImages(md);
  assert.equal(images, 0);
  assert.equal(markdown, md);
});

test("text-only markdown → convert", () => {
  const res = docxAnalysis("# Title\n\nBody.");
  assert.equal(res.decision, "convert");
  assert.equal(res.reason, "text");
  assert.equal(res.markdown, "# Title\n\nBody.\n");
});

test("text with images → ambiguous, markdown carries the stripped text", () => {
  const res = docxAnalysis(`# Title\n\n![](${PNG_URI})\n\nBody.`);
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-images");
  assert.equal(res.summary.images, 1);
  assert.equal(res.markdown, "# Title\n\nBody.\n");
});

test("images with no text → passthrough (never attach an empty file)", () => {
  const res = docxAnalysis(`![](${PNG_URI})`);
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});

test("bookmark anchors are stripped", () => {
  const res = docxAnalysis('<a id="_3rsulcktou25"></a>The title\n\nBody.');
  assert.equal(res.markdown, "The title\n\nBody.\n");
});

test("mammoth's punctuation escapes are removed where safe", () => {
  const res = docxAnalysis("Normal text\\. Bold\\! Sure\\, why not\\?");
  assert.equal(res.markdown, "Normal text. Bold! Sure, why not?\n");
});

test("a period escaped after leading digits stays escaped (list guard)", () => {
  const res = docxAnalysis("1\\. not a list\n\nSee item 2\\. it follows");
  // Line-leading "1\." keeps its escape; the mid-line "2\." is unescaped.
  assert.equal(res.markdown, "1\\. not a list\n\nSee item 2. it follows\n");
});

test("whitespace inside emphasis markers moves outside (CommonMark closes the span)", () => {
  assert.equal(
    docxAnalysis("*‘tab *Zawarkand and __student work __folder").markdown,
    "*‘tab* Zawarkand and __student work__ folder\n"
  );
  assert.equal(
    docxAnalysis("leading __ bold__ span").markdown,
    "leading  __bold__ span\n"
  );
  // No whitespace inside → untouched, including link labels.
  assert.equal(
    docxAnalysis("[__http://x.y__](http://x.y)").markdown,
    "[__http://x.y__](http://x.y)\n"
  );
});

test("emphasis pairing: bold label directly followed by a bold link label", () => {
  assert.equal(
    docxAnalysis("__FOLDER: __[__http://x.y__](http://x.y)").markdown,
    "__FOLDER:__ [__http://x.y__](http://x.y)\n"
  );
});

test("emphasis pairing never merges two separate spans", () => {
  const md = "__a__ x __b__ and *i* y *j*";
  assert.equal(docxAnalysis(md).markdown, md + "\n");
});

test("unpaired and empty delimiters are left verbatim", () => {
  assert.equal(docxAnalysis("odd __one__ out __here").markdown, "odd __one__ out __here\n");
  assert.equal(docxAnalysis("keep __ __ as is").markdown, "keep __ __ as is\n");
});

test("hyphens and parens unescape mid-line; line-leading hyphen stays (bullet guard)", () => {
  const res = docxAnalysis(
    "917\\-620\\-3998 \\(mobile\\)\n\n\\- dash paragraph, not a bullet"
  );
  assert.equal(
    res.markdown,
    "917-620-3998 (mobile)\n\n\\- dash paragraph, not a bullet\n"
  );
});

test("tiny.docx: Title→h1, heading, bold, no anchors or escapes (real mammoth)", async () => {
  const res = await analyzeDocx(await fixture("tiny.docx"));
  assert.equal(res.decision, "convert");
  assert.match(res.markdown, /^# Fixture title\./); // Title style + unescaped "."
  assert.match(res.markdown, /# Decant fixture/); // Heading1 via default map
  assert.match(res.markdown, /__bold__ text!/);
  // URLs survive intact as real Markdown links, punctuation unescaped.
  assert.match(
    res.markdown,
    /Mon 11a-12:30p \(online\): \[class folder\]\(http:\/\/example\.com\/class\?x=1\)/
  );
  assert.doesNotMatch(res.markdown, /<a id=/);
  assert.doesNotMatch(res.markdown, /\\[.!()-]/);
  // Bold run with trailing space: the space belongs outside the markers.
  assert.match(res.markdown, /__Note:__ bring an oud\./);
});

test("empty.docx passes through with no-text (real mammoth)", async () => {
  const res = await analyzeDocx(await fixture("empty.docx"));
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});
