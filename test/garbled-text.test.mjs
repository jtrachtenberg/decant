// Unit tests for the undecodable-text-layer signal (classify.js:
// textLayerGarble) and the routing it drives.
//
// The failure it exists for: a map or chart drawn with a cartographic or
// symbol font, where the glyphs ARE the artwork. pdf.js maps every one of
// them to U+FFFD, so the page extracts as a wall of replacement characters
// that *counts as text* — it paints no raster and no colored fills, so every
// other figure signal reads zero and the page converts to gibberish while
// never reaching the figures flow. (USGS Deer Trail report, PDF page 28 =
// printed page 20 = Figure 2: 1,464 of 1,545 characters undecodable, with the
// real caption buried underneath.)
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  textLayerGarble,
  reconstructPage,
  linesToText,
  linesToMarkdown,
  classifyDocument,
  selectChartPages,
  GARBLED_TEXT_RATIO,
  GARBLED_MIN_CHARS,
  GARBLED_TOTAL_RATIO,
} from "../src/convert/classify.js";

// Built from code points rather than typed literally: these characters do not
// survive a round trip through every editor/terminal encoding, and a test for
// undecodable text that silently loses its undecodable text proves nothing.
const FFFD = String.fromCharCode(0xfffd); // pdf.js's "no character for this glyph"
const PUA = String.fromCharCode(0xe000); // mapped, but into the font's private range

// A pdf.js-shaped text item. Only str/transform/width/height are read.
const item = (str, x, y, width = str.length * 5) => ({
  str,
  transform: [10, 0, 0, 10, x, y],
  width,
  height: 10,
});

// --- the measurement -------------------------------------------------------

test("clean text scores zero garble", () => {
  const g = textLayerGarble([item("The quick brown fox jumps over it", 0, 700)]);
  assert.equal(g.ratio, 0);
  assert.equal(g.garbled, false);
  assert.equal(g.total, false);
});

test("a page of replacement characters is garbled and total", () => {
  const g = textLayerGarble([item(FFFD.repeat(200), 0, 700)]);
  assert.equal(g.ratio, 1);
  assert.equal(g.garbled, true);
  assert.equal(g.total, true);
});

test("private-use code points count as undecodable too", () => {
  // The glyph mapped, but only into a range whose meaning is the font's own
  // private business — no more readable than U+FFFD.
  const g = textLayerGarble([item(PUA.repeat(50), 0, 700)]);
  assert.equal(g.ratio, 1);
  assert.equal(g.garbled, true);
});

test("whitespace is excluded from the ratio (it survives a broken font map)", () => {
  // 60 undecodable glyphs interleaved with spaces: counting the spaces would
  // dilute a 100%-broken page to 50% and hide it under the threshold.
  const g = textLayerGarble([item(`${FFFD} `.repeat(60), 0, 700)]);
  assert.equal(g.chars, 60);
  assert.equal(g.ratio, 1);
});

test("a few dingbats in real prose do not condemn the page", () => {
  const prose = "Ordinary readable body text that carries the page's meaning.";
  const g = textLayerGarble([item(prose + FFFD + FFFD, 0, 700)]);
  assert.ok(g.ratio < GARBLED_TEXT_RATIO, `got ${g.ratio}`);
  assert.equal(g.garbled, false);
});

test("a short fragment is never judged (too little text for a verdict)", () => {
  const short = FFFD.repeat(GARBLED_MIN_CHARS - 1);
  assert.equal(textLayerGarble([item(short, 0, 700)]).garbled, false);
  // One more character and there is enough to judge.
  assert.equal(
    textLayerGarble([item(short + FFFD, 0, 700)]).garbled,
    true
  );
});

test("`total` separates no-fallback pages from partly-readable ones", () => {
  // 50% garbled: past the flow threshold, but half the text still reads, so
  // the page keeps a text fallback and stays subject to the attachment cap.
  const half = textLayerGarble([
    item(FFFD.repeat(100) + "a".repeat(100), 0, 700),
  ]);
  assert.equal(half.garbled, true);
  assert.equal(half.total, false);
  assert.ok(GARBLED_TOTAL_RATIO > GARBLED_TEXT_RATIO);
});

test("no text at all is not garbled (nothing to judge)", () => {
  const g = textLayerGarble([]);
  assert.equal(g.chars, 0);
  assert.equal(g.ratio, 0);
  assert.equal(g.garbled, false);
});

// --- reconstruction: strip the noise, keep the real text -------------------

test("undecodable runs are dropped and the surviving caption is kept", () => {
  // Deer Trail page 28 in miniature: a font-drawn map (undecodable) with a
  // handful of genuine labels and the figure caption sitting on top of it.
  const items = [
    item(FFFD.repeat(400), 60, 600),
    item("U.S. HIGHWAY 36", 60, 500),
    item("JOLLY ROAD", 60, 460),
    item("Figure 2 Metro Wastewater Reclamation District", 60, 100),
  ];
  const text = linesToText(reconstructPage(items).lines);
  assert.ok(!text.includes(FFFD), "replacement characters must not survive");
  assert.match(text, /U\.S\. HIGHWAY 36/);
  assert.match(text, /JOLLY ROAD/);
  assert.match(text, /Figure 2 Metro Wastewater Reclamation District/);
});

test("a garbled page carries a marker explaining the loss", () => {
  const items = [
    item(FFFD.repeat(400), 60, 600),
    item("Figure 2 Metro Wastewater", 60, 100),
  ];
  const md = linesToMarkdown(reconstructPage(items).lines, "20");
  assert.match(md, /could not be decoded/);
  // The marker promises an attachment; classification must honor that.
  assert.match(md, /attached figure/);
});

