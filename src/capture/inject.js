// Injected capture entry — runs inside the captured page's isolated world
// under the activeTab grant (SPEC §3.11).
//
// Both the serialize and the convert step run *here*, not in the background,
// for a structural reason: Turndown needs a DOM, and an MV3 service worker has
// none (no DOMParser). A content script has the page's full DOM, so injecting
// the engine alongside the serializer keeps conversion in one place and makes
// the value that crosses back a plain JSON object.
//
// Delivery of that value is deliberately the caller's job: an injected `files:`
// script has no return value (esbuild's IIFE completion value is discarded), so
// capture.js injects this file to define the global, then evaluates a tiny
// `func:` that calls it and returns the payload.

import { serializePage } from "./serialize.js";
import { collectFigures, captureFiguresNote } from "./figures.js";
import { htmlAnalysis } from "../convert/html.js";

// Redefined on every capture — the isolated world persists between injections
// within a page's lifetime, and a fresh definition is how a rebuilt extension
// replaces a stale one. `opts.figures` additionally collects the page's
// content images as wire files (figures.js) — from here, not the background,
// because the session's cookies and the rendered sizes live here.
globalThis.__decantCapture = async (opts) => {
  try {
    const { html, title, url } = serializePage(document);
    const { decision, reason, summary, markdown } = htmlAnalysis(html);
    const out = { ok: true, title, url, decision, reason, summary, markdown };
    if (opts?.figures && markdown) {
      // Figure trouble must never cost the capture itself — degrade to
      // text-only exactly like the interception figures path does.
      try {
        const { figures, skipped } = await collectFigures(document);
        if (figures.length) out.figures = figures;
        if (skipped > 0) out.figuresSkipped = skipped;
        if (figures.length || skipped > 0) {
          // The footer states the outcome either way — an all-skipped page
          // (CORS-unreadable images) must not look like figures were never
          // attempted (SPEC §3.11: "it's skipped, and the footer says so").
          out.markdown =
            markdown.trimEnd() + `\n\n---\n\n${captureFiguresNote(figures, skipped)}\n`;
        }
      } catch (err) {
        console.warn("[decant] figure collection failed — capturing text only:", err);
      }
    }
    return out;
  } catch (err) {
    // Never throw across the injection boundary: a thrown error surfaces as an
    // opaque scripting failure, while this reaches the caller as a reportable
    // reason the user can be shown.
    return { ok: false, error: String(err?.message || err) };
  }
};
