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

// The operator-list scan (image counting) is the heavy half of analysis; text
// extraction is comparatively cheap. Documents beyond this page count get
// their operator lists *sampled* instead of scanned page-by-page, so a
// several-hundred-page PDF doesn't block the tab for minutes after the drop.
// Shared with the Node inspector and tests.
export const MAX_ANALYZE_PAGES = 150;

// Above the ceiling, scan every Nth page's operator list (pages 1, 6, 11, …).
export const IMAGE_SAMPLE_INTERVAL = 5;

// Whether page n (1-based) of a pageCount-page document should get an
// operator-list scan. Below the ceiling every page is scanned (unchanged
// behavior); above it, one page per sampling interval.
export function shouldScanImages(n, pageCount) {
  return pageCount <= MAX_ANALYZE_PAGES || n % IMAGE_SAMPLE_INTERVAL === 1;
}

// Fill unscanned image counts (images === null) with the nearest scanned
// page's count. Charts cluster in sections, so nearest-neighbour fill
// extrapolates the local density: a sampled chart page marks its unscanned
// neighbours chart-like too, keeping chartPages proportionate to what a full
// scan would find. Fully-scanned input passes through unchanged.
export function extrapolateImages(perPage) {
  const scanned = [];
  perPage.forEach((p, i) => {
    if (p.images != null) scanned.push(i);
  });
  if (scanned.length === perPage.length) return perPage;
  return perPage.map((p, i) => {
    if (p.images != null) return p;
    let nearest = null;
    for (const s of scanned) {
      if (nearest === null || Math.abs(s - i) < Math.abs(nearest - i))
        nearest = s;
    }
    return { ...p, images: nearest === null ? 0 : perPage[nearest].images };
  });
}

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

// Column-detection thresholds:
//   V_GUTTER        a column gutter must be at least this many median heights
//                   wide (measured among narrow rows only, so a full-width
//                   heading bridging the gutter doesn't hide it)
//   MIN_COL_HEIGHT  the column rows must span at least this many median heights,
//                   so a short table is not mistaken for tall body columns
//   MIN_COL_ROWS    need at least this many two-column rows to attempt a split
//   GAP_FLUSH       a vertical gap this many median heights tall ends a column
//                   block, so a short heading below the columns isn't pulled
//                   into one of them
const V_GUTTER = 1.0;
const MIN_COL_HEIGHT = 8;
const MIN_COL_ROWS = 4;
const GAP_FLUSH = 1.8;

// Reconstruct lines from positioned glyph runs. pdf.js gives each run a
// transform matrix ([4]=x, [5]=y, origin bottom-left so larger y is higher).
//
// Glyphs are first partitioned into reading-order regions by column detection
// (rows straddling the gutter are full-width separators; other rows are split
// at the gutter), so multi-column layouts read column-by-column instead of
// interleaving. Each region is then grouped into lines and split into cells.
// Single-column pages have no gutter, so they fall through as one region and
// read exactly as before.
//
// Limitations:
//   - A page dominated by a large chart/figure can pollute the gutter vote.
//     Such pages are image-heavy, so the classifier routes them to passthrough
//     anyway; pages that actually convert reflow correctly. (Interleaves, as
//     before.)
//   - A very short two-column fragment (a page-break remainder with only a
//     couple of rows) falls below the detection guards on its own. Multi-page
//     callers mitigate this by threading the previous page's gutter through
//     reconstructPage — the fragment inherits it when its rows agree. A
//     fragment on page 1 (or after a full-width page) still interleaves.
//
// Returns line objects: { y, h, para, cells: [{ text, x, endX }] }.
export function reconstructLines(items) {
  return reconstructPage(items).lines;
}

