// Live-DOM serializer for page capture (SPEC §3.11, ADR 0023).
//
// Takes the *rendered* document — post-JS, post-login, lazy images resolved —
// and produces clean HTML for the existing M2 HTML engine. This is the only
// new conversion code in the capture path; everything downstream is reused.
//
// Two hard rules:
//   - Never mutate the live page. Everything happens on a clone; a capture the
//     user can see happen is a bug.
//   - Degrade where the DOM is thinner. This module also runs under Node's
//     domino shim in tests, which has no getComputedStyle (feature-detected
//     below) and no shadow roots (the property reads undefined and is simply
//     skipped). Everything else it uses is core DOM present in both.
//
// Pure apart from reading the passed-in document — exported piecewise so the
// root choice, stripping, and image resolution can be unit-tested directly.

// Elements whose text is never page content, stripped wherever they appear.
const ALWAYS_STRIP = [
  "script", "style", "noscript", "template", "link", "meta",
  "iframe", "object", "embed", "canvas", "svg",
  "input", "select", "textarea", "button", "dialog",
  "video", "audio",
].join(",");

// Site furniture — stripped only when capturing from <body>. Inside a <main>
// or <article> these mean something different (an article's own <footer> is
// its byline/date), so a chosen content root keeps them.
const CHROME_STRIP = [
  "nav", "header", "footer", "aside",
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="complementary"]', '[role="search"]',
].join(",");

const HIDDEN_STRIP = '[hidden],[aria-hidden="true"]';

// Lazy-loading attributes, in the order sites tend to mean them.
const LAZY_SRC_ATTRS = ["data-src", "data-original", "data-lazy-src", "data-lazy", "data-hi-res-src"];

// Every query result is snapshotted into an array before use. Three of the
// passes below remove nodes as they iterate, and a snapshot is the only form
// that's safe to mutate through — a live list would skip elements. (It also
// sidesteps a domino quirk the tests hit: a non-empty result is not iterable.)
function all(root, selector) {
  return Array.from(root.querySelectorAll(selector));
}

