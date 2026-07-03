// In-browser HTML engine (shape A) — Turndown converts HTML to Markdown,
// with the GFM plugin for tables and strikethrough. HTML is pure parsing:
// the token win is large because raw HTML spends most of its budget on
// tags, attributes, scripts, and styles that carry no meaning for a model.
//
// Turndown resolves per environment: the browser build uses the native
// DOMParser (available in content scripts), the Node build uses its own DOM
// shim — so unit tests exercise the real engine with plain strings.
//
// Image policy, consistent with the other engines:
//   - Remote images (<img src="http…">) become ordinary Markdown images —
//     nothing is dropped, the reference IS the content, so they don't count
//     as visuals and don't trigger the ambiguous prompt.
//   - Embedded data-URI images are the DOCX case again: inlining base64 is
//     the bloat this project exists to remove, so they're replaced with
//     visible "[image omitted(: alt)]" markers, counted, and any count > 0
//     returns "ambiguous" so the user can choose the untouched original.
//
// analyzeHtml() returns the shared { decision, reason, summary, markdown }
// shape, wrapped by resultFromAnalysis() like every other engine.

import TurndownNs from "turndown";
import * as gfmNs from "turndown-plugin-gfm";

const TurndownService = TurndownNs.default ?? TurndownNs;
const { gfm } = gfmNs.default ?? gfmNs;

// Pure — exported for direct unit testing.
export function htmlAnalysis(html) {
  let images = 0;

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    hr: "---",
    bulletListMarker: "-",
  });
  td.use(gfm);
  // Non-content elements whose text would otherwise leak into the output.
  td.remove(["script", "style", "noscript", "title", "template"]);
  td.addRule("decant-data-uri-images", {
    filter: (node) =>
      node.nodeName === "IMG" && /^data:/i.test(node.getAttribute("src") || ""),
    replacement: (_content, node) => {
      images++;
      const alt = (node.getAttribute("alt") || "").trim();
      return alt ? `[image omitted: ${alt}]` : "[image omitted]";
    },
  });

  const markdown = td
    .turndown(html)
    // Turndown pads list markers to four columns ("-   item"); single-space
    // markers read identically and don't spend tokens on alignment.
    .replace(/^(\s*)- {3}/gm, "$1- ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  // Markers aren't content: a page that is only embedded images must still
  // pass through as no-text.
  const realText = markdown.replace(/\[image omitted[^\]]*\]/g, "").trim();
  const summary = { images, chars: realText.length };
  if (!realText) {
    return { decision: "passthrough", reason: "no-text", summary, markdown: null };
  }
  return {
    decision: images > 0 ? "ambiguous" : "convert",
    reason: images > 0 ? "text-with-images" : "text",
    summary,
    markdown: markdown + "\n",
  };
}

export async function analyzeHtml(file) {
  return htmlAnalysis(await file.text());
}
