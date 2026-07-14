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
// false-positives from a single incidental logo on a header page. A single
// page whose image is a SIGNIFICANT figure (figureImages — figure-sized and
// pixel-bearing, raster-gate.js) bypasses this count: significance, not page
// count, is what the threshold was always approximating.
export const MIN_CHART_PAGES_FOR_AMBIGUOUS = 2;

// pdf.js OPS names that paint raster images. Callers map these through their
// own pdfjsLib.OPS table; kept here so the list is defined once.
// ("paintInlineImageXObject" is the real OPS name — the earlier
// "paintInlineImage" resolved to undefined, so inline images were silently
// uncounted; pinned by a test against the installed build's OPS table.)
export const IMAGE_OP_NAMES = [
  "paintImageXObject",
  "paintInlineImageXObject",
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
// scan would find. figureImages (the significance signal) rides along the
// same way. Fully-scanned input passes through unchanged.
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
    if (nearest === null) return { ...p, images: 0 };
    const src = perPage[nearest];
    return { ...p, images: src.images, figureImages: src.figureImages };
  });
}

// Non-whitespace character count — the whitespace-agnostic text measure.
export function countChars(text) {
  const m = text.match(/\S/g);
  return m ? m.length : 0;
}

// --- Repeated text furniture (running headers, footers, nav rails) ----------
// Interactive/designed PDFs print the same chrome on every page: a running
// header, and — the Discovery-report case — a navigation rail whose dozen
// section labels sit at identical positions on all 30+ pages. Reconstructed
// as content, that rail interleaves into the body columns of every single
// page (often gluing onto body words with no space). The signal that makes it
// furniture is exact repetition: the same text at the same position on many
// pages. Real content — including a page number, whose text changes per page
// — never repeats positionally like that.
//
// Detection is a two-pass document-scope job with per-page state, so it's a
// factory: feed every page's getTextContent items through addPage(), then ask
// for the furniture key set and filter each page's items through
// stripFurniture() before reconstruction. Streaming counts (never the items)
// keeps memory flat on huge documents.

// A (text, position) pair must recur on at least this many pages AND this
// fraction of the document's pages to be furniture. The fraction keeps a
// paragraph that happens to repeat in a short document (a 3-page doc's
// disclaimer) from being stripped; the floor keeps 2-page docs out entirely
// (nothing can repeat 3 times in 2 pages).
export const FURNITURE_MIN_PAGES = 3;
export const FURNITURE_PAGE_FRACTION = 0.3;
// Positions are quantized to this many pt so sub-point placement jitter
// between pages still buckets together. Coarser would start colliding
// distinct lines (body leading is ~12pt).
export const FURNITURE_POS_QUANTUM_PT = 2;

const furnitureKey = (item) => {
  const str = typeof item.str === "string" ? item.str.replace(/\s+/g, " ").trim() : "";
  if (!str) return null;
  const q = FURNITURE_POS_QUANTUM_PT;
  return `${Math.round(item.transform[4] / q)}:${Math.round(item.transform[5] / q)}:${str}`;
};

export function createFurnitureDetector() {
  const counts = new Map();
  let pages = 0;
  return {
    addPage(items) {
      pages++;
      const seen = new Set();
      for (const it of items ?? []) {
        const k = furnitureKey(it);
        if (!k || seen.has(k)) continue; // count once per page
        seen.add(k);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
    },
    // The keys that qualify as furniture over everything added so far.
    keys() {
      const threshold = Math.max(
        FURNITURE_MIN_PAGES,
        Math.ceil(pages * FURNITURE_PAGE_FRACTION)
      );
      const out = new Set();
      for (const [k, c] of counts) if (c >= threshold) out.add(k);
      return out;
    },
  };
}

// One page's items with the furniture removed. An empty/absent key set is a
// no-op, so callers can wire this unconditionally.
export function stripFurniture(items, keys) {
  if (!keys?.size) return items;
  return items.filter((it) => {
    const k = furnitureKey(it);
    return !k || !keys.has(k);
  });
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

// Baseline quantum (pt) for line-ordering sorts: glyphs whose baselines round to
// the same bucket are ordered left-to-right; different buckets order top-to-
// bottom. A fixed grid keeps the comparator a total order (unlike a pairwise
// "within Npt" window, which is intransitive). Grouping loops still apply a
// half-height tolerance, so a line straddling a bucket edge is merged anyway.
const LINE_BUCKET = 2;

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

// N-column generalization: after the page splits at its primary gutter, each
// side may itself hold several side-by-side streams (designed reports run 3–4
// columns per page, sometimes a sidebar panel beside those), so each
// non-table region gets recursive split attempts up to this nesting depth.
// Depth 2 reaches a panel nested two levels in (page → band → prose|panel);
// deeper only multiplies the chances of slicing a table. A candidate
// sub-gutter alone is NOT enough to accept a split at any level (an unguarded
// depth-2 recursion over-split tables and garbled scans across the corpus);
// the guard is acceptSubSplit below.
const COLUMN_SPLIT_MAX_DEPTH = 2;
// Guard thresholds for a nested split (calibrated on the 6-doc corpus):
//   SUBSPLIT_MIN_CELLS   too few content cells and there's no evidence either
//                        way — keep the region whole rather than gamble
//   SUBSPLIT_DEGRADE_TOL the split may not lower the region's convergence by
//                        more than this (over-splits crater it: a table read
//                        column-major, a scan's noise split at random)
//   SUBSPLIT_SCORE_GAIN  a convergence rise this big counts as measurable
//                        improvement on its own
//   SUBSPLIT_MULTI_DROP  ...as does this drop in the fraction of multi-cell
//                        lines: two streams sharing baselines read as 2-cell
//                        interleaved lines, and a correct split turns them
//                        into single-cell prose
//   SUBSPLIT_GLUE_FRAC   ...as does this fraction of whole-region lines whose
//                        cell text runs straight across the sub-gutter: two
//                        streams set so tight that no gap registers read as
//                        words glued across the boundary ("goals.health"),
//                        which is direct evidence the whole reading
//                        concatenates unrelated streams
//   SUBSPLIT_DEGRADE_MAX / SUBSPLIT_STRONG_MULTI
//                        convergence can punish a CORRECT split: a sidebar's
//                        ragged labels score worse read honestly than glued
//                        onto a prose margin where every start "converges".
//                        When the interleave evidence is overwhelming (the
//                        multi-cell fraction collapses by STRONG_MULTI), the
//                        split may cost up to DEGRADE_MAX of convergence —
//                        still far under what a real over-split loses (the
//                        rejected corpus over-splits cratered 0.4–0.6)
const SUBSPLIT_MIN_CELLS = 6;
const SUBSPLIT_DEGRADE_TOL = 0.06;
const SUBSPLIT_SCORE_GAIN = 0.05;
const SUBSPLIT_MULTI_DROP = 0.1;
const SUBSPLIT_GLUE_FRAC = 0.15;
const SUBSPLIT_DEGRADE_MAX = 0.1;
const SUBSPLIT_STRONG_MULTI = 0.4;
// How many candidate gutters a region may try before reading whole (each
// rejected candidate is excluded from the next attempt).
const SUBSPLIT_GUTTER_ATTEMPTS = 2;
// A split leaf made (almost) entirely of 1–2 char cells is a symbol rail —
// R/S commitment markers, checkboxes, bullets — whose meaning lives in the
// row pairing with the neighbouring column. Splitting it off orphans every
// symbol from its referent, so such a split is rejected no matter how the
// scores move (the right cut, if any, is a different gutter).
const SUBSPLIT_SYMBOL_MAX_CHARS = 2;
const SUBSPLIT_SYMBOL_RATIO = 0.8;

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
  // takes precedence over the prose column-reflow path. A "grid" whose bands
  // are really the page's column origins (three aligned prose columns pass
  // the aligned-starts test too) is rejected and falls through to column
  // reflow instead — formalizing it would emit prose as a fake pipe table.
  let grid = detectGrid(glyphs);
  if (grid && (gridIsPageColumns(grid, glyphs) || gridWrapsLikeProse(grid)))
    grid = null;
  if (grid) {
    // Exclude the grid's OWN glyphs by identity, then split the rest at the
    // grid's baseline span. The old code split on glyph *edges* (`y1` =
    // baseline + height) with a 1pt slop, which left a dead zone up to one
    // glyph-height tall above the grid: a non-grid line whose baseline fell in
    // (topRowBaseline, y1] landed in NEITHER recursive band nor gridLines, so
    // its text vanished with no marker (e.g. an 8pt caption 10pt above a 12pt
    // table header). detectGrid takes the longest consecutive run of aligned
    // rows, so no non-grid line's baseline sits between the grid's top and
    // bottom baselines — every remaining glyph is cleanly above yTop or below
    // yBot. Excluding grid glyphs by set keeps the recursion strictly smaller
    // (so it terminates) regardless of per-glyph baseline jitter.
    const gridGlyphs = new Set(grid.rows.flatMap((r) => r.boxes.map((b) => b.g)));
    const yTop = Math.max(...grid.rows.map((r) => r.y0));
    const yBot = Math.min(...grid.rows.map((r) => r.y0));
    // The prose above/below the grid still deserves the full reconstruction —
    // WHO-doc p17 is two-column body text above a figure's label grid, and
    // assembling those bands as plain y-order lines interleaves the columns.
    // Each band is just a smaller page, so recurse.
    const above = reconstructPage(
      glyphs.filter((g) => !gridGlyphs.has(g) && g.transform[5] > yTop),
      columnHint
    );
    const below = reconstructPage(
      glyphs.filter((g) => !gridGlyphs.has(g) && g.transform[5] < yBot),
      above.gutter ?? columnHint
    );
    return {
      lines: [...above.lines, ...gridLines(grid), ...below.lines],
      gutter: below.lines.length ? below.gutter : above.gutter,
    };
  }

  const { lines, gutter, sawTable, split } = reconstructColumns(
    glyphs,
    columnHint,
    0
  );

  // Markers only when nothing upgraded to a clean table. A recognized table is
  // high-fidelity; the markers below flag the cases that stayed column-major —
  // an unrecognized table read column-major, or chart-label soup — exactly as
  // before (this whole branch is unchanged for pages with no detected table).
  if (!sawTable) {
    if (split && looksTabular(lines)) {
      lines.unshift(lowConfidenceMarker());
    } else if (columnConvergence(lines).score < CONVERGENCE_FLAG_THRESHOLD) {
      lines.unshift(flattenedFigureMarker());
    }
  }
  return { lines, gutter };
}

// One (sub)page's column reconstruction: split at the gutter, upgrade
// row-corresponding pairs to tables, and give every remaining prose region a
// guarded chance to split again (N-column pages arrive here as a 2-way split
// whose sides still hold 2 streams each). Returns { lines, gutter, sawTable,
// split, parts } — `split` says a gutter split actually happened (what the
// caller's low-confidence marker keys on, formerly regions.length > 1);
// `parts` is the same lines grouped by leaf unit (one column, one table run,
// one separator), which is what the split guard scores: each column must be
// judged against its own line population, or a legitimate short sidebar
// drowns in the page-wide support threshold.
function reconstructColumns(glyphs, hint, depth, exclude = []) {
  const boxes = glyphs.map(toBox);
  const { regions, gutter } = columnRegions(boxes, hint, exclude);
  const med = medianHeight(boxes);
  if (gutter == null) {
    // A gutterless page is one leaf prose stream — give it the same
    // stream-integrity repairs (symbol rails, marginalia) as split leaves.
    const { lines, parts } = leafProse(linesFromGlyphs(glyphs), glyphs);
    return {
      lines,
      gutter: null,
      sawTable: false,
      split: false,
      parts,
    };
  }

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
  const parts = [];
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
        parts.push(rowLines);
        sawTable = true;
        i = j;
        continue;
      }
    }
    // Not a table: emit this one region column-major (its right partner, if any,
    // follows on the next iteration), preserving the existing prose reflow —
    // after offering it one guarded nested split of its own.
    const sub = regionProse(regions[i], depth);
    const regionLines = sub.lines;
    if (sub.sawTable) sawTable = true;
    // A region boundary (column or block break) is itself a paragraph break.
    if (lines.length && regionLines.length) regionLines[0].para = true;
    lines.push(...regionLines);
    parts.push(...sub.parts);
    i++;
  }
  return { lines, gutter, sawTable, split: true, parts };
}

