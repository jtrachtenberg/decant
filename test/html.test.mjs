// Unit tests for the HTML engine (src/convert/html.js). No fixtures needed —
// the engine takes strings, so cases are inline. Runs the real Turndown.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeHtml, htmlAnalysis, decodeHtml } from "../src/convert/html.js";

const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

test("headings, emphasis, links, and lists convert", () => {
  const res = htmlAnalysis(
    `<h1>Title</h1><p>Some <strong>bold</strong> and a <a href="https://x.y/z">link</a>.</p>
     <ul><li>one</li><li>two</li></ul>`
  );
  assert.equal(res.decision, "convert");
  assert.match(res.markdown, /^# Title$/m);
  assert.match(res.markdown, /\*\*bold\*\*/);
  assert.match(res.markdown, /\[link\]\(https:\/\/x\.y\/z\)/);
  assert.match(res.markdown, /^- one$/m);
});

test("tables convert via the GFM plugin", () => {
  const res = htmlAnalysis(
    `<table><tr><th>Region</th><th>Q1</th></tr><tr><td>North</td><td>100</td></tr></table>`
  );
  assert.match(res.markdown, /\| Region \| Q1 \|/);
  assert.match(res.markdown, /\| North \| 100 \|/);
});

test("script/style/title text never leaks into the output", () => {
  const res = htmlAnalysis(
    `<html><head><title>tab title</title><style>.x{color:red}</style></head>
     <body><script>alert("hi")<\/script><p>real content</p></body></html>`
  );
  assert.equal(res.markdown, "real content\n");
});

test("remote images stay as Markdown images and are not visuals", () => {
  const res = htmlAnalysis(`<p>see <img src="https://x.y/chart.png" alt="chart"> here</p>`);
  assert.equal(res.decision, "convert");
  assert.equal(res.summary.images, 0);
  assert.match(res.markdown, /!\[chart\]\(https:\/\/x\.y\/chart\.png\)/);
});

test("data-URI images become omission markers and trigger ambiguous", () => {
  const res = htmlAnalysis(
    `<p>before</p><img src="${PNG_URI}" alt="q3 funnel"><img src="${PNG_URI}" alt="  "><p>after</p>`
  );
  assert.equal(res.decision, "ambiguous");
  assert.equal(res.reason, "text-with-images");
  assert.equal(res.summary.images, 2);
  assert.match(res.markdown, /\[image omitted: q3 funnel\]/);
  assert.match(res.markdown, /\[image omitted\]/);
});

test("marker-only pages still pass through as no-text", () => {
  const res = htmlAnalysis(`<img src="${PNG_URI}">`);
  assert.equal(res.decision, "passthrough");
  assert.equal(res.reason, "no-text");
});

test("empty and text-free HTML passes through", () => {
  assert.equal(htmlAnalysis("").decision, "passthrough");
  assert.equal(htmlAnalysis("<div><span>   </span></div>").decision, "passthrough");
});

test("analyzeHtml reads a File end-to-end", async () => {
  const file = new File(["<h2>From a file</h2>"], "page.html", { type: "text/html" });
  const res = await analyzeHtml(file);
  assert.equal(res.decision, "convert");
  assert.match(res.markdown, /^## From a file$/m);
});

test("a data-URI image alt with ] and | can't break the omission marker (L12)", () => {
  const res = htmlAnalysis(
    `<p>x</p><img src="${PNG_URI}" alt="a] b | c"><p>y</p>`
  );
  // The `]` must not close the marker early (which would leave residue that
  // counts as real text); the `|` is escaped so it can't corrupt a GFM row.
  assert.match(res.markdown, /\[image omitted: a b \\\| c\]/);
  // Stripping the marker leaves only the surrounding prose.
  assert.equal(
    res.markdown.replace(/\[image omitted[^\]]*\]/g, "").replace(/\s+/g, " ").trim(),
    "x y"
  );
});

test("decodeHtml honors a declared windows-1252 charset (M4)", () => {
  // 0x92 is a right single quote in windows-1252; in UTF-8 it's an invalid byte
  // that decodes to U+FFFD. With the meta declaration it must come through as ’.
  const bytes = new Uint8Array([
    ...[...'<meta charset="windows-1252"><p>it'].map((c) => c.charCodeAt(0)),
    0x92,
    ...[...'s</p>'].map((c) => c.charCodeAt(0)),
  ]);
  const html = decodeHtml(bytes);
  assert.match(html, /it’s/);
  assert.doesNotMatch(html, /�/);
});

test("decodeHtml keeps UTF-8 as the default for undeclared documents (M4)", () => {
  const bytes = new TextEncoder().encode("<p>café — déjà</p>");
  assert.match(decodeHtml(bytes), /café — déjà/);
});