// Single-page reconstruction with cross-page column context. `columnHint` is
// the gutter x the previous page used (or null). Returns { lines, gutter }:
// callers converting multi-page documents thread `gutter` into the next
// page's call, which is what lets a short page-break remainder keep reading
// column-first (see columnRegions).
export function reconstructPage(items, columnHint = null) {
  const glyphs = items.filter(
    (it) => typeof it.str === "string" && it.str.length
  );
  if (!glyphs.length) return { lines: [], gutter: null };

  // An aligned grid (a bordered/columnar table) must be read row-major and
  // rebuilt cell-by-cell at its column bands — column-splitting it (below)
  // reads it column-major and scrambles the row bindings. Detected first so it
  // takes precedence over the prose column-reflow path.
  const grid = detectGrid(glyphs);
  if (grid) {
    const yTop = Math.max(...grid.rows.map((r) => r.y1));
    const yBot = Math.min(...grid.rows.map((r) => r.y0));
    // The prose above/below the grid still deserves the full reconstruction —
    // WHO-doc p17 is two-column body text above a figure's label grid, and
    // assembling those bands as plain y-order lines interleaves the columns.
    // Each band is just a smaller page, so recurse (terminates: the grid's own
    // glyphs are excluded from both bands, so any nested grid is a different,
    // strictly smaller band).
    const above = reconstructPage(
      glyphs.filter((g) => g.transform[5] > yTop + 1),
      columnHint
    );
    const below = reconstructPage(
      glyphs.filter((g) => g.transform[5] < yBot - 1),
      above.gutter ?? columnHint
    );
    return {
      lines: [...above.lines, ...gridLines(grid), ...below.lines],
      gutter: below.lines.length ? below.gutter : above.gutter,
    };
  }

  const boxes = glyphs.map(toBox);
  const { regions, gutter } = columnRegions(boxes, columnHint);
  const med = medianHeight(boxes);

  // columnRegions already carved the page into reading-order regions, emitting
  // each column block as a left region immediately followed by its right region
  // (full-width headings separate stacked blocks into their own regions). Such a
  // left/right pair is ambiguous: independent prose columns (read column-major,
  // the default below) OR a row-aligned table whose cells are long free text
  // (must be read row-major, one row per left/right pair). detectGrid can't see
  // the table — a 2-column table has only 2 aligned starts, below its 3-column
  // floor — and looksTabular can't either, since these cells are long text, not
  // short/numeric. The discriminator is cross-column ROW CORRESPONDENCE: when the
  // two columns split into the same number of paragraph blocks whose tops
  // pairwise align, upgrade the pair to a row-major pipe table. Doing it
  // per-region (not per-page) handles several stacked tables on one page.
  const lines = [];
  let sawTable = false;
  for (let i = 0; i < regions.length; ) {
    // Collect a maximal run of consecutive left-then-right region pairs, then
    // test the combined columns as one table. columnRegions flushes a table into
    // several pairs at wide row gaps (a header row split from its body, or every
    // row split when the rows are widely spaced); merging the run reattaches
    // them so the whole table — header included — is recovered as one unit.
    let j = i;
    const left = [];
    const right = [];
    while (
      j + 1 < regions.length &&
      allLeftOf(regions[j], gutter) &&
      allRightOf(regions[j + 1], gutter)
    ) {
      left.push(...regions[j]);
      right.push(...regions[j + 1]);
      j += 2;
    }
    if (j > i) {
      const table = tableFromColumns(left, right, med);
      if (table) {
        const rowLines = columnTableLines(table);
        if (lines.length && rowLines.length) rowLines[0].para = true;
        lines.push(...rowLines);
        sawTable = true;
        i = j;
        continue;
      }
    }
    // Not a table: emit this one region column-major (its right partner, if any,
    // follows on the next iteration), preserving the existing prose reflow.
    const regionLines = linesFromGlyphs(regions[i].map((b) => b.g));
    // A region boundary (column or block break) is itself a paragraph break.
    if (lines.length && regionLines.length) regionLines[0].para = true;
    lines.push(...regionLines);
    i++;
  }

  // Markers only when nothing upgraded to a clean table. A recognized table is
  // high-fidelity; the markers below flag the cases that stayed column-major —
  // an unrecognized table read column-major, or chart-label soup — exactly as
  // before (this whole branch is unchanged for pages with no detected table).
  if (!sawTable) {
    if (regions.length > 1 && looksTabular(lines)) {
      lines.unshift(lowConfidenceMarker());
    } else if (columnConvergence(lines).score < CONVERGENCE_FLAG_THRESHOLD) {
      lines.unshift(flattenedFigureMarker());
    }
  }
  return { lines, gutter };
}

// --- Aligned-grid tables (geometry-based, Deliverable 1) -------------------
// A bordered/aligned table reads as rows whose content starts at the SAME x
// positions across many rows. We key off that alignment, not cell content, so
// long free-text cells convert fine (unlike qualifiesAsTable, the short-cell
// fallback below). Requires >= 3 aligned columns: two-column prose also aligns
// into two bands when read row-major, so 3 is the smallest count that can't be
// prose.
const GRID_MIN_ROWS = 3;
const GRID_MIN_COLS = 3;
const GRID_X_TOL = 6; // px tolerance for "same" column start