// One prose region's lines, with (at most COLUMN_SPLIT_MAX_DEPTH) recursive
// column-split attempts. The nested split is accepted only when acceptSubSplit
// finds it measurably better than reading the region whole — a candidate
// gutter alone routinely exists inside tables and noisy scans, and splitting
// those reads them column-major and scrambles them. A nested tableFromColumns
// upgrade is trusted as-is: row correspondence is stronger evidence than any
// after-the-fact score.
function regionProse(regionBoxes, depth) {
  const glyphs = regionBoxes.map((b) => b.g);
  const flat = linesFromGlyphs(glyphs);
  if (depth >= COLUMN_SPLIT_MAX_DEPTH)
    return leafProse(flat, glyphs);
  // A region holding three streams offers several candidate gutters, and the
  // densest-vote one isn't always the right first cut (it can be the corridor
  // in front of a symbol rail, whose split orphans the symbols from their
  // referents). A rejected candidate is excluded and the next corridor tried.
  const excluded = [];
  for (let attempt = 0; attempt < SUBSPLIT_GUTTER_ATTEMPTS; attempt++) {
    const sub = reconstructColumns(glyphs, null, depth + 1, excluded);
    if (!sub.split) break;
    if (sub.sawTable || acceptSubSplit(flat, sub)) {
      return { lines: sub.lines, sawTable: sub.sawTable, parts: sub.parts };
    }
    excluded.push(sub.gutter);
  }
  return leafProse(flat, glyphs);
}

// A leaf prose region's final lines: symbol rails re-attached to the entries
// they sit level with, then marginal side-labels pulled out of sentences.
// Both are stream-integrity repairs for a reader that only sees tokens in
// order (the converted document's consumer is an LLM, not an eye): a margin
// label spliced mid-sentence silently corrupts the claim it lands in, and a
// detached symbol row loses its row binding.
function leafProse(flat, glyphs) {
  const railed = railTable(flat, glyphs);
  if (railed) return { lines: railed, sawTable: true, parts: [railed] };
  const lines = extractMarginalia(mergeSymbolRails(flat));
  return { lines, sawTable: false, parts: [lines] };
}

// Rebuild a leaf carrying a LEFT tag rail (letter chips a few points left of
// the text band - see railAdoption) as one row per item: the chip(s) in the
// first cell, the item's wrapped label joined into the second. This is the
// only form in which the tag-to-item binding survives linearization for an
// LLM reader: left in line form, a chip merges into whichever wrapped line it
// happens to sit level with ("related issues in G reviewing capital").
//
// Chips are detected on the RAW GLYPHS, not on reconstructed cells: the
// chip-to-text corridor (~1.5 heights) straddles the cell-merge threshold, so
// depending on a fraction of a point a chip either becomes its own cell or
// welds onto its neighbouring line's text - glyph geometry is stable where
// cell structure is not. Returns rebuilt lines, or null when the leaf shows
// no credible rail.
function railTable(flat, glyphs) {
  if (!glyphs || flat.some((l) => l.marker || l.grid)) return null;
  if (flat.length < RAIL_MIN_TAGS * 2) return null;
  const boxes = glyphs.map(toBox).filter((b) => !b.ws);
  if (!boxes.length) return null;
  const med = medianHeight(boxes);

  // The rail: the tightest start-x cluster of pure-letter chip glyphs.
  const chipCand = boxes
    .filter((b) => RAIL_TAG_RE.test(b.g.str.trim()))
    .sort((a, b) => a.x0 - b.x0);
  if (chipCand.length < RAIL_MIN_TAGS) return null;
  let band = [];
  let best = [];
  for (const b of chipCand) {
    if (band.length && b.x0 - band[band.length - 1].x0 > RAIL_X_TOL * med)
      band = [];
    band.push(b);
    if (band.length > best.length) best = band;
  }
  if (best.length < RAIL_MIN_TAGS) return null;
  const chipSet = new Set(best);
  const railX1 = Math.max(...best.map((b) => b.x1));
  const bandX0 = Math.min(...best.map((b) => b.x0));

  // The other side must be real TEXT — every chip-like box is excluded, not
  // just the winning band. A region holding nothing but two adjacent chip
  // columns (an R-rail beside an S-rail, isolated by a split) must NOT read
  // as a rail annotating a "text" column of letters: emitting it as a table
  // sets sawTable, which would bypass the symbol-rail split veto and accept
  // the very split that orphaned the rail from its entries. No running text
  // may start on the rail band itself, and the band must hug the text band
  // from the left across a corridor of at most RAIL_REACH heights. (ADR-0014
  // documents this exclusion as load-bearing — see the review's H6 note.)
  const rest = boxes.filter((b) => !RAIL_TAG_RE.test(b.g.str.trim()));
  if (!rest.length) return null;
  if (rest.some((b) => Math.abs(b.x0 - bandX0) <= RAIL_X_TOL * med))
    return null;
  const rowStarts = groupRows(rest)
    .map((r) => {
      let min = Infinity;
      for (const b of r.boxes) if (b.x0 < min) min = b.x0;
      return min;
    })
    .sort((a, b) => a - b);
  const textX = medianOf(rowStarts);
  if (railX1 >= textX || textX - railX1 > RAIL_REACH * med) return null;

  // Item blocks: the non-chip glyphs' lines, split at paragraph-sized gaps.
  const lines = linesFromGlyphs(rest.map((b) => b.g));
  const blocks = [];
  let prevY = null;
  for (const l of lines) {
    if (prevY == null || prevY - l.y > PARA_GAP * (l.h || med))
      blocks.push({ top: l.y, bottom: l.y, lines: [l], tags: [] });
    else {
      const cur = blocks[blocks.length - 1];
      cur.lines.push(l);
      cur.bottom = l.y;
    }
    prevY = l.y;
  }
  if (blocks.length < RAIL_MIN_TAGS) return null;

  // Each chip belongs to the block whose y-span contains it (else nearest).
  const chips = best
    .slice()
    .sort((a, b) => b.y0 - a.y0)
    .map((b) => ({ y: b.y0, text: b.g.str.trim() }));
  for (const t of chips) {
    let bestB = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const d =
        t.y > b.top + med
          ? t.y - b.top
          : t.y < b.bottom - med
            ? b.bottom - t.y
            : 0;
      if (d < bestD) {
        bestD = d;
        bestB = b;
      }
    }
    if (bestB) bestB.tags.push(t.text);
  }

  return blocks.map((b) => ({
    y: b.top,
    h: med,
    para: false,
    grid: true,
    cells: [
      { text: b.tags.join(" "), x: 0, endX: 0 },
      {
        text: b.lines
          .map((l) => l.cells.map((c) => c.text).join(" "))
          .join(" ")
          .replace(/\s+/g, " ")
          .trim(),
        x: 1,
        endX: 1,
      },
    ],
  }));
}

