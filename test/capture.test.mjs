// Unit tests for the page-capture surface (src/capture/*) — the DOM
// serializer, the filename derivation, and the context-menu model.
//
// The serializer runs against domino (turndown's Node DOM shim), which has no
// getComputedStyle and no shadow roots — the same degraded environment the
// module is written to tolerate, so these tests cover the attribute-based
// paths. Computed-style hiding and shadow expansion need a real browser and
// are covered by the runtime harness instead.
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import domino from "@mixmark-io/domino";
import {
  pickRoot,
  cloneForCapture,
  stripNonContent,
  resolveImages,
  absolutizeLinks,
  largestFromSrcset,
  serializePage,
} from "../src/capture/serialize.js";
import { captureFileName, captureBlockedReason } from "../src/capture/capture.js";
import {
  menuItems,
  hostFromMenuId,
  displayName,
  MENU_PARENT_ID,
  MENU_PREFIX,
  FIGURES_MENU_ID,
} from "../src/capture/menus.js";
import { captureFiguresNote } from "../src/capture/figures.js";

// domino gives no location/baseURI, so tests that need a base pass one in via
// a stub document wrapper.
function doc(html, url = "https://example.com/article/x") {
  const d = domino.createDocument(html, true);
  Object.defineProperty(d, "baseURI", { value: url, configurable: true });
  Object.defineProperty(d, "location", { value: { href: url }, configurable: true });
  return d;
}

const prose = "<p>" + "Real article text that carries the page. ".repeat(8) + "</p>";

// ------------------------------------------------------------ root pick ---

test("a content-bearing <main> wins over <body>", () => {
  const d = doc(`<body><nav>menu</nav><main>${prose}</main></body>`);
  assert.equal(pickRoot(d).tagName, "MAIN");
});

test("a teaser <article> loses to <body>", () => {
  // The article is a card in a feed — most of the page's text is elsewhere.
  const d = doc(`<body><article><p>Teaser.</p></article><div>${prose}</div></body>`);
  assert.equal(pickRoot(d).tagName, "BODY");
});

test("a page with no landmarks falls back to <body>", () => {
  assert.equal(pickRoot(doc(`<body><div>${prose}</div></body>`)).tagName, "BODY");
});

// ------------------------------------------------------------ stripping ---

test("scripts, styles, and form controls never reach the output", () => {
  const d = doc(`<body><main><p>keep</p><script>evil()</script><style>.x{}</style>
    <button>Click</button><input value="x"><svg><path/></svg></main></body>`);
  const clone = stripNonContent(cloneForCapture(pickRoot(d), d), { fromBody: false });
  const html = clone.innerHTML;
  assert.match(html, /keep/);
  for (const gone of ["evil", "<style", "<button", "<input", "<svg"]) {
    assert.ok(!html.includes(gone), `expected ${gone} to be stripped`);
  }
});

test("site furniture is stripped from <body> captures but kept inside a content root", () => {
  const html = `<nav>site nav</nav><footer>site footer</footer><p>content</p>`;
  const fromBody = stripNonContent(cloneForCapture(doc(`<body>${html}</body>`).body, doc()), {
    fromBody: true,
  }).innerHTML;
  assert.ok(!fromBody.includes("site nav"));
  assert.ok(!fromBody.includes("site footer"));

  // The same markup inside a chosen <main> is the article's own byline area.
  const d2 = doc(`<body><main>${html}</main></body>`);
  const fromMain = stripNonContent(cloneForCapture(pickRoot(d2), d2), { fromBody: false }).innerHTML;
  assert.match(fromMain, /site footer/);
});

test("hidden elements are stripped by attribute and by inline style", () => {
  const d = doc(`<body><main><p>visible</p><p hidden>a</p><p aria-hidden="true">b</p>
    <p style="display:none">c</p><p style="VISIBILITY: HIDDEN">d</p></main></body>`);
  const html = stripNonContent(cloneForCapture(pickRoot(d), d), { fromBody: false }).innerHTML;
  assert.match(html, /visible/);
  for (const gone of [">a<", ">b<", ">c<", ">d<"]) {
    assert.ok(!html.includes(gone), `expected ${gone} to be stripped`);
  }
});

test("the live document is never mutated", () => {
  const d = doc(`<body><main><p>keep</p><script>evil()</script></main></body>`);
  const before = d.body.innerHTML;
  serializePage(d);
  assert.equal(d.body.innerHTML, before);
});

// --------------------------------------------------------------- images ---

test("lazy-loaded images are promoted to a real absolute src", () => {
  const d = doc(`<body><main><img data-src="/img/a.png" alt="a"></main></body>`);
  const clone = resolveImages(cloneForCapture(pickRoot(d), d), d.baseURI);
  assert.match(clone.innerHTML, /src="https:\/\/example\.com\/img\/a\.png"/);
});

test("a placeholder src does not block the lazy attribute", () => {
  const d = doc(
    `<body><main><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/real.png"></main></body>`
  );
  const clone = resolveImages(cloneForCapture(pickRoot(d), d), d.baseURI);
  assert.match(clone.innerHTML, /src="https:\/\/example\.com\/real\.png"/);
});

test("srcset resolves to its largest candidate and is then dropped", () => {
  assert.equal(largestFromSrcset("a.png 480w, b.png 1024w, c.png 800w"), "b.png");
  assert.equal(largestFromSrcset("a.png 1x, b.png 2x"), "b.png");
  assert.equal(largestFromSrcset(""), "");

  const d = doc(`<body><main><img srcset="/s.png 480w, /l.png 1024w"></main></body>`);
  const html = resolveImages(cloneForCapture(pickRoot(d), d), d.baseURI).innerHTML;
  assert.match(html, /src="https:\/\/example\.com\/l\.png"/);
  assert.ok(!html.includes("srcset"));
});