// x positions where a row's content segments begin: the first glyph, plus any
// glyph opening a gap wider than a few word-spaces after the previous.
function segmentStarts(row) {
  const bs = row.boxes.filter((b) => !b.ws).sort((a, b) => a.x0 - b.x0);
  const starts = [];
  let cover = -Infinity;
  for (const b of bs) {
    if (b.x0 - cover > WORD_GAP * row.h * 3) starts.push(b.x0);
    if (b.x1 > cover) cover = b.x1;
  }
  return starts;
}

// 1-D cluster of x positions into bands (cluster means), ascending.
function clusterBands(xs) {
  const bands = [];
  let group = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    if (group.length && x - group[group.length - 1] > GRID_X_TOL) {
      bands.push(group.reduce((s, v) => s + v, 0) / group.length);
      group = [];
    }
    group.push(x);
  }
  if (group.length) bands.push(group.reduce((s, v) => s + v, 0) / group.length);
  return bands;
}

// The longest run of consecutive rows that all begin content at the same
// >= GRID_MIN_COLS bands. Returns { bands, rows } (rows top-to-bottom) or null.
function detectGrid(glyphs) {
  const rows = groupRows(glyphs.map(toBox));
  if (rows.length < GRID_MIN_ROWS) return null;
  const starts = rows.map(segmentStarts);

  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const bands = clusterBands(starts[i]);
    if (bands.length < GRID_MIN_COLS) continue;
    const hits = (s) => bands.every((b) => s.some((x) => Math.abs(x - b) <= GRID_X_TOL));
    let j = i;
    while (j < rows.length && hits(starts[j])) j++;
    if (j - i >= GRID_MIN_ROWS && (!best || j - i > best.rows.length)) {
      best = { bands, rows: rows.slice(i, j) };
    }
  }
  return best;
}

// Which band an x-position belongs to (largest band start at or left of x).
function bandOf(bands, x) {
  let bi = 0;
  for (let k = 0; k < bands.length; k++) if (x >= bands[k] - GRID_X_TOL) bi = k;
  return bi;
}

// Rebuild the grid rows as line objects with one cell per band (flagged
// `grid` so linesToMarkdown emits them as one pipe table). Cells keep their
// text verbatim; glyphs are assigned to bands by x and joined with word
// spacing, so a column whose text nearly fills its width still splits cleanly.
function gridLines(grid) {
  return grid.rows
    .map((row) => {
      const buckets = grid.bands.map(() => []);
      for (const b of row.boxes) {
        if (!b.g.str.trim()) continue;
        buckets[bandOf(grid.bands, b.x0)].push(b);
      }
      const cells = buckets.map((rs, i) => {
        rs.sort((a, b) => a.x0 - b.x0);
        let text = "";
        let cover = -Infinity;
        for (const b of rs) {
          if (text && b.x0 - cover > WORD_GAP * row.h && !/\s$/.test(text)) text += " ";
          text += b.g.str;
          if (b.x1 > cover) cover = b.x1;
        }
        return { text: text.replace(/\s+/g, " ").trim(), x: grid.bands[i], endX: grid.bands[i] };
      });
      return { y: row.y0, h: row.h, para: false, grid: true, cells };
    })
    .filter((l) => l.cells.some((c) => c.text));
}

// Low-confidence signal (Deliverable 2): the caller has just column-split the
// page into >= 2 regions (so >= 2 columns were detected), but that split reads
// column-major and collapses a table's rows. It's a genuine table loss — not a
// prose two-column layout — when the collapsed cells are predominantly short or
// numeric (real prose columns are long running text). Derived from output only.
function looksTabular(lines) {
  const cells = lines
    .filter((l) => !l.grid && !l.marker)
    .flatMap((l) => l.cells);
  if (cells.length < GRID_MIN_ROWS) return false;
  const tabular = cells.filter((c) => isTabularCell(c.text)).length;
  return tabular / cells.length >= 0.6;
}