function medianOf(nums) {
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 10;
}

// A symbol-only line (1–2-char tokens: R/S commitment letters, checkmarks)
// whose baseline sits within the previous line's vertical band, starting past
// that line's right edge, is the same visual row — an 18pt letters run whose
// baseline offset pushed it past the line-grouping tolerance. Re-attach it as
// trailing cells so the entry keeps its letters ("UN Global Compact R S").
function mergeSymbolRails(lines) {
  const out = [];
  for (const line of lines) {
    const prev = out[out.length - 1];
    const text = line.cells.map((c) => c.text).join(" ");
    if (
      prev &&
      !prev.marker &&
      !prev.grid &&
      !line.marker &&
      !line.grid &&
      SYMBOL_LINE_RE.test(text) &&
      Math.abs(prev.y - line.y) <= Math.max(prev.h, line.h) * 0.5 &&
      line.cells[0].x >= prev.cells[prev.cells.length - 1].endX - 2
    ) {
      prev.cells.push(...line.cells);
      continue;
    }
    out.push(line);
  }
  return out;
}

// Marginal side-labels: a designed page hangs short labels ("Maintaining
// legitimacy", a sidebar tag) off the edge of a prose column, where they
// reconstruct as a trailing cell on a body line and emit spliced into the
// middle of a sentence. The fingerprint is a line whose FIRST cell sits on
// the region's dominant start band while its LAST cell sits on a band almost
// nobody shares. Such cells are lifted out and appended after the region as
// their own block — the sentence reads clean, and the label survives as an
// isolated fragment instead of corrupting a claim. Deliberately conservative:
// only in regions that are otherwise single-stream (few multi-cell lines —
// a genuine two-column table pairs its cells on well-shared bands), only a
// handful of lines, only short alphabetic labels.
const MARGINALIA_MAX_CHARS = 24;
const MARGINALIA_MAX_LINES = 3;
const MARGINALIA_MAX_MULTI_FRAC = 0.25;
// The host line's own text must be genuine running prose — a multi-cell line
// of short fragments ("ST MT" legend tokens, a 4-cell table header) is row
// data whose cells belong together, however weak the last cell's band.
const MARGINALIA_MIN_HOST_CHARS = 30;

function extractMarginalia(lines) {
  const content = lines.filter((l) => !l.marker && !l.grid && l.cells.length);
  if (content.length < 8) return lines;
  const multi = content.filter((l) => l.cells.length >= 2);
  if (!multi.length || multi.length / content.length > MARGINALIA_MAX_MULTI_FRAC)
    return lines;

  const tol =
    (content.reduce((s, l) => s + (l.h || 10), 0) / content.length) *
    CONVERGENCE_TOL_RATIO;
  const bands = [];
  const starts = [];
  for (const l of content) for (const c of l.cells) starts.push(c.x);
  starts.sort((a, b) => a - b);
  for (const x of starts) {
    const last = bands[bands.length - 1];
    if (last && x - last.max <= tol) {
      last.support++;
      last.max = x;
    } else {
      bands.push({ min: x, max: x, support: 1 });
    }
  }
  const supportOf = (x) => {
    for (const b of bands)
      if (x >= b.min - tol && x <= b.max + tol) return b.support;
    return 1;
  };
  const strongMin = Math.max(3, content.length * CONVERGENCE_MIN_SUPPORT_RATIO);

  const hosts = multi.filter((l) => {
    if (l.cells.length !== 2) return false;
    const [first, last] = l.cells;
    return (
      first.text.length >= MARGINALIA_MIN_HOST_CHARS &&
      supportOf(first.x) >= strongMin &&
      supportOf(last.x) <= 2 &&
      last.text.length <= MARGINALIA_MAX_CHARS &&
      /[A-Za-z]/.test(last.text)
    );
  });
  if (!hosts.length || hosts.length > MARGINALIA_MAX_LINES) return lines;

  const extracted = hosts.map((l, i) => {
    const cell = l.cells.pop();
    return { y: l.y, h: cell.domH ?? l.h, para: i === 0, cells: [cell] };
  });
  return [...lines, ...extracted];
}

// The nested-split guard: better-structure evidence, not just a candidate
// gutter. Compares the region read whole vs split on two output-derived
// measures — column convergence (recurring start-x bands; over-splits crater
// it) and the multi-cell line fraction (two streams sharing baselines read as
// interleaved 2-cell lines; a correct split dissolves them into single-cell
// prose). Accepts only when nothing degrades, something measurably improves,
// and the split doesn't read tabular (short/numeric cells split column-major
// are a table being scrambled, not columns being freed).
function acceptSubSplit(flatLines, sub) {
  const before = convergenceOf(flatLines);
  const after = convergenceOf(sub.lines);
  const beforeScore = before.charScore;
  const afterScore = partsCharScore(sub.parts) ?? after.charScore;
  const delta = afterScore - beforeScore;
  const multiDrop =
    multiCellFraction(flatLines) - multiCellFraction(sub.lines);
  const allowedDrop =
    multiDrop >= SUBSPLIT_STRONG_MULTI
      ? SUBSPLIT_DEGRADE_MAX
      : SUBSPLIT_DEGRADE_TOL;
  if (after.cellCount < SUBSPLIT_MIN_CELLS) return false;
  if (sub.parts.some(isSymbolRail)) return false;
  if (delta < -allowedDrop) return false;
  if (looksTabular(sub.lines)) return false;
  return (
    delta >= SUBSPLIT_SCORE_GAIN ||
    multiDrop >= SUBSPLIT_MULTI_DROP ||
    gluedFraction(flatLines, sub.gutter) >= SUBSPLIT_GLUE_FRAC
  );
}

// The split side's coherence: a char-weighted mean of each leaf part's own
// convergence. Judging the concatenation instead systematically punishes
// honest splits — the support threshold scales with the combined line count,
// so a legitimate short column (a sidebar of a dozen entries beside two tall
// prose columns) reads as noise. Parts too small to score are skipped; null
// when nothing is scoreable (caller falls back to the concatenated score).
function partsCharScore(parts) {
  let wSum = 0;
  let sSum = 0;
  for (const part of parts) {
    const conv = convergenceOf(part);
    if (conv.cellCount < SUBSPLIT_MIN_CELLS) continue;
    wSum += conv.totalChars;
    sSum += conv.charScore * conv.totalChars;
  }
  return wSum ? sSum / wSum : null;
}

// Fraction of content lines with a cell whose text runs across the gutter x —
// the glue symptom of two streams set so tight that reconstruction merged
// them into one cell (a full-width heading also crosses, but headings are a
// line or two while glue affects a block). Complements multiCellFraction: a
// wide inter-stream gap makes 2-cell lines, a vanishing one makes glue.
function gluedFraction(lines, gutter) {
  if (gutter == null) return 0;
  const content = lines.filter((l) => !l.marker && l.cells.length);
  if (!content.length) return 0;
  const crossing = content.filter((l) =>
    l.cells.some((c) => c.x < gutter && c.endX > gutter)
  );
  return crossing.length / content.length;
}

// Is this leaf part a symbol rail (see SUBSPLIT_SYMBOL_RATIO)? Grid/table
// parts are exempt: a table upgrade pairs its cells row-major, which is
// exactly what a rail needs.
function isSymbolRail(part) {
  const cells = part
    .filter((l) => !l.marker && !l.grid)
    .flatMap((l) => l.cells);
  if (cells.length < 3) return false;
  const tiny = cells.filter(
    (c) =>
      c.text.replace(/\s+/g, "").length <= SUBSPLIT_SYMBOL_MAX_CHARS
  ).length;
  return tiny / cells.length >= SUBSPLIT_SYMBOL_RATIO;
}