test("tracking pixels are dropped", () => {
  const d = doc(`<body><main><img src="/beacon.gif" width="1" height="1"><img src="/real.png" width="600" height="400"></main></body>`);
  const html = resolveImages(cloneForCapture(pickRoot(d), d), d.baseURI).innerHTML;
  assert.ok(!html.includes("beacon"));
  assert.match(html, /real\.png/);
});

test("relative links are absolutized", () => {
  const d = doc(`<body><main><a href="/next">next</a><a href="#frag">frag</a></main></body>`);
  const html = absolutizeLinks(cloneForCapture(pickRoot(d), d), d.baseURI).innerHTML;
  assert.match(html, /href="https:\/\/example\.com\/next"/);
  assert.match(html, /href="https:\/\/example\.com\/article\/x#frag"/);
});

// ------------------------------------------------------- whole pipeline ---

test("serializePage returns clean html plus page identity", () => {
  const d = doc(
    `<html><head><title>  My Article  </title></head>
     <body><nav>nav junk</nav><main>${prose}<img data-src="/p.png" alt="pic"></main></body></html>`,
    "https://example.com/a?b=c"
  );
  const out = serializePage(d);
  assert.equal(out.title, "My Article");
  assert.equal(out.url, "https://example.com/a?b=c");
  assert.ok(!out.html.includes("nav junk"));
  assert.match(out.html, /Real article text/);
  assert.match(out.html, /src="https:\/\/example\.com\/p\.png"/);
});

// ------------------------------------------------------------- filename ---

test("captureFileName uses the title, sanitized", () => {
  assert.equal(captureFileName("Quarterly Results", "https://x.y/"), "Quarterly Results.md");
  // Runs of illegal characters collapse to a single dash.
  assert.equal(captureFileName('A/B: "test" <x>|y', "https://x.y/"), "A-B- -test- -x-y.md");
  assert.equal(captureFileName("  spaced   out  ", "https://x.y/"), "spaced out.md");
});

test("captureFileName falls back to the hostname, then to page", () => {
  assert.equal(captureFileName("", "https://www.example.com/a"), "example.com.md");
  assert.equal(captureFileName("   ", "not-a-url"), "page.md");
});

test("captureFileName caps runaway titles", () => {
  const name = captureFileName("x".repeat(200), "https://x.y/");
  assert.ok(name.length <= 63, `got ${name.length}`);
});

// -------------------------------------------------------- blocked pages ---

test("browser-internal and gallery pages report a friendly reason", () => {
  assert.match(captureBlockedReason("chrome://settings"), /browser-internal/);
  assert.match(captureBlockedReason("about:debugging"), /browser-internal/);
  assert.match(captureBlockedReason("https://chromewebstore.google.com/x"), /gallery/);
  assert.equal(captureBlockedReason("https://example.com/"), null);
});

// ------------------------------------------------------------- the menu ---

test("one enabled host needs no submenu", () => {
  const items = menuItems(["claude.ai"]);
  assert.equal(items.length, 2); // the action + the figures checkbox
  assert.equal(items[0].title, "Decant page to Claude");
  assert.equal(items[0].id, MENU_PREFIX + "claude.ai");
  assert.ok(!items[0].parentId);
});

test("several hosts nest under one parent, in config order", () => {
  const items = menuItems(["claude.ai", "chatgpt.com", "www.perplexity.ai"]);
  assert.equal(items[0].id, MENU_PARENT_ID);
  assert.deepEqual(
    items.slice(1, -1).map((i) => i.title),
    ["Claude", "ChatGPT", "Perplexity"]
  );
  assert.ok(items.slice(1).every((i) => i.parentId === MENU_PARENT_ID));
});

test("the figures checkbox rides last and reflects the config", () => {
  const off = menuItems(["claude.ai", "chatgpt.com"]).at(-1);
  assert.equal(off.id, FIGURES_MENU_ID);
  assert.equal(off.type, "checkbox");
  assert.equal(off.checked, false);
  const on = menuItems(["claude.ai"], { figures: true }).at(-1);
  assert.equal(on.checked, true);
  assert.ok(!on.parentId, "single-host layout has no parent to nest under");
});

test("no enabled hosts means no menu at all", () => {
  assert.deepEqual(menuItems([]), []);
});

test("unknown hosts get a readable name from their domain", () => {
  assert.equal(displayName("chat.deepseek.com"), "DeepSeek");
  assert.equal(displayName("my-llm.internal.corp"), "My-llm");
  assert.equal(displayName("www.example.com"), "Example");
});

test("hostFromMenuId round-trips ours and ignores foreign ids", () => {
  assert.equal(hostFromMenuId(MENU_PREFIX + "claude.ai"), "claude.ai");
  assert.equal(hostFromMenuId(MENU_PARENT_ID), null);
  assert.equal(hostFromMenuId(FIGURES_MENU_ID), null);
  assert.equal(hostFromMenuId("someone-elses-item"), null);
  assert.equal(hostFromMenuId(undefined), null);
});

// -------------------------------------------------------- figures note ---

test("captureFiguresNote lists names and admits unreadable images", () => {
  const figs = [{ name: "chart.png" }, { name: "photo.jpg" }];
  const clean = captureFiguresNote(figs, 0);
  assert.match(clean, /"chart\.png", "photo\.jpg"/);
  assert.ok(!clean.includes("couldn't be read"));
  const partial = captureFiguresNote(figs, 3);
  assert.match(partial, /3 more couldn't be read .* URL references/);
});
