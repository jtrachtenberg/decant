// Pure, dependency-free conversion-classification logic.
//
// This module deliberately imports nothing (no pdf.js, no chrome.*) so it can
// be shared three ways: the in-browser converter, the Node dev inspector
// (scripts/inspect-pdf.mjs), and unit tests (test/classify.test.mjs). Callers
// gather raw per-page signals using whichever pdf.js build they have; this
// module turns those signals into text and a document-level decision.
//
// Calibration came from a 3-file corpus (see scripts/inspect-pdf.mjs):
//   - a clean text PDF        → convert
//   - a no-text vector form   → passthrough (0 extractable chars)
//   - a WHO report, text with ~11 image-chart pages → ambiguous
//
// The signals that survived calibration: extractable text (primary) and
// images-on-text-pages (the chart flag). Vector path-op density was a dead
// signal — section dividers spike it without being charts — so it's not used.

// A page needs at least this many non-whitespace characters to count as a
// real "content" text page. Matches the original char/page threshold so the
// clean-text case keeps converting.
export const MIN_TEXT_CHARS_PER_PAGE = 50;

// How many image-bearing text pages a document needs before we treat it as
// ambiguous (text + meaningful charts) rather than convert. >=2 avoids
// false-positives from a single incidental logo on a header page.
export const MIN_CHART_PAGES_FOR_AMBIGUOUS = 2;

// pdf.js OPS names that paint raster images. Callers map these through their
// own pdfjsLib.OPS table; kept here so the list is defined once.
export const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintInlineImage",
  "paintImageMaskXObject",
];

// Non-whitespace character count — the whitespace-agnostic text measure.
export function countChars(text) {
  const m = text.match(/\S/g);
  return m ? m.length : 0;
}

// Reconstruct readable text from positioned glyph runs. pdf.js gives each run
// a transform matrix: [4] is x, [5] is y (origin bottom-left, larger y higher).
// Sort top-to-bottom then left-to-right, group runs into lines by y proximity,
// insert spaces on horizontal gaps, break paragraphs on large vertical gaps.
export function itemsToText(items) {
  const glyphs = items.filter(
    (it) => typeof it.str === "string" && it.str.length
  );
  if (!glyphs.length) return "";

  glyphs.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > 2) return dy;
    return a.transform[4] - b.transform[4];
  });

  const lines = [];
  for (const g of glyphs) {
    const x = g.transform[4];
    const y = g.transform[5];
    const w = g.width || 0;
    const h = g.height || 10;
    const last = lines[lines.length - 1];

    if (last && Math.abs(y - last.y) <= h * 0.5) {
      const gap = x - last.endX;
      const needsSpace =
        gap > h * 0.25 && !/\s$/.test(last.text) && !/^\s/.test(g.str);
      last.text += (needsSpace ? " " : "") + g.str;
      last.endX = x + w;
      last.y = (last.y + y) / 2;
    } else {
      const para = last ? last.y - y > h * 1.6 : false;
      lines.push({ y, endX: x + w, text: g.str, para });
    }
  }

  let out = "";
  lines.forEach((line, i) => {
    const text = line.text.replace(/[ \t]+/g, " ").trim();
    if (!text) return;
    if (i > 0) out += line.para ? "\n\n" : "\n";
    out += text;
  });
  return out;
}

// Decide what to do with a document from its per-page signals.
//
//   perPage: [{ chars: number, images: number }]
//
// Returns { decision: "convert"|"passthrough"|"ambiguous", reason, summary }.
//   convert     — text-dominant, no meaningful charts. Swap in Markdown.
//   passthrough — no usable text layer (scan / vector form / image-only).
//   ambiguous   — substantial text AND image-charts; converting to text-only
//                 would drop the charts. Caller decides (defaults to keeping
//                 the original until the manual toggle lands).
export function classifyDocument(perPage) {
  const pageCount = perPage.length;
  const contentPages = perPage.filter(
    (p) => p.chars >= MIN_TEXT_CHARS_PER_PAGE
  ).length;
  const chartPages = perPage.filter(
    (p) => p.chars >= MIN_TEXT_CHARS_PER_PAGE && p.images >= 1
  ).length;
  const totalChars = perPage.reduce((s, p) => s + p.chars, 0);
  const totalImages = perPage.reduce((s, p) => s + p.images, 0);
  const summary = {
    pageCount,
    contentPages,
    chartPages,
    totalChars,
    totalImages,
  };

  if (contentPages === 0) {
    return { decision: "passthrough", reason: "no-text", summary };
  }
  if (chartPages === 0) {
    return { decision: "convert", reason: "text", summary };
  }
  if (chartPages >= MIN_CHART_PAGES_FOR_AMBIGUOUS) {
    return { decision: "ambiguous", reason: "text-with-charts", summary };
  }
  return { decision: "convert", reason: "text-incidental-image", summary };
}