// Fraction of content lines holding 2+ cells — the interleave symptom two
// side-by-side streams leave when read as one region.
function multiCellFraction(lines) {
  const content = lines.filter((l) => !l.marker && l.cells.length);
  if (!content.length) return 0;
  return content.filter((l) => l.cells.length >= 2).length / content.length;
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

// Is a detected "grid" really the page's own column layout? Three (or more)
// aligned prose columns satisfy detectGrid's aligned-starts test exactly as a
// bordered table does — the geometry is identical inside the grid's rows. The
// tell is OUTSIDE them: a real table's interior column positions are private
// to the table (surrounding prose doesn't start text at a table's second
// column), while a prose "grid"'s bands are the page's column origins, where
// rows begin across most of the page height. So: reject the grid when every
// interior band keeps recurring as a segment start beyond the grid's own rows
// and its supporters span most of the page. Formalizing such a grid would
// emit prose as a fake pipe table — and gridLines' floating-box exclusion
// would silently drop the text that doesn't fit the fiction.
const PAGE_COLUMN_MIN_SPAN = 0.6; // of the page's content height
const PAGE_COLUMN_MIN_OUTSIDE_ROWS = 2;

function gridIsPageColumns(grid, glyphs) {
  const rows = groupRows(glyphs.map(toBox));
  const gridTop = Math.max(...grid.rows.map((r) => r.y1));
  const gridBot = Math.min(...grid.rows.map((r) => r.y0));
  const pageTop = Math.max(...rows.map((r) => r.y1));
  const pageBot = Math.min(...rows.map((r) => r.y0));
  const pageSpan = pageTop - pageBot;
  if (!(pageSpan > 0)) return false;
  const outsideGrid = (r) => r.y0 > gridTop || r.y1 < gridBot;
  return grid.bands.slice(1).every((band) => {
    const hits = rows.filter((r) =>
      segmentStarts(r).some((x) => Math.abs(x - band) <= GRID_X_TOL)
    );
    if (hits.filter(outsideGrid).length < PAGE_COLUMN_MIN_OUTSIDE_ROWS)
      return false;
    const top = Math.max(...hits.map((r) => r.y1));
    const bot = Math.min(...hits.map((r) => r.y0));
    return top - bot >= PAGE_COLUMN_MIN_SPAN * pageSpan;
  });
}

// The second prose tell, for column layouts too local for the page-columns
// test (a page can change column grid mid-height, so a false table's bands
// may match nothing outside its own rows): prose WRAPS. In N side-by-side
// prose columns, each band's consecutive "cells" are just successive lines of
// one running paragraph — the upper line breaks mid-sentence and the next
// picks up in lowercase ("...enhancing and" / "protecting their lives...").
// A genuine table's vertically adjacent cells are separate entries and don't
// systematically continue each other. Requires both signals: cells long
// enough to be running text, and enough adjacent pairs that read as wraps.
const GRID_PROSE_MIN_LONG_RATIO = 0.5;
const GRID_PROSE_MIN_WRAP_RATIO = 0.25;

function gridWrapsLikeProse(grid) {
  const lines = gridLines(grid);
  const texts = lines.flatMap((l) => l.cells.map((c) => c.text));
  const nonEmpty = texts.filter((t) => t);
  if (!nonEmpty.length) return false;
  const long = nonEmpty.filter((t) => !isTabularCell(t)).length;
  if (long / nonEmpty.length < GRID_PROSE_MIN_LONG_RATIO) return false;
  let pairs = 0;
  let wraps = 0;
  for (let i = 0; i + 1 < lines.length; i++) {
    for (let k = 0; k < grid.bands.length; k++) {
      const upper = lines[i].cells[k]?.text;
      const lower = lines[i + 1].cells[k]?.text;
      if (!upper || !lower) continue;
      pairs++;
      if (!/[.:;!?]$/.test(upper) && /^[a-z]/.test(lower)) wraps++;
    }
  }
  return pairs > 0 && wraps / pairs >= GRID_PROSE_MIN_WRAP_RATIO;
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
//
// Floating text boxes — a chart legend or axis label sitting beside the grid
// (WHO-doc p17: "Change in HALE (years)" at x 438 next to a grid whose last
// band starts at x 285) — share rows with grid content but belong to the
// figure, not the table. Merged in, they shred fragment-by-fragment into
// unrelated data rows. Two exclusions keep them out: a box starting left of
// the first band can't be cell content (every grid row starts a segment at
// every band, detectGrid guarantees it), and within a band's bucket, content
// separated from the cell's covered extent by more than COLUMN_GAP — the same
// gap that would have split it into its own cell in prose reconstruction — is
// a floating box, not a continuation. Their text is dropped: these labels
// belong to the attached figure, and shredding them into rows is worse than
// omitting them.
function gridLines(grid) {
  return grid.rows
    .map((row) => {
      const buckets = grid.bands.map(() => []);
      for (const b of row.boxes) {
        if (!b.g.str.trim()) continue;
        if (b.x0 < grid.bands[0] - GRID_X_TOL) continue;
        buckets[bandOf(grid.bands, b.x0)].push(b);
      }
      const cells = buckets.map((rs, i) => {
        rs.sort((a, b) => a.x0 - b.x0);
        let text = "";
        let cover = -Infinity;
        for (const b of rs) {
          const gap = b.x0 - cover;
          if (text && gap > COLUMN_GAP * row.h) break;
          if (text && gap > WORD_GAP * row.h && !/\s$/.test(text)) text += " ";
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

// Hard corruption signal (Tier 2, SPEC §3.9): C0 control characters in
// extracted text are provably wrong — pdf.js emits raw glyph codes when a
// font has no usable ToUnicode map (WHO-doc p17 put U+001A–U+001F into chart
// "data" cells). One such cell means the whole table's values can't be
// trusted, and a confidently-wrong table is worse than an omission: a linear
// reader can't tell which rows survived. \t/\n/\r never reach cells (line
// reconstruction collapses them); the range below is the C0 set that can.
const C0_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function tableHasCorruptCells(rows) {
  return rows.some((r) => r.cells.some((c) => C0_CONTROL_RE.test(c.text)));
}

// What replaces a corrupt table. The figures flow attaches the actual chart
// page, so the marker points there — by the document's printed page label
// when the caller has one (that's the numbering the attachment's stamps and
// footers speak).
function omittedChartTableNote(pageLabel) {
  const where = pageLabel != null ? `, document page ${pageLabel}` : "";
  return `[chart table omitted — unreliable extraction; see attached figure${where}]`;
}

// Does a page's emitted Markdown carry the omitted-chart-table note? The note
// PROMISES an attached figure, so classification must route the page into the
// figures flow even when it paints no raster (same invariant as
// hasFlattenedFigure — emitted during linesToMarkdown, hence tested on the
// Markdown rather than the lines).
export function hasOmittedChartTable(markdown) {
  return typeof markdown === "string" && markdown.includes("[chart table omitted");
}

// Tier 2 marker: the page's text never converged into columns, so it's most
// likely a chart/figure whose labels flattened into scattered fragments. Says
// something different from lowConfidenceMarker (which is about a misaligned
// *table*) — here the structure isn't tabular at all, it's soup.
function flattenedFigureMarker() {
  // `flattened: true` lets callers see the diagnosis on the page's lines
  // (hasFlattenedFigure) — the page IS a figure, just one that reached us as
  // text soup, so classification can route it into the figures flow.
  return {
    ...markerLine(
      "[figure or chart on this page was flattened into text — labels may be scrambled and any values here are unreliable]"
    ),
    flattened: true,
  };
}

// Did reconstruction flag this page's text as a flattened chart/figure?
// (columnConvergence below CONVERGENCE_FLAG_THRESHOLD — the fingerprint of a
// vector chart whose labels flattened into scattered fragments.) Callers feed
// the answer into classifyDocument as perPage[i].flattened so such pages join
// the figures flow: their text is by definition unreliable, so the attached
// figure is the only trustworthy representation.
export function hasFlattenedFigure(lines) {
  return (lines || []).some((l) => l && l.flattened === true);
}

// Should a convergence-flagged page actually JOIN the figures flow? Only when
// the page shows some visual evidence a figure exists — raster paint
// (`images` ≥ 1) or the colored-fill chart signal. Low convergence alone can
// be an ornate but purely textual layout (a committee org chart, a nav-heavy
// section divider): its every word is already in the Markdown, so attaching
// the page render buys the model nothing. `images` null means the page was
// never scanned (a sampled large doc) — no evidence either way, so the flag
// stands as before. Corrupt-table omissions and vector charts join the flow
// unconditionally (callers OR those in separately): they ARE the evidence.
export function flattenedWithEvidence(flagged, images, vectorChart) {
  return !!vectorChart || (!!flagged && (images == null || images >= 1));
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
// full confidence rather than warn on a sparse fragment. Sized to clear title
// and divider pages, not just near-empty ones: a stack of centered headings
// has non-recurring starts by design (each line begins where its own width
// dictates), so a low floor lets a six-line title page score 0.00 and get
// attached as a flattened chart (the clean-text page-34 regression). Real
// label soup is dozens of scattered fragments — a page with fewer than a
// dozen cells loses almost nothing in text form and isn't worth a page
// attachment, so the floor errs toward NOT flagging (same direction as the
// threshold below).
export const CONVERGENCE_MIN_CELLS = 12;
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
  const conv = convergenceOf(lines);
  if (conv.cellCount < CONVERGENCE_MIN_CELLS) {
    return { score: 1, columns: conv.contentLines ? 1 : 0, bands: 0 };
  }
  return { score: conv.score, columns: conv.columns, bands: conv.bands };
}

// The raw convergence computation, without the min-cells confidence floor.
// columnConvergence (the flagging signal) applies the floor; the nested-split
// guard compares regions that are often smaller than the floor and needs the
// real score either way.
//
// Two coverage ratios come out of the same clustering: `score` counts cells
// (the calibrated document-level signal, unchanged) and `charScore` counts
// characters. The guard compares charScore: a sidebar's one-letter symbol
// cells ("R", "S") land on lonely bands and, counted per-cell, can veto the
// split that honestly separated them — but they're a rounding error of the
// region's characters. Band strength itself stays count-based either way, so
// a genuinely scattered region (label soup, an over-split table) still holds
// most of its characters on weak bands and craters both scores.
function convergenceOf(lines) {
  const content = (lines || []).filter(
    (l) => l && !l.marker && Array.isArray(l.cells) && l.cells.length
  );
  const starts = [];
  let hSum = 0;
  for (const l of content) {
    hSum += l.h || 10;
    for (const c of l.cells) starts.push({ x: c.x, w: c.text?.length || 1 });
  }
  if (!starts.length) {
    return {
      score: 1,
      charScore: 1,
      columns: 0,
      bands: 0,
      cellCount: 0,
      contentLines: 0,
      totalChars: 0,
    };
  }
  const tol = (hSum / content.length) * CONVERGENCE_TOL_RATIO;
  starts.sort((a, b) => a.x - b.x);
  const bands = [];
  for (const s of starts) {
    const last = bands[bands.length - 1];
    if (last && s.x - last.max <= tol) {
      last.support++;
      last.chars += s.w;
      last.max = s.x;
    } else {
      bands.push({ support: 1, chars: s.w, max: s.x });
    }
  }
  const minSupport = Math.max(2, content.length * CONVERGENCE_MIN_SUPPORT_RATIO);
  const strong = bands.filter((b) => b.support >= minSupport);
  const covered = strong.reduce((sum, b) => sum + b.support, 0);
  const totalChars = starts.reduce((sum, s) => sum + s.w, 0);
  const coveredChars = strong.reduce((sum, b) => sum + b.chars, 0);
  return {
    score: covered / starts.length,
    charScore: coveredChars / totalChars,
    columns: strong.length,
    bands: bands.length,
    cellCount: starts.length,
    contentLines: content.length,
    totalChars,
  };
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
//
// Two phases. Phase 1 assigns glyphs to lines in y-then-x order (the same
// clustering rules as always: half-line-height tolerance, running-average y,
// max height). Phase 2 sorts each line's glyphs by x BEFORE forming cells —
// glyphs on one line whose baselines differ slightly (a display heading beside
// a small legend, superscripts, an 18pt symbol letter beside 8pt entry text)
// arrive in y-order, not x-order, and single-pass cell building appended them
// in arrival order, splicing text mid-line ("SignatoryR", "Sclimate change" on
// the Discovery report's heading band). Reading order within a line is x
// order, unconditionally.
function linesFromGlyphs(glyphs) {
  // Quantize the baseline into line buckets, then sort by (bucket desc, x asc).
  // A pairwise "within 2pt → compare by x, else by y" test is intransitive
  // (A~B and B~C by x, yet A vs C by y), so V8's sort order is unspecified and
  // near-threshold baselines could scramble reading order. Bucketing gives a
  // stable total order; the phase-1 tolerance below still merges glyphs that
  // straddle a bucket edge, and phase 2 re-sorts each line by x regardless.
  glyphs.sort((a, b) => {
    const ay = Math.round(a.transform[5] / LINE_BUCKET);
    const by = Math.round(b.transform[5] / LINE_BUCKET);
    if (ay !== by) return by - ay;
    return a.transform[4] - b.transform[4];
  });

  // Phase 1: line assignment. Whitespace-only runs join their line but never
  // extend its y/h — they only matter as word-space hints in phase 2.
  const lines = [];
  for (const g of glyphs) {
    const y = g.transform[5];
    const h = g.height || 10;
    const ws = !g.str.trim().length;
    const last = lines[lines.length - 1];
    const sameLine = last && Math.abs(y - last.y) <= last.h * 0.5;

    if (ws) {
      if (sameLine) last.glyphs.push(g);
      continue;
    }
    if (sameLine) {
      last.glyphs.push(g);
      // Running average, so the line's y drifts toward later glyphs. Harmless
      // at current tolerances (same-line matching uses half the line height);
      // switch to a sumY/count mean if that ever tightens.
      last.y = (last.y + y) / 2;
      if (h > last.h) last.h = h;
    } else {
      const para = last ? last.y - y > last.h * PARA_GAP : false;
      lines.push({ y, h, para, glyphs: [g] });
    }
  }

  // Phase 2: cells, in x order. Whitespace-only runs are not appended and
  // don't advance the cell's right edge — some PDFs fill column gaps with
  // space glyphs, and consuming their width would mask the positional gap that
  // signals a column break. Instead a whitespace run just flags that a space
  // belongs before the next glyph, so real word spacing survives while wide
  // column gaps still register. Each cell also records its char-weighted
  // dominant glyph height (domH): a line's h is the MAX height, which one tall
  // symbol ("R"/"S" commitment letters at 18pt beside 8pt entries) inflates —
  // emission decisions that mean "what size is this text really" read domH.
  for (const line of lines) {
    line.glyphs.sort((a, b) => a.transform[4] - b.transform[4]);
    const cells = [];
    let hh = null; // rounded height -> char count, for the open cell
    let pendingSpace = false;
    const finalize = (cell) => {
      if (!cell) return;
      let domH = null;
      let domChars = 0;
      for (const [k, n] of hh) {
        if (n > domChars) {
          domChars = n;
          domH = k;
        }
      }
      cell.domH = domH ?? line.h;
    };
    let prevH = line.h;
    for (const g of line.glyphs) {
      if (!g.str.trim().length) {
        pendingSpace = true;
        continue;
      }
      const x = g.transform[4];
      const w = g.width || 0;
      const h = g.height || 10;
      const cell = cells[cells.length - 1];
      const gap = cell ? x - cell.endX : Infinity;
      if (!cell || gap > COLUMN_GAP * line.h) {
        finalize(cell);
        hh = new Map();
        cells.push({ text: g.str, x, endX: x + w });
      } else {
        // Word spacing is judged at the scale of the SMALLER adjacent glyph,
        // not the line's tallest: a 34pt display glyph on the line would
        // stretch the space threshold past a real 8pt-text word gap and weld
        // neighbouring small-type words together ("SSignatory").
        const needsSpace =
          (pendingSpace || gap > WORD_GAP * Math.min(prevH, h)) &&
          !/\s$/.test(cell.text) &&
          !/^\s/.test(g.str);
        cell.text += (needsSpace ? " " : "") + g.str;
        if (x + w > cell.endX) cell.endX = x + w;
      }
      const k = Math.round(h);
      hh.set(k, (hh.get(k) ?? 0) + g.str.trim().length);
      prevH = h;
      pendingSpace = false;
    }
    finalize(cells[cells.length - 1]);
    line.cells = cells;
    delete line.glyphs;
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
function columnRegions(boxes, hint = null, exclude = []) {
  const rows = groupRows(boxes);
  const med = medianHeight(boxes);

  let gx = detectGutter(rows, med, exclude);

  // Page-break remainder: too short for confident detection, but the previous
  // page established a gutter. Accept it when this page's rows agree — at
  // least two rows with text entirely on each side — so the fragment keeps
  // reading column-first instead of interleaving. A full-width page never
  // agrees (its rows straddle the gutter), so a stale hint is inert there.
  if (gx == null && hint != null && fragmentFitsGutter(rows, hint)) {
    gx = hint;
  }
  if (gx == null) return { regions: [boxes], gutter: null };

  // Walk rows top-to-bottom: boxes genuinely straddling the gutter
  // (full-width headings, intro paragraphs) collect into spanning regions;
  // other boxes are divided left/right at the gutter.
  //
  // Three refinements over the original all-or-nothing row treatment:
  //   - Straddling is judged per horizontal CLUSTER, not per row. A row's
  //     boxes chain into clusters at the same gap that splits cells
  //     (COLUMN_GAP), so a heading typeset as several adjacent glyph runs
  //     stays one unit — but a crossing cluster no longer drags along a
  //     row-mate a column-gap away ("RELATED COMMITMENTS INCLUDE:", a panel
  //     header outdented across the panel's own gutter, level with a
  //     body-column line, used to pull that line into one full-width region,
  //     gluing the two streams into one emitted line). Only the crossing
  //     cluster leaves; distant row-mates stay in their column streams.
  //   - CONSECUTIVE spanning rows accumulate into ONE region — a full-width
  //     intro paragraph is several spanning rows, and emitting each as its
  //     own region put a paragraph break between every line of it.
  //   - A box must cross by half a median height on each side to count: a
  //     column line overshooting the gutter by a couple of points is a long
  //     line, not a full-width element.
  const spanMargin = med * 0.5;
  const crosses = (b) =>
    !b.ws && b.x0 < gx - spanMargin && b.x1 > gx + spanMargin;
  // Tag-rail adoption: a column of 1–2 LETTER chips hugging the gutter from
  // the left (G/RM/S/MT pillar tags beside each disclosure item) annotates
  // the column on its RIGHT — the gutter vote lands in the wide corridor the
  // sparse rail sits inside, and splitting there divorces every tag from its
  // item. Adopted boxes route right regardless of center.
  const adopted = railAdoption(boxes, gx, med);
  const sideOf = (b) => (adopted.has(b) || (b.x0 + b.x1) / 2 >= gx);
  const regions = [];
  let left = [];
  let right = [];
  let span = [];
  const flush = () => {
    if (left.length) regions.push(left);
    if (right.length) regions.push(right);
    left = [];
    right = [];
  };
  const flushSpan = () => {
    if (span.length) regions.push(span);
    span = [];
  };
  let prevBottom = null;
  for (const r of rows) {
    // A large vertical gap ends the current column block (e.g. a heading sitting
    // below the columns), so it isn't merged into a column.
    if (prevBottom != null && prevBottom - r.y1 > GAP_FLUSH * med) {
      flush();
      flushSpan();
    }
    // Chain the row's content boxes into horizontal clusters; whitespace-only
    // boxes ride with whichever cluster they sit in (nearest by center).
    const content = r.boxes.filter((b) => !b.ws).sort((a, b) => a.x0 - b.x0);
    const clusters = [];
    for (const b of content) {
      const cur = clusters[clusters.length - 1];
      if (cur && b.x0 - cur.x1 <= COLUMN_GAP * r.h) {
        cur.boxes.push(b);
        if (b.x1 > cur.x1) cur.x1 = b.x1;
        cur.x0 = Math.min(cur.x0, b.x0);
      } else {
        clusters.push({ x0: b.x0, x1: b.x1, boxes: [b] });
      }
    }
    for (const b of r.boxes) {
      if (!b.ws || !clusters.length) continue;
      const c = (b.x0 + b.x1) / 2;
      let best = clusters[0];
      for (const cl of clusters) {
        const d = c < cl.x0 ? cl.x0 - c : c > cl.x1 ? c - cl.x1 : 0;
        const bd = c < best.x0 ? best.x0 - c : c > best.x1 ? c - best.x1 : 0;
        if (d < bd) best = cl;
      }
      best.boxes.push(b);
    }
    // A non-crossing cluster stays in its column stream only when it reads as
    // running text — an independent stream's line. A short/numeric fragment
    // level with a full-width line (a balance-sheet amount beside its long
    // label, a date column beside a crossing header) is that line's ROW DATA,
    // and rides along so the pair still reads row-major. The asymmetry is
    // deliberate: wrongly carrying a fragment glues one token onto a line,
    // wrongly stranding it divorces a whole table column from its labels.
    const clusterText = (cl) =>
      cl.boxes
        .map((b) => b.g.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const spanning = clusters.filter((cl) => cl.boxes.some(crosses));
    if (spanning.length) {
      flush();
      for (const cl of clusters) {
        if (spanning.includes(cl) || isTabularCell(clusterText(cl))) {
          span.push(...cl.boxes);
        } else {
          for (const b of cl.boxes) (sideOf(b) ? right : left).push(b);
        }
      }
    } else {
      flushSpan();
      for (const b of r.boxes) (sideOf(b) ? right : left).push(b);
    }
    prevBottom = r.y0;
  }
  flush();
  flushSpan();
  return regions.length > 1
    ? { regions, gutter: gx }
    : { regions: [boxes], gutter: null };
}

// Confident same-page gutter detection (the original guards): enough
// two-column rows, spanning enough height that a short table isn't split
// into columns. `exclude` lists gutter x positions already tried and rejected
// by the nested-split guard, so a retry can surface the next-best corridor (a
// region holding three streams offers several gutters, and the densest vote
// isn't always the right first cut).
function detectGutter(rows, med, exclude = []) {
  if (rows.length < MIN_COL_ROWS) return null;
  // findGutter reads each row's interior gutter gap, so it needs rows that hold
  // both columns (shared baselines). When the columns are typeset on independent
  // baselines — no row holds both — it sees nothing; findGutterByColumnStarts
  // recovers the gutter from the two left-edge bands instead.
  const gx =
    findGutter(rows, med, exclude) ??
    findGutterByColumnStarts(rows, med, exclude);
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
function findGutterByColumnStarts(rows, med, exclude = []) {
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
  const rightBand = bands.find(
    (b) =>
      b.x > leftBand + V_GUTTER * med &&
      !exclude.some((x) => Math.abs(b.x - 1 - x) <= med)
  );
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

// --- Tag rails: letter chips annotating a column of items -------------------
// Designed matrices (the Discovery report's phased-disclosure spread) tag
// each item with 1-2-letter pillar chips (G/RM/S/MT) set in a narrow rail a
// few points LEFT of the item text. The rail is sparse - one chip per
// multi-line item - so gutter votes land in the wide corridor the rail sits
// inside and split the rail away from its items, orphaning every tag.
//
// A rail is only believed on strong shape evidence: at least RAIL_MIN_TAGS
// pure-letter chips whose start x agrees within half a median height (chips
// are set flush; stray 1-2-letter WORDS ending lines scatter), whose band no
// running text shares, sitting within RAIL_REACH median heights of what they
// annotate. Letters only - bullets, dashes and list numbers must not read as
// tag rails.
const RAIL_TAG_RE = /^[A-Za-z]{1,2}$/;
const RAIL_MIN_TAGS = 3;
const RAIL_REACH = 3; // xmed: max corridor between rail band and its column
const RAIL_X_TOL = 0.5; // xmed: chip start-x agreement within the band

// The boxes forming a tag rail that hugs gutter `gx` from the left - they
// annotate the RIGHT column and must travel with it when the region splits.
function railAdoption(boxes, gx, med) {
  const out = new Set();
  // A chip with content close on its LEFT on the same row is a TRAILING
  // anchor of the left column (a footnote letter after its line), not a
  // leading tag of the right one: a real rail chip sits in open corridor
  // space, far from any left neighbour.
  const closeLeft = (chip) =>
    boxes.some(
      (b) =>
        !b.ws &&
        b !== chip &&
        b.x1 <= chip.x0 &&
        chip.x0 - b.x1 <= RAIL_REACH * med &&
        b.y0 < chip.y1 &&
        b.y1 > chip.y0
    );
  const cand = boxes
    .filter(
      (b) =>
        !b.ws &&
        RAIL_TAG_RE.test(b.g.str.trim()) &&
        b.x1 <= gx &&
        gx - b.x1 <= RAIL_REACH * med &&
        !closeLeft(b)
    )
    .sort((a, b) => a.x0 - b.x0);
  if (cand.length < RAIL_MIN_TAGS) return out;
  let group = [];
  const flushGroup = () => {
    if (group.length >= RAIL_MIN_TAGS) {
      const bandX0 = Math.min(...group.map((b) => b.x0));
      // Running text starting on the same band means this is a text column's
      // left edge, not a rail of chips.
      const shared = boxes.some(
        (b) =>
          !b.ws &&
          !RAIL_TAG_RE.test(b.g.str.trim()) &&
          Math.abs(b.x0 - bandX0) <= RAIL_X_TOL * med
      );
      if (!shared) for (const b of group) out.add(b);
    }
    group = [];
  };
  for (const b of cand) {
    if (group.length && b.x0 - group[group.length - 1].x0 > RAIL_X_TOL * med)
      flushGroup();
    group.push(b);
  }
  flushGroup();
  return out;
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
// crosses gx (a space glyph filling the gutter doesn't count). `margin`
// (optional) requires the crossing to be real on both sides — a column line
// overshooting the gutter by a couple of points isn't a full-width element.
function rowSpansGutter(row, gx, margin = 0) {
  return row.boxes.some(
    (b) => !b.ws && b.x0 < gx - margin && b.x1 > gx + margin
  );
}

// The column gutter x, found from the densest cluster of per-row gap *right
// edges* (where the right column begins). That edge is consistent across
// two-column rows even when the left line ends early, whereas the gap midpoint
// shifts; lone gaps from prose or charts scatter and don't cluster. Returns the
// gutter x (just left of the right column) or null.
function findGutter(rows, med, exclude = []) {
  const edges = [];
  for (const r of rows) {
    const g = largestInteriorGap(r.boxes);
    // Judge the gap against the row's own height, so a chart's tiny text can't
    // skew the threshold the way a page-wide median would.
    if (g && g.size >= V_GUTTER * r.h) edges.push(g.end);
  }
  const kept = edges.filter(
    (e) => !exclude.some((x) => Math.abs(e - x) <= med)
  );
  return clusterGutterEdges(kept, med);
}

// The densest cluster of gutter right edges → the gutter x, or null.
function clusterGutterEdges(edges, med) {
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
  // Bucketed total order (see linesFromGlyphs): the pairwise "within 2pt" test
  // is intransitive, so quantize the baseline and sort by (bucket desc, x asc).
  // The half-height tolerance in the grouping loop below still merges rows that
  // straddle a bucket edge.
  const sorted = boxes
    .slice()
    .sort((a, b) => {
      const ay = Math.round(a.y0 / LINE_BUCKET);
      const by = Math.round(b.y0 / LINE_BUCKET);
      if (ay !== by) return by - ay;
      return a.x0 - b.x0;
    });
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

// Character-weighted median box height. A plain box-count median breaks on
// pages where a figure's label soup outnumbers the prose (WHO-doc p17: 4.5pt
// median from ~160 tiny chart fragments vs ~40 real 9.5pt body runs), which
// shrinks every med-scaled threshold — GAP_FLUSH fired on an ordinary
// heading-to-body gap and split the column block. Characters vote instead,
// the same principle as modeHeight: body runs are long, chart labels short.
function medianHeight(boxes) {
  const entries = boxes
    .map((b) => ({ h: b.y1 - b.y0, w: b.g?.str?.trim().length ?? 1 }))
    .sort((a, b) => a.h - b.h);
  const total = entries.reduce((s, e) => s + e.w, 0);
  if (!total) return 10;
  let acc = 0;
  for (const e of entries) {
    acc += e.w;
    if (acc * 2 >= total) return e.h || 10;
  }
  return entries[entries.length - 1].h || 10;
}

// Plain text of reconstructed lines — cells space-joined, lines newline-joined.
// Used for the whitespace-agnostic char count that drives classification, so
// that count is unaffected by Markdown decoration.
export function linesToText(lines) {
  return lines.map((l) => l.cells.map((c) => c.text).join(" ")).join("\n");
}

// Render reconstructed lines to Markdown: font-size headings, conservative
// tables (clear multi-row/multi-column grids), and paragraph breaks.
// `pageLabel` (optional) is the document's printed label for this page; it
// anchors the corrupt-table omission marker to the attached figure.
export function linesToMarkdown(lines, pageLabel = null) {
  if (!lines.length) return "";
  const bodyH = modeHeight(lines);
  lines = extractDisplayBands(lines, bodyH);
  const tableStarts = tableRuns(lines, bodyH); // Map<startIndex, endIndex>
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
      const rows = lines.slice(i, end);
      if (tableHasCorruptCells(rows)) {
        // Adjacent corrupt tables (a figure often flushes as several runs)
        // collapse into one marker instead of stacking identical notes.
        const note = omittedChartTableNote(pageLabel);
        if (blocks[blocks.length - 1] !== note) blocks.push(note);
      } else {
        blocks.push(emitTable(rows));
      }
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
    for (const c of l.cells) {
      // Per-cell dominant height where available: a line's h is its MAX
      // glyph height, which a single tall symbol on the line inflates — the
      // cell's own text shouldn't vote for that symbol's size.
      const k = Math.round(c.domH ?? l.h);
      counts.set(k, (counts.get(k) || 0) + c.text.length);
    }
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
function tableRuns(lines, bodyH) {
  const starts = new Map();
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const multi = i < lines.length && lines[i].cells.length >= 2;
    if (multi && start === -1) start = i;
    else if (!multi && start !== -1) {
      const run = lines.slice(start, i);
      if (i - start >= 2 && qualifiesAsTable(run) && !isDisplayHeightRun(run, bodyH))
        starts.set(start, i);
      start = -1;
    }
  }
  return starts;
}

// A run whose rows sit at display-heading height, not body height, isn't a
// table — it's disparate display elements (a section heading beside a legend
// beside a nav rail) that a tall heading glyph vacuumed onto shared lines, so
// their short fragments read as multi-cell "rows" (Discovery report p6:
// "Our position on"/"KEY:" + "Reporting"/"SignatoryR" at ~4x body height).
// Real short/numeric tables are set at body height, and mildly-emphasized
// callouts (a ratio formula at ~1.2x) stay tables too: the threshold is the h1
// heading ratio, so a run only fails when every "cell" is itself heading-sized
// — the exact fingerprint of display text mashed into rows. Keyed on the run's
// median row height so one tall header row over body-height data can't trip it.
const TABLE_MAX_HEIGHT_RATIO = HEADING_LEVELS[0][0]; // h1 ratio (1.8)
function isDisplayHeightRun(rows, bodyH) {
  if (!bodyH) return false;
  const heights = rows.map((r) => r.h || bodyH).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  return median >= TABLE_MAX_HEIGHT_RATIO * bodyH;
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

// Make a cell's text safe to place between pipes: a literal "|" would shift
// every later cell one column right (values mis-mapped to headers — the exact
// "confidently wrong table" failure the corrupt-cell gate guards against), and a
// stray "\n"/"\r" (from a broken ToUnicode map — these evade the C0 gate) would
// split the row across physical lines and break the table for any parser.
function tableCell(text) {
  return String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|");
}

function emitTable(rows) {
  const ncol = Math.max(...rows.map((r) => r.cells.length));
  const toRow = (cells) => {
    const out = cells.map((c) => tableCell(c.text));
    while (out.length < ncol) out.push("");
    return "| " + out.join(" | ") + " |";
  };
  const md = [toRow(rows[0].cells), "| " + Array(ncol).fill("---").join(" | ") + " |"];
  for (let i = 1; i < rows.length; i++) md.push(toRow(rows[i].cells));
  return md.join("\n");
}

// A line of nothing but 1–2-character tokens is symbols — commitment letters
// ("R S"), checkbox marks, bullets — whose display size says nothing about
// document structure. Never a heading, whatever its height.
const SYMBOL_LINE_RE = /^\S{1,2}(?:\s\S{1,2})*$/;

// --- Display bands: headings that share lines with side content -------------
// A display heading set beside smaller side content (Discovery p6: a 34pt
// two-line section heading, an 8pt KEY legend to its right, both vertically
// centered on the same baselines) reconstructs as MIXED lines — each holding
// one heading-height cell and one body-height cell. Emitted as-is they read
// "Our position on KEY:" / "climate change R Reporting S Signatory": the
// heading is spliced line-by-line into the side panel. Print reading order is
// the headline first, then the side content, so a run of such lines is
// rewritten as [the display cells, line by line] + [the body cells, line by
// line] — the display lines then emit (and merge) as a normal heading, and
// the side content follows as its own block.
//
// A cell only counts as display when its own dominant height clears the h1
// heading ratio, it reads as heading text (short, not just symbol tokens —
// an 18pt "R S" rail cell must not be mistaken for a headline), and the line
// also carries body-height content (pure display lines are already handled by
// ordinary heading emission).
function extractableDisplayCell(cell, bodyH) {
  return (
    (cell.domH ?? 0) >= HEADING_LEVELS[0][0] * bodyH &&
    cell.text.length > 0 &&
    cell.text.length < HEADING_MAX_LEN &&
    !SYMBOL_LINE_RE.test(cell.text)
  );
}

function extractDisplayBands(lines, bodyH) {
  const out = [];
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const mixed = (l) =>
      !l.marker &&
      !l.grid &&
      l.cells.some((c) => extractableDisplayCell(c, bodyH)) &&
      l.cells.some((c) => !extractableDisplayCell(c, bodyH));
    if (!mixed(line)) {
      out.push(line);
      i++;
      continue;
    }
    // Maximal run of consecutive mixed lines: one display band.
    let j = i;
    while (j < lines.length && mixed(lines[j])) j++;
    const band = lines.slice(i, j);
    // A headline opens with a capital, digit, or quote. A "display" cell that
    // starts lowercase mid-clause is an artifact of a page whose body-height
    // mode collapsed (tiny-glyph font metrics make ordinary annotations clear
    // the ratio) — pass the band through untouched rather than promote prose
    // fragments to headings. Only the band's FIRST display cell is tested:
    // a genuine heading's continuation lines may be lowercase ("Our position
    // on" / "climate change").
    const first = band[0].cells.find((c) => extractableDisplayCell(c, bodyH));
    if (!/^["“'‘]?[A-Z0-9]/.test(first.text)) {
      for (const l of band) out.push(l);
      i = j;
      continue;
    }
    band.forEach((l, k) => {
      const display = l.cells.filter((c) => extractableDisplayCell(c, bodyH));
      out.push({
        y: l.y,
        h: Math.max(...display.map((c) => c.domH)),
        para: k === 0 ? l.para : false,
        cells: display,
      });
    });
    band.forEach((l, k) => {
      const body = l.cells.filter((c) => !extractableDisplayCell(c, bodyH));
      out.push({
        y: l.y,
        h: Math.max(...body.map((c) => c.domH ?? l.h)),
        para: k === 0,
        cells: body,
      });
    });
    i = j;
  }
  return out;
}

function emitLine(line, bodyH) {
  const text = line.cells.map((c) => c.text).join(" ");
  if (
    line.cells.length === 1 &&
    text.length > 0 &&
    text.length < HEADING_MAX_LEN &&
    !SYMBOL_LINE_RE.test(text)
  ) {
    // The cell's char-weighted dominant height, not the line max: an entry
    // whose 17pt "R S" letters tag along shouldn't read as heading-sized when
    // its own text is body-sized ("The UNEP FI Principles… (PSI) R S").
    const ratio = (line.cells[0].domH ?? line.h) / bodyH;
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

// Visible marker appended to a page's Markdown when the operator-list scan
// found a vector symbol chart (raster-gate.js hasVectorChartFills): the
// chart's values are colored shapes that never reach the text layer, so the
// emitted text is headers and row labels around invisible data. Without the
// note the model reads a half-empty table with no idea anything is missing.
// The note PROMISES an attached figure, so callers must also route the page
// into the figures flow (perPage[i].flattened — same invariant as
// hasOmittedChartTable).
export function appendVectorChartNote(pageMarkdown, pageNumber) {
  const where = pageNumber != null ? ` — page ${pageNumber}` : "";
  const note = `[chart on this page encodes values as colored symbols that are not text — rows here may be missing their values; see attached figure${where}]`;
  return pageMarkdown ? `${pageMarkdown}\n\n${note}` : note;
}

// Decide what to do with a document from its per-page signals.
//
//   perPage: [{ chars: number, images: number, figureImages?: number }]
//
// figureImages (optional) counts the page's images that read as REAL figures
// — figure-sized on the page, actually pixel-bearing (raster-gate.js's
// significance predicate) — as opposed to logos/strips/icons. Entries
// without it behave exactly as before the signal existed.
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
  // Chart pages carrying a SIGNIFICANT image (figureImages ≥ 1): even one
  // such page makes the document worth the ambiguous prompt — the page-count
  // threshold below exists to suppress incidental-logo noise, and a
  // figure-sized, pixel-bearing image is by definition not incidental.
  // Page classes ride along for the figure paths (selectChartPages): when
  // any page carries a flattened chart or a significant figure, only those
  // pages attach — plain image pages are logo/decoration territory — and
  // when a page cap forces a choice, flattened pages (the text is unusable —
  // the figure is the only faithful representation) outrank the rest.
  const flattenedPageNumbers = [];
  const figurePageNumbers = [];
  // Image-only figure pages (a scanned exhibit / full-page figure: significant
  // image, no usable text layer). Tracked apart from figurePageNumbers because
  // the attachment cap treats them differently — their content exists ONLY as
  // the page image, so they are exempt from the cap that governs text-backed
  // figures (selectChartPages). A subset of figurePageNumbers.
  const scanPageNumbers = [];
  let figurePages = 0;
  perPage.forEach((p, i) => {
    // A flattened chart/figure page (perPage[i].flattened — Tier 2 column
    // convergence) is a chart page even with ZERO raster images: a pure
    // vector chart paints no raster, yet its Markdown carries the
    // flattened-figure warning — without attaching the page, the model is
    // told the values are unreliable and given nothing better to read.
    const flattened = p.flattened === true;
    const significant = (p.figureImages ?? 0) >= 1;
    const hasText = p.chars >= MIN_TEXT_CHARS_PER_PAGE;
    // What makes page i a chart page depends on whether it carries usable
    // text. A TEXT page painting any raster is a candidate (an incidental
    // logo is filtered later by significance — selectChartPages). An
    // IMAGE-ONLY page (below the text floor — a scanned exhibit, a full-page
    // figure) qualifies only when it carries a SIGNIFICANT figure: its content
    // exists solely as that image, so dropping it loses the whole page —
    // unlike an incidental image on a text page, whose text still converts. A
    // bare image-only page with no significant figure stays out (that's the
    // document-level passthrough/convert decision's business), as does a
    // flattened marker with no image behind it (nothing to attach).
    const chartPage = hasText ? p.images >= 1 || flattened : significant;
    if (!chartPage) return;
    chartPageNumbers.push(i + 1);
    if (flattened) flattenedPageNumbers.push(i + 1);
    else if (significant) {
      figurePageNumbers.push(i + 1);
      if (!hasText) scanPageNumbers.push(i + 1);
    }
    // The single-figure ambiguity TRIGGER stays text-page-only: one image-only
    // figure shouldn't flip an otherwise-text document into the prompt (a lone
    // scanned insert). MANY image-only figures instead push chartPages past
    // MIN_CHART_PAGES_FOR_AMBIGUOUS and reach the prompt by volume — the
    // scanned-appendix case (a born-digital report with a scanned annex) that
    // must route into the figures flow so the scans attach.
    if (hasText && (significant || flattened)) figurePages++;
  });
  const chartPages = chartPageNumbers.length;
  const totalChars = perPage.reduce((s, p) => s + p.chars, 0);
  const totalImages = perPage.reduce((s, p) => s + p.images, 0);
  const summary = {
    pageCount,
    contentPages,
    chartPages,
    chartPageNumbers,
    flattenedPageNumbers,
    figurePageNumbers,
    scanPageNumbers,
    figurePages,
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
  // Below the page-count threshold, a significant figure still earns the
  // prompt (distinct reason so corpus QA can grade this trigger separately).
  if (figurePages >= 1) {
    return { decision: "ambiguous", reason: "text-with-figure", summary };
  }
  return { decision: "convert", reason: "text-incidental-image", summary };
}

// The chart pages actually worth attaching, at most `cap` of them.
//
// Membership first: when the document has pages with a flattened chart or a
// significant figure, ONLY those attach — they are what made the document
// worth the figures flow. The remaining chartPageNumbers entries are pages
// whose images the significance gate already judged non-figures (a letterhead
// logo, a decorative rule); attaching them buys the model nothing and dilutes
// the real figures. Only when NO page carries stronger evidence (the
// volume-triggered ambiguous case, or callers without the significance
// signal) do plain image pages attach as before — there they are the only
// candidates for whatever the gate may have missed.
//
// Then the cap: taking the FIRST cap pages is wrong for figure-dense
// documents (an annual report is photos from page 3 on: page-order truncation
// fills the attachment with front-matter photos and drops the genuine charts
// at the back of the book), so pages are chosen by figure value instead —
// flattened chart pages first (their extracted text is unreliable, the
// attachment is the only faithful copy), then significant figures — while the
// RETURNED set stays in ascending page order so mini-PDF stamps and the
// association footer read in document order. Every figure path (mini-PDF,
// crops, decodes, page renders) selects through here so they agree on the set.
//
// Image-only scans (scanPageNumbers) are EXEMPT from the cap: a scanned page's
// content exists only as its image — dropping one loses the whole page, with
// no text fallback — so the cap governs only the text-backed figures, which
// stay readable as Markdown even when their render is dropped. This is why a
// born-digital report with a 30-page scanned annex attaches the whole annex;
// an all-scan document never reaches here (it classifies passthrough).
export function selectChartPages(meta, cap) {
  const all = meta?.chartPageNumbers ?? [];
  const flattened = new Set(meta?.flattenedPageNumbers ?? []);
  const figures = new Set(meta?.figurePageNumbers ?? []);
  const scans = new Set(meta?.scanPageNumbers ?? []);
  const strong = all.filter((n) => flattened.has(n) || figures.has(n));
  const pool = strong.length ? strong : all;
  // Scans always attach; the cap applies only to the text-backed remainder.
  const scanPages = pool.filter((n) => scans.has(n));
  const capped = pool.filter((n) => !scans.has(n));
  const rank = (n) => (flattened.has(n) ? 0 : figures.has(n) ? 1 : 2);
  const kept =
    capped.length <= cap
      ? capped
      : capped
          // Stable sort: equal ranks keep page order, so each tier fills
          // front-first.
          .map((n, i) => ({ n, i }))
          .sort((a, b) => rank(a.n) - rank(b.n) || a.i - b.i)
          .slice(0, cap)
          .map((e) => e.n);
  return [...scanPages, ...kept].sort((a, b) => a - b);
}
