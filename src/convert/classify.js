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

// Horizontal-gap thresholds, as multiples of the line's glyph height:
//   above WORD_GAP  → a space within the same cell (word break)
//   above COLUMN_GAP → a new cell (column break — a table-ish gap)
// COLUMN_GAP is deliberately wide so ordinary prose stays one cell and only
// genuine column gaps split, keeping table detection conservative.
const WORD_GAP = 0.25;
const COLUMN_GAP = 2.0;

// Paragraph break when the vertical gap to the previous line exceeds this
// multiple of line height.
const PARA_GAP = 1.6;

// Heading thresholds: a single-cell line taller than the page's body text by
// these ratios becomes a Markdown heading of the given level.
const HEADING_LEVELS = [
  [1.8, "# "],
  [1.4, "## "],
  [1.15, "### "],
];
const HEADING_MAX_LEN = 90; // headings are short; longer lines stay paragraphs

// Reconstruct lines from positioned glyph runs. pdf.js gives each run a
// transform matrix ([4]=x, [5]=y, origin bottom-left so larger y is higher).
// Sort top-to-bottom then left-to-right, group runs into lines by y proximity,
// and split each line into cells on large horizontal (column) gaps.
//
// Returns line objects: { y, h, para, cells: [{ text, x, endX }] }.
//
// Known limitation: glyphs are ordered by y then x, so a multi-column page
// layout interleaves columns (left and right text share a row). Column
// detection / reflow is future work; single-column docs read correctly.
export function reconstructLines(items) {
  const glyphs = items.filter(
    (it) => typeof it.str === "string" && it.str.length
  );
  if (!glyphs.length) return [];

  glyphs.sort((a, b) => {
    const dy = b.transform[5] - a.transform[5];
    if (Math.abs(dy) > 2) return dy;
    return a.transform[4] - b.transform[4];
  });

  // Whitespace-only runs are not appended and don't advance the cell's right
  // edge — some PDFs fill column gaps with space glyphs, and consuming their
  // width would mask the positional gap that signals a column break. Instead a
  // whitespace run just flags that a space belongs before the next glyph, so
  // real word spacing survives while wide column gaps still register.
  const lines = [];
  let pendingSpace = false;
  for (const g of glyphs) {
    const x = g.transform[4];
    const y = g.transform[5];
    const w = g.width || 0;
    const h = g.height || 10;
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(y - last.y) <= last.h * 0.5;

    if (!g.str.trim().length) {
      if (sameLine) pendingSpace = true;
      continue;
    }

    if (sameLine) {
      const cell = last.cells[last.cells.length - 1];
      const gap = x - cell.endX;
      if (gap > COLUMN_GAP * last.h) {
        last.cells.push({ text: g.str, x, endX: x + w });
      } else {
        const needsSpace =
          (pendingSpace || gap > WORD_GAP * last.h) &&
          !/\s$/.test(cell.text) &&
          !/^\s/.test(g.str);
        cell.text += (needsSpace ? " " : "") + g.str;
        cell.endX = x + w;
      }
      last.y = (last.y + y) / 2;
      if (h > last.h) last.h = h;
    } else {
      const para = last ? last.y - y > last.h * PARA_GAP : false;
      lines.push({ y, h, para, cells: [{ text: g.str, x, endX: x + w }] });
    }
    pendingSpace = false;
  }

  for (const line of lines) {
    line.cells = line.cells
      .map((c) => ({ ...c, text: c.text.replace(/[ \t]+/g, " ").trim() }))
      .filter((c) => c.text.length);
  }
  return lines.filter((line) => line.cells.length);
}

// Plain text of reconstructed lines — cells space-joined, lines newline-joined.
// Used for the whitespace-agnostic char count that drives classification, so
// that count is unaffected by Markdown decoration.
export function linesToText(lines) {
  return lines.map((l) => l.cells.map((c) => c.text).join(" ")).join("\n");
}

// Render reconstructed lines to Markdown: font-size headings, conservative
// tables (clear multi-row/multi-column grids), and paragraph breaks.
export function linesToMarkdown(lines) {
  if (!lines.length) return "";
  const bodyH = modeHeight(lines);
  const tableStarts = tableRuns(lines); // Map<startIndex, endIndex>

  const blocks = [];
  let para = [];
  const flush = () => {
    if (para.length) {
      blocks.push(para.join("\n"));
      para = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    if (tableStarts.has(i)) {
      flush();
      const end = tableStarts.get(i);
      blocks.push(emitTable(lines.slice(i, end)));
      i = end;
      continue;
    }
    const line = lines[i];
    const md = emitLine(line, bodyH);
    if (md.startsWith("#")) {
      flush();
      // Merge a heading that wrapped across lines into the previous heading of
      // the same level (same prefix, no paragraph break between them).
      const prefix = md.slice(0, md.indexOf(" ") + 1);
      const prev = blocks[blocks.length - 1];
      if (prev && prev.startsWith(prefix) && !line.para) {
        blocks[blocks.length - 1] = prev + " " + md.slice(prefix.length);
      } else {
        blocks.push(md);
      }
    } else {
      if (line.para) flush();
      para.push(md);
    }
    i++;
  }
  flush();
  return blocks.join("\n\n");
}

function modeHeight(lines) {
  const counts = new Map();
  for (const l of lines) {
    const k = Math.round(l.h);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best = 10;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best || 10;
}

// Runs of >=2 consecutive lines that each have >=2 cells AND look tabular →
// table blocks.
function tableRuns(lines) {
  const starts = new Map();
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const multi = i < lines.length && lines[i].cells.length >= 2;
    if (multi && start === -1) start = i;
    else if (!multi && start !== -1) {
      if (i - start >= 2 && qualifiesAsTable(lines.slice(start, i)))
        starts.set(start, i);
      start = -1;
    }
  }
  return starts;
}

// A run is only a table if its cells are predominantly short or numeric. This
// rejects multi-column prose layouts, whose "cells" are long running text that
// would otherwise be mangled into a table.
const TABLE_CELL_MAXLEN = 16;
function isTabularCell(text) {
  return text.length <= TABLE_CELL_MAXLEN || /^[\d.,%+\-()/\s]+$/.test(text);
}
function qualifiesAsTable(rows) {
  let total = 0;
  let tabular = 0;
  for (const r of rows) {
    for (const c of r.cells) {
      total++;
      if (isTabularCell(c.text)) tabular++;
    }
  }
  return total > 0 && tabular / total >= 0.7;
}

function emitTable(rows) {
  const ncol = Math.max(...rows.map((r) => r.cells.length));
  const toRow = (cells) => {
    const out = cells.map((c) => c.text);
    while (out.length < ncol) out.push("");
    return "| " + out.join(" | ") + " |";
  };
  const md = [toRow(rows[0].cells), "| " + Array(ncol).fill("---").join(" | ") + " |"];
  for (let i = 1; i < rows.length; i++) md.push(toRow(rows[i].cells));
  return md.join("\n");
}

function emitLine(line, bodyH) {
  const text = line.cells.map((c) => c.text).join(" ");
  if (line.cells.length === 1 && text.length > 0 && text.length < HEADING_MAX_LEN) {
    const ratio = line.h / bodyH;
    for (const [threshold, prefix] of HEADING_LEVELS) {
      if (ratio >= threshold) return prefix + text;
    }
  }
  return text;
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
