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
// Named import resolves in BOTH environments: esbuild takes the package's
// "module" entry (pure ESM, named exports only — a `.default` access there is
// statically undefined and drew an esbuild warning), and Node takes the CJS
// "main", whose interop lexer surfaces `gfm` as a named export too.
import { gfm } from "turndown-plugin-gfm";
import { fileBytes } from "./read-file.js";
import { escapeMarkerLabel } from "./xlsx.js";

const TurndownService = TurndownNs.default ?? TurndownNs;

// Decode HTML bytes the way a browser would: a BOM wins, otherwise the charset
// declared in the document head, otherwise UTF-8. `blob.text()` (and a bare
// TextDecoder) always assume UTF-8, so a windows-1252 "Save as Web Page" export
// or a Shift_JIS / GBK page would decode to U+FFFD mojibake and silently
// convert to garbage Markdown. Unlabeled input keeps the UTF-8 default (the vast
// majority of modern pages), so this only changes behaviour for files that
// declare a non-UTF-8 charset. Exported for direct unit testing.
export function decodeHtml(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf)
    return decodeWith("utf-8", u8);
  if (u8.length >= 2 && u8[0] === 0xff && u8[1] === 0xfe)
    return decodeWith("utf-16le", u8);
  if (u8.length >= 2 && u8[0] === 0xfe && u8[1] === 0xff)
    return decodeWith("utf-16be", u8);
  // Scan the head as latin1 (every byte is a code point) for a charset label —
  // this covers both <meta charset="…"> and the http-equiv Content-Type form.
  let head = "";
  for (let i = 0; i < Math.min(u8.length, 1024); i++) head += String.fromCharCode(u8[i]);
  const label = /<meta[^>]+charset\s*=\s*["']?\s*([\w-]+)/i.exec(head)?.[1] || "utf-8";
  return decodeWith(label, u8);
}

function decodeWith(label, u8) {
  try {
    return new TextDecoder(label).decode(u8);
  } catch {
    return new TextDecoder("utf-8").decode(u8); // unknown label → best effort
  }
}

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
      const alt = escapeMarkerLabel(node.getAttribute("alt"));
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
  return htmlAnalysis(decodeHtml(await fileBytes(file)));
}
