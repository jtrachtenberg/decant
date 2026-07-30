// Unit tests for right-to-left reading order and non-Latin code points
// (Arabic/Hebrew line reversal, presentation-form normalization). Synthetic
// glyph items, no PDFs.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconstructLines,
  linesToText,
  normalizeCompatText,
  unmirrorNeutralEdges,
} from "../src/convert/classify.js";

// Build a pdf.js-style text item. y is page coordinate (larger = higher).
function item(str, x, y, { w = str.length * 5, h = 10 } = {}) {
  return { str, width: w, height: h, transform: [h, 0, 0, h, x, y] };
}

// Lay a right-to-left line out the way a PDF producer does: the first word of
// the sentence sits at the RIGHT edge, each following word further left.
function rtlLine(words, y, { right = 400, gap = 8, h = 10 } = {}) {
  const items = [];
  let x = right;
  for (const word of words) {
    const w = word.length * 5;
    x -= w;
    items.push(item(word, x, y, { w, h }));
    x -= gap;
  }
  return items;
}

test("normalizeCompatText maps presentation forms to their base letters", () => {
  // Arabic Presentation Forms-B (what a PDF's ToUnicode map yields for shaped
  // glyphs) decompose back to the letters an Arabic reader would type: the
  // initial and medial forms of lam both map to plain lam.
  assert.equal(normalizeCompatText("ﻟﻠﺎ"), "للا");
  // Kangxi Radicals stand in for the ideographs they are identical to.
  assert.equal(normalizeCompatText("⼀"), "一"); // ⼀ -> 一
});

test("normalizeCompatText leaves ordinary text and meaningful compat forms alone", () => {
  const plain = "Plain ASCII, 25°C, 3.14";
  assert.equal(normalizeCompatText(plain), plain);
  // NFKC would flatten these; the targeted ranges must not reach them.
  assert.equal(normalizeCompatText("m²"), "m²");
  assert.equal(normalizeCompatText("½"), "½");
  assert.equal(normalizeCompatText("ｆｕｌｌ"), "ｆｕｌｌ");
});

test("unmirrorNeutralEdges moves bidi-mirrored punctuation back", () => {
  assert.equal(unmirrorNeutralEdges("12%+"), "+12%"); // sign mirrored to the far edge
  assert.equal(unmirrorNeutralEdges(".PDF"), "PDF."); // sentence period
  assert.equal(unmirrorNeutralEdges(")PDF("), "(PDF)"); // brackets, already mirrored glyphs
  assert.equal(unmirrorNeutralEdges("1,240"), "1,240"); // no edge neutrals
  assert.equal(unmirrorNeutralEdges("12%"), "12%"); // "%" binds to its number
  assert.equal(unmirrorNeutralEdges("..."), "..."); // nothing to anchor a swap to
});

test("a Hebrew line reads right-to-left", () => {
  const lines = reconstructLines(rtlLine(["זוהי", "פסקה", "בעברית"], 100));
  assert.equal(linesToText(lines), "זוהי פסקה בעברית");
});

test("an Arabic line reads right-to-left glyph by glyph", () => {
  // Producers emit one item per glyph; assembled left-to-right the word came
  // out spelled backwards.
  const glyphs = rtlLine([..."مرحبا"], 100, { gap: 0 });
  const lines = reconstructLines(glyphs);
  assert.equal(linesToText(lines), "مرحبا");
});

test("an embedded English term and number survive the reversal intact", () => {
  const lines = reconstructLines(
    rtlLine(["مثل", "Markdown", "ورقم", "1234"], 100)
  );
  assert.equal(linesToText(lines), "مثل Markdown ورقم 1234");
});

test("a per-glyph number inside a right-to-left line is not reversed", () => {
  // A number is laid out left-to-right even in an Arabic line, so its glyphs
  // run the opposite way to the words around it.
  const digits = [..."1,240"].map((ch, i) => item(ch, 200 + i * 5, 100, { w: 5 }));
  const lines = reconstructLines([...rtlLine(["القاهرة"], 100), ...digits]);
  assert.equal(linesToText(lines), "القاهرة 1,240");
});

test("a right-to-left table row keeps its columns in reading order", () => {
  // Region (rightmost), sales, percentage — column gaps wide enough to split.
  const lines = reconstructLines([
    ...rtlLine(["القاهرة"], 100, { right: 400 }),
    ...rtlLine(["1,240"], 100, { right: 300 }),
    ...rtlLine(["12%+"], 100, { right: 200 }),
  ]);
  assert.deepEqual(
    lines[0].cells.map((c) => c.text),
    ["القاهرة", "1,240", "+12%"]
  );
  assert.equal(lines[0].rtl, true);
});

test("a combining mark does not split the word it sits on", () => {
  // The mark has no advance, so the glyph after it measures its gap from the
  // base letter underneath — wide enough to read as a word space.
  const lines = reconstructLines([
    item("ا", 300, 100, { w: 5 }),
    item("ً", 305, 100, { w: 0 }), // fathatan, drawn over the letter
    item("ظ", 305, 100, { w: 5 }),
  ]);
  assert.equal(linesToText(lines).includes(" "), false);
});

test("a Latin line is untouched by the right-to-left path", () => {
  const lines = reconstructLines([
    item("Hello", 0, 100),
    item("world", 60, 100),
    item("+12%", 200, 100),
  ]);
  assert.equal(linesToText(lines), "Hello world +12%");
  assert.equal(lines[0].rtl, undefined);
});

test("one Arabic word inside an English sentence keeps the line left-to-right", () => {
  const lines = reconstructLines([
    item("The word", 0, 100),
    item("سلام", 60, 100),
    item("means peace", 100, 100),
  ]);
  assert.equal(linesToText(lines), "The word سلام means peace");
});