// --- Two-column long-text tables (row correspondence) ----------------------
// The companion to detectGrid for the case it and looksTabular both miss: a
// two-column table whose cells are long free text. Column count alone can't
// separate it from two-column prose (both split into two bands), and the cells
// are too long for the short/numeric tabular test. What separates them is
// cross-column ROW CORRESPONDENCE — in a table each left entry has a right
// entry whose block *top* sits at the same y (a left cell may wrap to several
// lines; the right cell aligns to the top of that block), so both columns yield
// the same number of vertical blocks with pairwise-aligned tops. Prose columns
// are independent streams whose paragraph blocks neither match in count nor
// align in y. Only attempted after a gutter split (two columns), and only for
// predominantly long-text cells, so short/numeric two-column tables stay on the
// existing conservative (marker) path.
const COLTABLE_MIN_ROWS = 3; // like GRID_MIN_ROWS: fewer can't be told from prose
// Vertical gap (in median heights) that ends one row-block: between a cell's
// wrapped lines the gap is smaller, between table rows it's larger. Wider than a
// cell's line spacing, narrower than typical inter-row spacing.
const COLTABLE_ROW_GAP = 0.8;
const COLTABLE_TOP_TOL = 1.0; // paired cells' tops must align within ~one line
// At least this fraction of the paired cells must be long free text — the case
// looksTabular's short/numeric rule silently misses. Short/numeric 2-column
// tables fall through to the existing marker path instead.
const COLTABLE_MIN_LONG_RATIO = 0.5;

// Group one column's boxes into vertical blocks separated by a gap taller than
// COLTABLE_ROW_GAP median heights. Each block is one table row's cell (its
// wrapped lines stay together). Returns blocks top-to-bottom with their y span.
function columnBlocks(boxes, med) {
  const blocks = [];
  let cur = null;
  let prevBottom = null;
  for (const r of groupRows(boxes)) {
    if (cur && prevBottom - r.y1 <= COLTABLE_ROW_GAP * med) {
      cur.rows.push(r);
      cur.top = Math.max(cur.top, r.y1);
      cur.bottom = Math.min(cur.bottom, r.y0);
    } else {
      cur = { rows: [r], top: r.y1, bottom: r.y0 };
      blocks.push(cur);
    }
    prevBottom = r.y0;
  }
  return blocks;
}