test("a clean page is untouched — no marker, no stripping", () => {
  const items = [
    item("A perfectly ordinary page of readable prose text", 60, 700),
    item("with a second line that also reads correctly here", 60, 680),
  ];
  const md = linesToMarkdown(reconstructPage(items).lines, "3");
  assert.doesNotMatch(md, /could not be decoded/);
  assert.match(md, /perfectly ordinary page/);
});

test("a wholly undecodable page reduces to the marker alone", () => {
  const { lines } = reconstructPage([item(FFFD.repeat(300), 60, 600)]);
  assert.equal(lines.length, 1);
  assert.match(lines[0].cells[0].text, /could not be decoded/);
  // Nothing of the page's own text survives — only the note about its loss.
  // (linesToText includes marker lines, as it does for every other marker, so
  // such a page's char count is the marker's own length. That is why routing
  // must not be decided on the surviving char count — see the classification
  // tests below.)
  assert.ok(!linesToText(lines).includes(FFFD));
});

test("the marker appears exactly once (grid-band recursion must not re-add it)", () => {
  // A garbled page whose survivors form an aligned grid takes the recursive
  // branch; the recursion sees already-stripped glyphs, so it must not
  // re-detect garble and stack a second marker.
  const items = [item(FFFD.repeat(300), 40, 700)];
  for (let r = 0; r < 5; r++) {
    items.push(item("alpha", 40, 600 - r * 20));
    items.push(item("beta", 200, 600 - r * 20));
    items.push(item("gamma", 360, 600 - r * 20));
  }
  const md = linesToMarkdown(reconstructPage(items).lines, "7");
  assert.equal((md.match(/could not be decoded/g) || []).length, 1);
  assert.ok(!md.includes(FFFD));
});

// --- classification: the page must reach the figures flow ------------------

test("a garbled page joins the figures flow with no raster and no fills", () => {
  // The whole point: images 0, figureImages 0, flattened false — every other
  // figure signal reads zero, exactly as on the real page.
  const res = classifyDocument([
    { chars: 3000, images: 0, figureImages: 0 },
    { chars: 341, images: 0, figureImages: 0, garbled: true },
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, [2]);
  assert.deepEqual(res.summary.flattenedPageNumbers, [2]);
  assert.equal(res.decision, "ambiguous");
});

test("a garbled page attaches on either side of the text floor", () => {
  // Routing must not hinge on how much text survived stripping. In practice
  // the marker keeps a garbled page above MIN_TEXT_CHARS_PER_PAGE, but a page
  // judged on the image-only branch has no image to qualify on, so it would
  // fall out entirely — the garble flag is what carries it either way.
  const res = classifyDocument([
    { chars: 3000, images: 0, figureImages: 0 },
    { chars: 8, images: 0, figureImages: 0, garbled: true, garbledTotal: true },
  ]);
  assert.deepEqual(res.summary.chartPageNumbers, [2]);
  assert.deepEqual(res.summary.unreadablePageNumbers, [2]);
});

test("totally-unreadable pages are exempt from the attachment cap", () => {
  // 30 pages with no text fallback whatsoever: dropping any of them loses the
  // page outright, the same standing a scanned exhibit has.
  const perPage = [{ chars: 3000, images: 0, figureImages: 0 }];
  for (let i = 0; i < 30; i++)
    perPage.push({
      chars: 10,
      images: 0,
      figureImages: 0,
      garbled: true,
      garbledTotal: true,
    });
  const { summary } = classifyDocument(perPage);
  const attached = selectChartPages(summary, 20);
  assert.equal(attached.length, 30);
  // Returned in ascending page order, as every figure path expects.
  assert.deepEqual(attached, [...attached].sort((a, b) => a - b));
});

test("partly-readable garbled pages stay under the cap", () => {
  // These keep a text fallback, so the cap may drop their renders.
  const perPage = [{ chars: 3000, images: 0, figureImages: 0 }];
  for (let i = 0; i < 30; i++)
    perPage.push({ chars: 400, images: 0, figureImages: 0, garbled: true });
  const { summary } = classifyDocument(perPage);
  assert.equal(summary.unreadablePageNumbers.length, 0);
  assert.equal(selectChartPages(summary, 20).length, 20);
});

test("garbled pages outrank plain figures when the cap has to choose", () => {
  // Their text is unusable, so the attachment is the only faithful copy —
  // a significant-figure page still converts readably without its render.
  const perPage = [{ chars: 3000, images: 0, figureImages: 0 }];
  for (let i = 0; i < 3; i++)
    perPage.push({ chars: 400, images: 1, figureImages: 1 });
  for (let i = 0; i < 3; i++)
    perPage.push({ chars: 400, images: 0, figureImages: 0, garbled: true });
  const { summary } = classifyDocument(perPage);
  assert.deepEqual(selectChartPages(summary, 3), [5, 6, 7]);
});

test("documents with no garbled pages classify exactly as before", () => {
  const perPage = [
    { chars: 3000, images: 0, figureImages: 0 },
    { chars: 2000, images: 1, figureImages: 1 },
  ];
  const res = classifyDocument(perPage);
  assert.equal(res.summary.unreadablePageNumbers.length, 0);
  assert.deepEqual(res.summary.figurePageNumbers, [2]);
  assert.deepEqual(res.summary.flattenedPageNumbers, []);
});
