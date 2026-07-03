// In-browser DOCX engine (shape A) — mammoth.js converts the document to
// Markdown. DOCX sits squarely on the parsing side of the
// parsing-vs-recognition line (it's zipped XML), so no classifier pass is
// needed the way PDFs need one; the only judgment call is images.
//
// Images: mammoth inlines them as data-URI markdown images, which would bloat
// the output with base64 far beyond what the original upload costs — the
// opposite of the point. They're stripped, and per the core rule that Decant
// never silently degrades a visual document (ARCHITECTURE §5), a document
// that *had* images comes back "ambiguous" so the user chooses between
// Markdown-without-images and the untouched original.
//
// analyzeDocx() returns the same { decision, reason, summary, markdown }
// shape as analyzePdf(), so resultFromAnalysis() wraps both engines.
//
// The mammoth.browser build is imported directly: it bundles cleanly for the
// extension and also loads in Node, so unit tests exercise the real engine.
// Legacy binary .doc is NOT supported (mammoth reads OOXML only) — routing
// defaults deliberately match .docx alone.

import * as mammothNs from "mammoth/mammoth.browser.js";

const mammoth = mammothNs.default ?? mammothNs;

// Word's (and Google Docs') "Title"/"Subtitle" styles aren't in mammoth's
// default style map, so a document's title would fall through as a plain
// paragraph. Mapped on top of the defaults.
const STYLE_MAP = [
  "p[style-name='Title'] => h1:fresh",
  "p[style-name='Subtitle'] => h2:fresh",
];

// Replace data-URI images in mammoth's Markdown with visible omission
// markers and count them. Exported for direct unit testing. The marker sits
// exactly where the image was, so both the user and the model reading the
// conversion can see something was dropped there; alt text (rarely present)
// is carried into the marker.
export function stripDataUriImages(markdown) {
  let images = 0;
  const stripped = markdown.replace(/!\[([^\]]*)\]\(data:[^)]*\)/g, (_m, alt) => {
    images++;
    return alt ? `[image omitted: ${alt}]` : "[image omitted]";
  });
  return { markdown: stripped.replace(/\n{3,}/g, "\n\n").trim(), images };
}

// Bookmarks (Word cross-reference targets, every Google Docs heading) come
// out as empty inline anchors — pure noise for an LLM reader.
function stripBookmarkAnchors(markdown) {
  return markdown.replace(/<a id="[^"]*"><\/a>/g, "");
}

// mammoth escapes markdown-significant punctuation conservatively ("text\.",
// "11a\-12:30p", "\(2025\)"); for our consumers that's token noise. Unescape
// the characters that aren't structural where they appear — two escapes are
// load-bearing and stay: a period after line-leading digits ("1\." would
// become a list item) and a line-leading hyphen ("\- x" would become a
// bullet). Parens can't accidentally form links because brackets remain
// escaped. Emphasis/bracket/hash escapes are left alone entirely.
function unescapePunctuation(markdown) {
  return markdown.replace(/\\([.!,?;:'"()-])/g, (whole, ch, offset, s) => {
    const lineStart = (re) => re.test(s.slice(0, offset));
    if (ch === "." && lineStart(/(^|\n)\s*\d+$/)) return whole;
    if (ch === "-" && lineStart(/(^|\n)[ \t]*$/)) return whole;
    return ch;
  });
}

// Decision over mammoth's raw Markdown — pure, exported for tests.
export function docxAnalysis(rawMarkdown) {
  const { markdown: stripped, images } = stripDataUriImages(
    stripBookmarkAnchors(rawMarkdown)
  );
  const markdown = unescapePunctuation(normalizeEmphasisWhitespace(stripped));
  // Omission markers aren't content: an image-only document must still pass
  // through as no-text rather than convert to a page of markers.
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

// mammoth keeps a run's leading/trailing whitespace inside the emphasis
// markers ("__student work __folder", "*‘tab *Zawarkand"); CommonMark won't
// close a span next to a space, so these render as literal underscores or
// asterisks — read as "inconsistent emphasis". Move the whitespace outside.
//
// Delimiters must be *paired sequentially*, not regex-matched — a regex that
// hunts "delimiter, spaces, delimiter" can pair one span's close with the
// next span's open ("__label: __[__url__]") and corrupt the line. Pairing is
// unambiguous here because mammoth escapes literal * and _ in text (\*, \_):
// every unescaped delimiter is structural, alternating open/close per type.
function normalizeEmphasisWhitespace(markdown) {
  const fixLine = (line) => fixDelim(fixDelim(line, "__"), "*");
  return markdown.split("\n").map(fixLine).join("\n");
}

function fixDelim(line, delim) {
  const splitter = delim === "*" ? /(?<!\\)\*/ : /(?<!\\)__/;
  const parts = line.split(splitter);
  if (parts.length < 3) return line; // one delimiter or none — nothing to pair

  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) {
    const span = parts[i];
    if (i + 1 >= parts.length) {
      out += delim + span; // trailing unpaired delimiter — leave verbatim
      break;
    }
    const core = span.trim();
    if (!core) {
      out += delim + span + delim; // whitespace-only span — leave verbatim
    } else {
      const lead = span.match(/^\s*/)[0];
      const trail = span.match(/\s*$/)[0];
      out += lead + delim + core + delim + trail;
    }
    out += parts[i + 1];
  }
  return out;
}

export async function analyzeDocx(file) {
  const { value } = await mammoth.convertToMarkdown(
    { arrayBuffer: await file.arrayBuffer() },
    { styleMap: STYLE_MAP }
  );
  return docxAnalysis(value);
}