// One block's text: its wrapped lines reconstructed and space-joined.
function blockText(block) {
  const glyphs = block.rows.flatMap((r) => r.boxes.map((b) => b.g));
  return linesFromGlyphs(glyphs)
    .map((l) => l.cells.map((c) => c.text).join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Does a region's non-whitespace content sit entirely on one side of the
// gutter? columnRegions emits genuine column blocks as an all-left region
// followed by an all-right one; a full-width heading straddles the gutter and
// satisfies neither, so it can't be mistaken for half of a table.
function allLeftOf(boxes, gx) {
  return (
    boxes.some((b) => !b.ws) &&
    boxes.every((b) => b.ws || (b.x0 + b.x1) / 2 < gx)
  );
}
function allRightOf(boxes, gx) {
  return (
    boxes.some((b) => !b.ws) &&
    boxes.every((b) => b.ws || (b.x0 + b.x1) / 2 >= gx)
  );
}

// Given a left column's boxes and its right column's boxes (one column block,
// already split by columnRegions), decide whether they form a row-aligned
// long-text table. Returns { rows: [{ left, right, y }] } (top-to-bottom) or
// null to keep the column-major prose reflow.
function tableFromColumns(leftBoxes, rightBoxes, med) {
  const leftBlocks = columnBlocks(leftBoxes.filter((b) => !b.ws), med);
  const rightBlocks = columnBlocks(rightBoxes.filter((b) => !b.ws), med);
  if (
    leftBlocks.length < COLTABLE_MIN_ROWS ||
    leftBlocks.length !== rightBlocks.length
  )
    return null;

  // Every paired row must top-align — the table-vs-prose discriminator.
  const tol = med * COLTABLE_TOP_TOL;
  for (let i = 0; i < leftBlocks.length; i++) {
    if (Math.abs(leftBlocks[i].top - rightBlocks[i].top) > tol) return null;
  }

  // Only the long-text case (what looksTabular misses); short/numeric 2-column
  // tables stay on the existing conservative (marker) path.
  const rows = [];
  let long = 0;
  for (let i = 0; i < leftBlocks.length; i++) {
    const left = blockText(leftBlocks[i]);
    const right = blockText(rightBlocks[i]);
    rows.push({ left, right, y: leftBlocks[i].top });
    if (!isTabularCell(left)) long++;
    if (!isTabularCell(right)) long++;
  }
  if (long / (2 * leftBlocks.length) < COLTABLE_MIN_LONG_RATIO) return null;
  return { rows };
}

// The detected table as grid line objects (one per row, keeping each row's own
// y so it sorts correctly among surrounding headings), so linesToMarkdown emits
// one row-major pipe table with the first row as its header.
function columnTableLines(table) {
  return table.rows.map(({ left, right, y }) => ({
    y,
    h: 10,
    para: false,
    grid: true,
    cells: [
      { text: left, x: 0, endX: 0 },
      { text: right, x: 1, endX: 1 },
    ],
  }));
}

// A visible marker line (sorts to the top of the page, flagged so linesToText
// / the char count ignore it — it's a note, not extracted content).
function markerLine(text) {
  return {
    y: Infinity,
    h: 10,
    para: true,
    marker: true,
    cells: [{ text, x: 0, endX: 0 }],
  };
}

function lowConfidenceMarker() {
  return markerLine(
    "[table extracted with low structural confidence — columns may be misaligned and cell-to-row mapping is unverified]"
  );
}

// Tier 2 marker: the page's text never converged into columns, so it's most
// likely a chart/figure whose labels flattened into scattered fragments. Says
// something different from lowConfidenceMarker (which is about a misaligned
// *table*) — here the structure isn't tabular at all, it's soup.
function flattenedFigureMarker() {
  return markerLine(
    "[figure or chart on this page was flattened into text — labels may be scrambled and any values here are unreliable]"
  );
}

// --- Tier 2: column-clustering convergence (confidence signal, SPEC §3.9) ---
// How cleanly a page's reconstructed content aligns into columns — the same
// computation that rebuilds columns also scores its own confidence. A real
// column position *recurs*: a prose margin, a table column, or either side of
// a two-column layout is where many rows begin. Chart-label soup does the
// opposite — a reconstructed "cell" lands wherever a label happened to sit, so
// each start is at its own lonely x that no other row shares. A low score is
// the fingerprint of a flattened visual whose emitted text is unreliable; a
// high score means the content really settled onto recurring columns.
//
// score ∈ [0,1] = fraction of content-cell starts that land on a *well-
// supported* band (one shared by enough rows to be a genuine column). Scoring
// by support — not by a band count — is deliberate: a top-K-bands measure caps
// a perfectly clean two-column page near 1/K, mistaking multi-column for
// scattered. Under support, every recurring column counts, so clean prose (one
// or two margins) and clean tables (a well-hit band per column) score ~1 while
// label soup (many single-hit bands) scores low. Pure and exported for direct
// unit testing and threshold calibration (wiring is a separate, fidelity-QA'd
// decision — see SPEC §3.9 Tier 2).
//
// Below this many content cells there isn't enough signal to judge; report
// full confidence rather than warn on a sparse fragment.
export const CONVERGENCE_MIN_CELLS = 6;
// A text page scoring below this is treated as a flattened chart/figure and
// gets the flattened-figure marker (wired into reconstructPage). Calibrated on
// a WHO statistics report: confirmed chart-soup pages scored ≤0.49 (including a
// prose-plus-dumbbell-plot page at 0.49 whose chart data was never text),
// clean prose and tables ≥0.95 — so 0.5 catches the soup without flagging good
// content, and errs toward NOT flagging (a page in the unverified 0.5–0.6 band
// is left alone). Tunable.
export const CONVERGENCE_FLAG_THRESHOLD = 0.5;
// Column bands are "the same" within this fraction of the median line height —
// a few characters of jitter around a shared start x.
const CONVERGENCE_TOL_RATIO = 1.5;
// A band counts as a genuine column only if it recurs across at least this
// fraction of the page's content lines (floored at 2 lines). One well-hit
// prose margin, or each column of a table/two-column layout, clears this; a
// lone chart label never does.
const CONVERGENCE_MIN_SUPPORT_RATIO = 0.2;

export function columnConvergence(lines) {
  const content = (lines || []).filter(
    (l) => l && !l.marker && Array.isArray(l.cells) && l.cells.length
  );
  const starts = [];
  let hSum = 0;
  for (const l of content) {
    hSum += l.h || 10;
    for (const c of l.cells) starts.push(c.x);
  }
  if (starts.length < CONVERGENCE_MIN_CELLS) {
    return { score: 1, columns: content.length ? 1 : 0, bands: 0 };
  }
  const tol = (hSum / content.length) * CONVERGENCE_TOL_RATIO;
  const bands = bandSupport(starts, tol);
  const minSupport = Math.max(2, content.length * CONVERGENCE_MIN_SUPPORT_RATIO);
  const strong = bands.filter((b) => b.support >= minSupport);
  const covered = strong.reduce((sum, b) => sum + b.support, 0);
  return { score: covered / starts.length, columns: strong.length, bands: bands.length };
}

// Cluster start-x positions into bands, each { x: mean, support: count },
// sorted by support descending (busiest columns first).
function bandSupport(xs, tol) {
  const groups = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    const last = groups[groups.length - 1];
    if (last && x - last.max <= tol) {
      last.sum += x;
      last.support++;
      last.max = x;
    } else {
      groups.push({ sum: x, support: 1, max: x });
    }
  }
  return groups
    .map((g) => ({ x: g.sum / g.support, support: g.support }))
    .sort((a, b) => b.support - a.support);
}

// Group one region's glyphs into lines + cells (the core reconstruction).
function linesFromGlyphs(glyphs) {
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
      // Running average, so the line's y drifts toward later glyphs. Harmless
      // at current tolerances (same-line matching uses half the line height);
      // switch to a sumY/count mean if that ever tightens.
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

// --- Column detection: partition glyphs into ordered reading regions -------

function toBox(g) {
  const x0 = g.transform[4];
  const y0 = g.transform[5];
  // ws: whitespace-only run. Some PDFs fill the column gutter with space
  // glyphs; those are ignored when measuring gaps so the gutter stays visible,
  // but they're still carried into line reconstruction for word spacing.
  return {
    x0,
    x1: x0 + (g.width || 0),
    y0,
    y1: y0 + (g.height || 10),
    ws: !g.str.trim().length,
    g,
  };
}

// Partition boxes into reading-order regions for a (possibly) two-column page.
// Full-width rows (titles/headings) act as separators between column blocks;
// within a block, narrow rows are split left/right at the gutter. The gutter is
// found among narrow rows only, so a full-width heading bridging it doesn't
// hide it. Returns an ordered list of box-arrays; falls back to [boxes] (single
// region, unchanged behavior) whenever no confident column layout is found.
function columnRegions(boxes, hint = null) {
  const rows = groupRows(boxes);
  const med = medianHeight(boxes);

  let gx = detectGutter(rows, med);

  // Page-break remainder: too short for confident detection, but the previous
  // page established a gutter. Accept it when this page's rows agree — at
  // least two rows with text entirely on each side — so the fragment keeps
  // reading column-first instead of interleaving. A full-width page never
  // agrees (its rows straddle the gutter), so a stale hint is inert there.
  if (gx == null && hint != null && fragmentFitsGutter(rows, hint)) {
    gx = hint;
  }
  if (gx == null) return { regions: [boxes], gutter: null };

  // Walk rows top-to-bottom: a row straddling the gutter (full-width heading or
  // figure) flushes the current column block and is emitted on its own; other
  // rows are divided left/right at the gutter.
  const regions = [];
  let left = [];
  let right = [];
  const flush = () => {
    if (left.length) regions.push(left);
    if (right.length) regions.push(right);
    left = [];
    right = [];
  };
  let prevBottom = null;
  for (const r of rows) {
    // A large vertical gap ends the current column block (e.g. a heading sitting
    // below the columns), so it isn't merged into a column.
    if (prevBottom != null && prevBottom - r.y1 > GAP_FLUSH * med) flush();
    if (rowSpansGutter(r, gx)) {
      flush();
      regions.push(r.boxes);
    } else {
      for (const b of r.boxes) ((b.x0 + b.x1) / 2 < gx ? left : right).push(b);
    }
    prevBottom = r.y0;
  }
  flush();
  return regions.length > 1
    ? { regions, gutter: gx }
    : { regions: [boxes], gutter: null };
}

// Confident same-page gutter detection (the original guards): enough
// two-column rows, spanning enough height that a short table isn't split
// into columns.
function detectGutter(rows, med) {
  if (rows.length < MIN_COL_ROWS) return null;
  // findGutter reads each row's interior gutter gap, so it needs rows that hold
  // both columns (shared baselines). When the columns are typeset on independent
  // baselines — no row holds both — it sees nothing; findGutterByColumnStarts
  // recovers the gutter from the two left-edge bands instead.
  const gx = findGutter(rows, med) ?? findGutterByColumnStarts(rows, med);
  if (gx == null) return null;
  const colRows = rows.filter((r) => !rowSpansGutter(r, gx));
  if (colRows.length < MIN_COL_ROWS) return null;
  const top = Math.max(...colRows.map((r) => r.y1));
  const bottom = Math.min(...colRows.map((r) => r.y0));
  if (top - bottom < MIN_COL_HEIGHT * med) return null;
  return gx;
}

// Fallback gutter detection for columns whose baselines don't line up. Two
// columns on independent baselines (a taller heading in one column offsets its
// grid, or the columns simply start at different y) never share a row, so
// findGutter's per-row gutter gap sees nothing. But the rows then fall into two
// left-edge bands — the left margin, and the right column's start — and the
// gutter sits just left of the right band. Confirmed only when a real vertical
// whitespace corridor separates the columns: each side has enough rows entirely
// on its own side of the gutter, both span enough height, and clear whitespace
// lies between the left content's right edge and the right column's start. A
// single-column page (one band) or a hanging indent (left content crosses the
// candidate, so few rows sit entirely left of it) fails these and stays whole.
function findGutterByColumnStarts(rows, med) {
  const starts = [];
  for (const r of rows) {
    let min = Infinity;
    for (const b of r.boxes) if (!b.ws && b.x0 < min) min = b.x0;
    if (min !== Infinity) starts.push(min);
  }
  if (starts.length < 2 * MIN_COL_ROWS) return null;

  const bands = bandSupport(starts, med)
    .filter((b) => b.support >= MIN_COL_ROWS)
    .sort((a, b) => a.x - b.x);
  if (bands.length < 2) return null;
  const leftBand = bands[0].x;
  const rightBand = bands.find((b) => b.x > leftBand + V_GUTTER * med);
  if (!rightBand) return null;
  const gx = rightBand.x - 1;

  // Measure the columns from rows that sit wholly on one side (a full-width
  // heading straddles gx and is skipped, so it can't collapse the corridor).
  let leftRows = 0;
  let rightRows = 0;
  let leftMaxX1 = -Infinity;
  let rightMinX0 = Infinity;
  let leftTop = -Infinity;
  let leftBot = Infinity;
  let rightTop = -Infinity;
  let rightBot = Infinity;
  for (const r of rows) {
    const content = r.boxes.filter((b) => !b.ws);
    if (!content.length) continue;
    if (content.every((b) => (b.x0 + b.x1) / 2 < gx)) {
      leftRows++;
      for (const b of content) if (b.x1 > leftMaxX1) leftMaxX1 = b.x1;
      leftTop = Math.max(leftTop, r.y1);
      leftBot = Math.min(leftBot, r.y0);
    } else if (content.every((b) => (b.x0 + b.x1) / 2 >= gx)) {
      rightRows++;
      for (const b of content) if (b.x0 < rightMinX0) rightMinX0 = b.x0;
      rightTop = Math.max(rightTop, r.y1);
      rightBot = Math.min(rightBot, r.y0);
    }
  }
  if (leftRows < MIN_COL_ROWS || rightRows < MIN_COL_ROWS) return null;
  if (leftTop - leftBot < MIN_COL_HEIGHT * med) return null;
  if (rightTop - rightBot < MIN_COL_HEIGHT * med) return null;
  if (rightMinX0 - leftMaxX1 < V_GUTTER * med) return null;
  return gx;
}

// Does a short page agree with a carried gutter? At least two rows must have
// non-whitespace text entirely on each side of it.
function fragmentFitsGutter(rows, gx) {
  let both = 0;
  for (const r of rows) {
    if (rowSpansGutter(r, gx)) continue;
    const left = r.boxes.some((b) => !b.ws && b.x1 <= gx);
    const right = r.boxes.some((b) => !b.ws && b.x0 >= gx);
    if (left && right) both++;
  }
  return both >= 2;
}

// A row straddles the gutter (a full-width element) if a non-whitespace glyph
// crosses gx (a space glyph filling the gutter doesn't count).
function rowSpansGutter(row, gx) {
  return row.boxes.some((b) => !b.ws && b.x0 < gx && b.x1 > gx);
}

// The column gutter x, found from the densest cluster of per-row gap *right
// edges* (where the right column begins). That edge is consistent across
// two-column rows even when the left line ends early, whereas the gap midpoint
// shifts; lone gaps from prose or charts scatter and don't cluster. Returns the
// gutter x (just left of the right column) or null.
function findGutter(rows, med) {
  const edges = [];
  for (const r of rows) {
    const g = largestInteriorGap(r.boxes);
    // Judge the gap against the row's own height, so a chart's tiny text can't
    // skew the threshold the way a page-wide median would.
    if (g && g.size >= V_GUTTER * r.h) edges.push(g.end);
  }
  if (edges.length < MIN_COL_ROWS) return null;

  let center = null;
  let bestNear = 0;
  for (const p of edges) {
    const near = edges.filter((q) => Math.abs(q - p) <= med).length;
    if (near > bestNear) {
      bestNear = near;
      center = p;
    }
  }
  if (bestNear < MIN_COL_ROWS) return null;
  const cluster = edges.filter((q) => Math.abs(q - center) <= med);
  const rightStart = cluster.reduce((s, q) => s + q, 0) / cluster.length;
  return rightStart - 1;
}

// Largest interior gap between consecutive non-whitespace glyphs in one row.
// Returns { size, end } where end is the x at which content resumes (the right
// column's left edge for a two-column row).
function largestInteriorGap(boxes) {
  const sorted = boxes
    .filter((b) => !b.ws)
    .sort((a, b) => a.x0 - b.x0);
  if (sorted.length < 2) return null;
  let best = null;
  let cover = sorted[0].x1;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x0 - cover;
    if (gap > 0 && (!best || gap > best.size)) {
      best = { size: gap, end: sorted[i].x0 };
    }
    if (sorted[i].x1 > cover) cover = sorted[i].x1;
  }
  return best;
}

// Group boxes into rows by vertical proximity, top-to-bottom.
function groupRows(boxes) {
  const sorted = boxes
    .slice()
    .sort((a, b) =>
      Math.abs(b.y0 - a.y0) > 2 ? b.y0 - a.y0 : a.x0 - b.x0
    );
  const rows = [];
  for (const b of sorted) {
    const h = b.y1 - b.y0;
    const last = rows[rows.length - 1];
    if (last && Math.abs(b.y0 - last.y0) <= last.h * 0.5) {
      last.boxes.push(b);
      last.x0 = Math.min(last.x0, b.x0);
      last.x1 = Math.max(last.x1, b.x1);
      last.y1 = Math.max(last.y1, b.y1);
      if (h > last.h) last.h = h;
    } else {
      rows.push({ y0: b.y0, y1: b.y1, x0: b.x0, x1: b.x1, h, boxes: [b] });
    }
  }
  return rows;
}

function medianHeight(boxes) {
  const hs = boxes.map((b) => b.y1 - b.y0).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)] || 10;
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
  // Geometry-detected grids (Deliverable 1) emit as tables regardless of cell
  // length; take precedence over the content-based runs above.
  for (let i = 0; i < lines.length; ) {
    if (lines[i].grid) {
      let j = i;
      while (j < lines.length && lines[j].grid) j++;
      tableStarts.set(i, j);
      i = j;
    } else i++;
  }

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