// Choose the element that holds the article. Falls back to <body> unless a
// landmark holds a real share of the text — a <main> wrapping only a teaser
// (or an <article> that is one card in a feed) would otherwise throw the page
// away. Exported for tests.
export function pickRoot(doc) {
  const body = doc.body;
  if (!body) return doc.documentElement;
  const bodyLen = textLength(body);
  const candidates = [...doc.querySelectorAll('main,[role="main"],article')];
  let best = null;
  let bestLen = 0;
  for (const el of candidates) {
    const len = textLength(el);
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  // A landmark worth trusting carries most of the page's text.
  if (best && bodyLen > 0 && bestLen / bodyLen >= 0.25) return best;
  return body;
}

function textLength(el) {
  return (el.textContent || "").trim().length;
}

// Clone the subtree, inlining open shadow roots and dropping anything the
// browser is rendering as invisible.
//
// Both jobs need the *original* nodes: cloneNode does not copy shadow roots,
// and getComputedStyle on a detached clone tells you nothing. So the original
// and clone trees are walked in parallel — cloneNode(true) preserves document
// order, and shadow content is invisible to querySelectorAll, so the two
// snapshots stay index-aligned.
//
// Known limit (v1): shadow roots *nested inside* shadow content aren't
// expanded, and slotted light-DOM children are appended after the shadow
// children rather than interleaved at their <slot> positions.
export function cloneForCapture(root, doc = root.ownerDocument) {
  const clone = root.cloneNode(true);
  const originals = [root, ...root.querySelectorAll("*")];
  const clones = [clone, ...clone.querySelectorAll("*")];
  const view = doc?.defaultView;
  const computed = typeof view?.getComputedStyle === "function" ? view.getComputedStyle.bind(view) : null;

  const n = Math.min(originals.length, clones.length);
  for (let i = 0; i < n; i++) {
    // Closed shadow roots read as null here, so only open ones are inlined.
    const shadow = originals[i].shadowRoot;
    if (shadow) {
      for (const child of [...shadow.children]) clones[i].append(child.cloneNode(true));
    }
    if (computed && isVisuallyHidden(computed, originals[i])) {
      clones[i].remove(); // detaching an already-detached node is a no-op
    }
  }
  return clone;
}

// Only ever called with live, attached elements — which is what makes it
// meaningful. A detached clone reports display "" for everything, so this
// check has to happen against the original tree or it silently does nothing.
function isVisuallyHidden(computed, el) {
  const style = computed(el);
  return style.display === "none" || style.visibility === "hidden";
}

// Remove non-content elements from an already-cloned tree. `fromBody` selects
// whether site furniture goes too (see CHROME_STRIP).
export function stripNonContent(clone, { fromBody }) {
  const selectors = [ALWAYS_STRIP, HIDDEN_STRIP];
  if (fromBody) selectors.push(CHROME_STRIP);
  for (const el of all(clone, selectors.join(","))) el.remove();

  // Inline display:none survives the computed-style pass when that pass can't
  // run (tests, detached documents), and costs one regex here.
  for (const el of all(clone, "[style]")) {
    if (/(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(el.getAttribute("style") || "")) {
      el.remove();
    }
  }
  return clone;
}

// Give every <img> a usable absolute src: lazy-loading attributes promoted,
// srcset resolved to its largest candidate, relative paths absolutized.
// Tracking pixels are dropped — they'd otherwise become Markdown images.
export function resolveImages(clone, baseUrl) {
  for (const img of all(clone, "img")) {
    if (isTrackingPixel(img)) {
      img.remove();
      continue;
    }
    let src = img.getAttribute("src") || "";
    if (!src || src.startsWith("data:image/gif;base64,R0lGOD")) {
      // Empty, or the 1x1 transparent-GIF placeholder lazy loaders park in src.
      src = "";
    }
    if (!src) {
      for (const attr of LAZY_SRC_ATTRS) {
        const val = img.getAttribute(attr);
        if (val) {
          src = val;
          break;
        }
      }
    }
    if (!src) src = largestFromSrcset(img.getAttribute("srcset") || img.getAttribute("data-srcset") || "");
    if (src) {
      const abs = absolute(src, baseUrl);
      if (abs) img.setAttribute("src", abs);
      else img.removeAttribute("src");
    }
    // srcset would otherwise survive into the output as dead weight.
    img.removeAttribute("srcset");
    img.removeAttribute("data-srcset");
  }
  return clone;
}

// A declared 1x1 (or smaller) image is a beacon, not content.
function isTrackingPixel(img) {
  const w = Number(img.getAttribute("width"));
  const h = Number(img.getAttribute("height"));
  return w > 0 && h > 0 && w <= 2 && h <= 2;
}

// "a.png 480w, b.png 1024w" → the highest-density/width candidate.
export function largestFromSrcset(srcset) {
  let best = "";
  let bestWeight = -1;
  for (const part of srcset.split(",")) {
    const [url, descriptor = ""] = part.trim().split(/\s+/);
    if (!url) continue;
    const weight = Number.parseFloat(descriptor) || 1;
    if (weight > bestWeight) {
      best = url;
      bestWeight = weight;
    }
  }
  return best;
}

function absolute(url, baseUrl) {
  try {
    return new URL(url, baseUrl || undefined).href;
  } catch {
    return "";
  }
}

// Links keep their meaning only if they still point somewhere from outside the
// page, so relative hrefs are absolutized too.
export function absolutizeLinks(clone, baseUrl) {
  for (const a of all(clone, "a[href]")) {
    const abs = absolute(a.getAttribute("href"), baseUrl);
    if (abs) a.setAttribute("href", abs);
    else a.removeAttribute("href");
  }
  return clone;
}

// The whole pipeline: rendered document → clean HTML plus its identity.
export function serializePage(doc) {
  const root = pickRoot(doc);
  const baseUrl = doc.baseURI || doc.location?.href || "";
  const clone = cloneForCapture(root, doc);
  stripNonContent(clone, { fromBody: root === doc.body });
  resolveImages(clone, baseUrl);
  absolutizeLinks(clone, baseUrl);
  return {
    title: (doc.title || "").trim(),
    url: doc.location?.href || doc.URL || baseUrl,
    html: clone.innerHTML,
  };
}