// The document's body-text height: the mode of line heights, weighted by
// text length. Counting lines alone breaks on pages where a figure's label
// soup outnumbers the prose (WHO-doc chart pages: 40+ tiny 5.5pt fragments vs
// ~18 real 9.5pt body lines) — the tiny mode wins and every body paragraph
// looks 1.7× "taller than body", emitting as a heading. Characters vote
// instead: body lines are long, chart labels are short.
function modeHeight(lines) {
  const counts = new Map();
  for (const l of lines) {
    const k = Math.round(l.h);
    const chars = l.cells.reduce((s, c) => s + c.text.length, 0);
    counts.set(k, (counts.get(k) || 0) + chars);
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

// Visible omission marker appended to a page's Markdown when its
// operator-list scan found raster images — evidence in the converted output
// that visuals were dropped there. Pages whose scans were sampled away
// (images unknown) get no marker; the classifier's extrapolation covers the
// decision, but a marker should only assert what was actually seen.
export function appendOmittedImagesNote(pageMarkdown, images, pageNumber) {
  if (!images) return pageMarkdown;
  // The page anchor lets a reader — human or model — connect the marker to
  // an attached figure ("see charts.pdf" footer names document pages) or to
  // the original document.
  const where = pageNumber ? ` — page ${pageNumber}` : "";
  const note = `[${images} image${images === 1 ? "" : "s"} omitted${where}]`;
  return pageMarkdown ? `${pageMarkdown}\n\n${note}` : note;
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
  // Which pages are chart-like (1-based), not just how many: PDF figure
  // extraction renders exactly these pages (pdf-figures.js), so the numbers
  // ride along in the summary. chartPages stays the count for display/tests.
  const chartPageNumbers = [];
  perPage.forEach((p, i) => {
    if (p.chars >= MIN_TEXT_CHARS_PER_PAGE && p.images >= 1) {
      chartPageNumbers.push(i + 1);
    }
  });
  const chartPages = chartPageNumbers.length;
  const totalChars = perPage.reduce((s, p) => s + p.chars, 0);
  const totalImages = perPage.reduce((s, p) => s + p.images, 0);
  const summary = {
    pageCount,
    contentPages,
    chartPages,
    chartPageNumbers,
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
