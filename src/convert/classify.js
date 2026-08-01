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

// Gap-derived word spacing assumes a space-delimited script. CJK and Thai are
// not: they run words together, and their glyphs are set on a wider advance
// than Latin at the same size, so at heading type the ordinary inter-glyph
// advance clears WORD_GAP * h and a space lands between EVERY ideograph
// ("第 一 章 概 要"). That also costs the line its heading detection, since the
// spaced-out text no longer matches. A gap flanked by two such characters is
// therefore never a word break, whatever its width. A mixed boundary is left
// alone: Japanese prose with inline English ("日本語の中に 英単語 that appear
// inline") reads correctly today and depends on those spaces.
const UNSPACED_RANGES = [
  [0x0e00, 0x0e7f], // Thai
  [0x2f00, 0x2fdf], // Kangxi Radicals
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x30ff], // Hiragana + Katakana
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xac00, 0xd7af], // Hangul syllables
  [0xff00, 0xffef], // Halfwidth and fullwidth forms
];

function isUnspacedScript(cp) {
  return cp != null && UNSPACED_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

// Last code point of a string, reading a surrogate pair as one character.
function lastCodePoint(s) {
  if (!s) return null;
  const cp = s.codePointAt(s.length - 1);
  return cp >= 0xdc00 && cp <= 0xdfff && s.length > 1
    ? s.codePointAt(s.length - 2)
    : cp;
}

// True when the characters on both sides of a gap belong to a non-space-
// delimited script, so no geometric gap between them means a word break.
function unspacedBoundary(before, after) {
  return (
    isUnspacedScript(lastCodePoint(before)) &&
    isUnspacedScript(after ? after.codePointAt(0) : null)
  );
}

// pdf.js makes the same assumption one layer earlier, and gets it wrong the
// same way: it synthesizes a space of its own whenever the advance between two
// glyphs lands in its "space in flow" window (0.1–0.6 of the font size). CJK
// display type is routinely letterspaced by a fraction of an em, so a heading
// arrives from the text layer already blown apart ("第 一 章 概 要") — with the
// knock-on that the line no longer matches as a heading. Those spaces are
// removed here, before anything measures or splits the text.
//
// Only a space with an ISOLATED unspaced-script character on BOTH sides goes.
// That is the letterspaced-run fingerprint, and it spares a genuine CJK word
// space: in "山田 太郎" neither 田 nor 太 stands alone. Spaces BETWEEN pdf.js
// runs are never touched either — they carry the real break in "第一章 概要".
function isolatedUnspacedChar(s, i, outward) {
  if (i < 0 || i >= s.length || !isUnspacedScript(s.codePointAt(i)))
    return false;
  const j = i + outward;
  return j < 0 || j >= s.length || s[j] === " ";
}

function unspaceLetterspacedRun(s) {
  if (!s.includes(" ")) return s;
  let out = "";
  for (let i = 0; i < s.length; i++) {
    if (
      s[i] === " " &&
      isolatedUnspacedChar(s, i - 1, -1) &&
      isolatedUnspacedChar(s, i + 1, 1)
    )
      continue;
    out += s[i];
  }
  return out;
}

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

// A prop text layer: type set so far below a page's readable content that it
// was never meant to be read. An explainer graphic about financial statements
// (public-famous p7) draws miniature statements at 1.6pt purely as visual
// structure for the 9pt commentary around them — 6,971 of the page's 9,431
// characters. That wins modeHeight's character vote outright, making "body"
// 1.6pt, so every readable line measures 4.5x body and emits as an `# ` H1.
// Three clauses, applied at two strictnesses (below). A page's smallest type is
// a prop layer only when ALL of them hold:
//   *_MAX_PT      the winning cohort must be implausible as body type at all.
//                 A ratio test alone cannot tell "the winner is artwork" from
//                 "the page has a big display heading" — ordinary 9pt body under
//                 a 34pt heading is also a 3.8x spread, and demoting THAT reads
//                 a legend as a table.
//   *_RATIO       the readable cohort must be a clear tier taller, not the same
//                 type at a rounding boundary.
//   MIN_SHARE     ...and must hold this share of the page's characters, so a
//                 page that genuinely is almost all fine print, or all props
//                 with no commentary at all, is left alone.
//
// Calibrated against a real false positive rather than in the abstract. WHO
// statistics pages set 4pt chart labels that ARE the data ("1. Diabetes
// mellitus", "AFR" — 1,500+ characters of leading-cause names per page) beside
// 10pt commentary. A 4pt cap with a 2x ratio deleted them, which is far worse
// than the artwork the test was written to drop.
//
// Hence two strictnesses, because the two consumers carry different risk. The
// DROP path (tinyPropCutoff) discards runs, so it demands 3pt and 3x — which
// excludes those WHO pages twice over: 4pt exceeds the cap, and at 3x their
// 10pt commentary stops counting as "clearly taller", taking the share to 0.4%.
// The VOTE path (modeHeight) only re-measures body height, so it can afford 4pt
// and 2x — enough to stop the 4pt miniature statements on public-famous p25/p35
// turning their own commentary into a wall of `# ` H1s, while not touching one
// character of the WHO labels at that same size. A wrong heading level is
// visible and recoverable; a deleted sentence is neither.
const TINY_BODY_MAX_PT = 3;
const TINY_BODY_RATIO = 3;
const TINY_BODY_VOTE_MAX_PT = 4;
const TINY_BODY_VOTE_RATIO = 2;
const TINY_BODY_MIN_SHARE = 0.15;

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
// Crossing the gutter makes a run a CANDIDATE for full-width furniture; these
// decide whether it really is one (see isFurniture in columnRegions). Furniture
// starts at the measure's left edge — headings and paragraphs do, including a
// paragraph's short LAST line, which is why width alone cannot be the test — or
// else covers most of the measure, as a centred banner does.
const SPAN_LEFT_TOL = 2; // median heights of indent tolerance at the margin
const SPAN_WIDE_FRAC = 0.5;

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

// --- Undecodable text layer (Tier 2, SPEC §3.9) ---
// pdf.js maps a glyph to U+FFFD when the font's encoding yields no character
// for it — no usable ToUnicode, no standard-encoding fallback. Private-use
// code points are the same failure in a different hat: the glyph mapped, but
// only into a range whose meaning is the font's private business.
//
// Same root cause as the C0 controls tableHasCorruptCells looks for (a font
// with no usable ToUnicode) but a different symptom and a far wider blast
// radius: C0 junk lands in a few cells of an otherwise-real table, while this
// arrives as whole pages of it. It is also the fingerprint of a specific and
// otherwise invisible figure class — a map or chart drawn with a cartographic
// or symbol font, where the glyphs ARE the artwork. Such a page paints no
// raster and no colored fills, so every other figure signal reads zero while
// its "text" extracts as long runs of U+FFFD carrying no information at all.
const UNDECODABLE_GLYPH_RE = /[\uFFFD\uE000-\uF8FF]/g;

// A page at least this fraction undecodable has a broken text layer: what it
// emits is noise, not content. The threshold sits in an empty valley rather
// than on a slope — across six clean text/chart/table corpus PDFs no page
// reaches even 0.05, while affected pages run 0.41–1.00.
export const GARBLED_TEXT_RATIO = 0.3;
// Below this many non-space characters there isn't enough text to judge; a
// caption fragment carrying one dingbat shouldn't condemn a page.
export const GARBLED_MIN_CHARS = 50;
// At/above this fraction essentially nothing readable survives, so the page
// has no text fallback whatsoever — the same standing as a scanned exhibit,
// and why such pages are exempt from the attachment cap (selectChartPages).
export const GARBLED_TOTAL_RATIO = 0.8;

// How much of what pdf.js extracted for a page is undecodable, and what that
// implies. Pure, and shared: reconstruction strips the noise, classification
// routes the page into the figures flow, and both must reach the same verdict
// from the same raw items.
//   { chars, ratio, garbled, total }
export function textLayerGarble(items) {
  let chars = 0;
  let bad = 0;
  for (const it of items || []) {
    const s = typeof it?.str === "string" ? it.str : "";
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      // Whitespace is encoding-neutral — it survives a broken font map, so
      // counting it would dilute the ratio toward "fine".
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
      chars++;
      if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff)) bad++;
    }
  }
  const ratio = chars ? bad / chars : 0;
  const garbled = chars >= GARBLED_MIN_CHARS && ratio >= GARBLED_TEXT_RATIO;
  return {
    chars,
    ratio,
    garbled,
    total: garbled && ratio >= GARBLED_TOTAL_RATIO,
  };
}

// --- Typographic rules drawn as text (Tier 2, SPEC §3.9) ---
// A ruled line under a column heading is sometimes painted not as a stroke but
// as a long run of one repeated glyph from a symbol font with no usable
// ToUnicode — public-famous p17 underscores each of its comparison table's two
// column headings with 45 and 37 repetitions of U+0002. It is a drawn line
// wearing a text costume, and leaving it in does damage out of all proportion
// to its size:
//   * It sits BETWEEN the heading row and the first data row, so row grouping
//     bridges the two and the first row of data is swallowed by the header
//     ("Preferred Stock <2>x45 Voting Rights Does not vote").
//   * Its control characters then condemn the whole table as corrupt
//     (tableHasCorruptCells), so a clean 7-row grid is replaced by the omitted-
//     chart-table note and the page is attached as a figure it never was.
//
// Dropped rather than marked, unlike the garbled and prop-text strips above:
// those delete text that was *meant* to be read and say so. A rule carries no
// information at all, so removing it loses nothing to announce.
//
// Two conditions, both required, and both narrower than they first look:
//
//   * C0 controls only, never the undecodable set above. Both classes arrive
//     by the same broken-ToUnicode route, but U+FFFD/PUA already has an owner
//     — textLayerGarble measures it per page, marks the loss and strips it —
//     while nothing owns a C0 run except tableHasCorruptCells, which reads it
//     as evidence and condemns the table around it. Widening this to U+FFFD
//     would reach straight into the garbled walls that machinery exists for:
//     messy-scan sets 1,205 homogeneous U+FFFD runs across 31 pages, and
//     deleting them here would compute that page's garble ratio as zero and
//     silently withdraw the marker.
//
//   * The run must be the item's ENTIRE content — one control code repeated
//     end to end. This is what keeps the corruption signal intact: a corrupted
//     *value* has readable characters among its junk, so it can never qualify,
//     and laundering one into a clean-looking wrong number would be far worse
//     than the ruled line this removes.
//
// An aspect-ratio clause (a rule is a thin tile, so narrow for its height)
// looked attractive and was measured out: across the six corpus PDFs ordinary
// text items run down to 0.165 advance-per-character over height, well below
// the 0.33 of p17's rule, so the two populations overlap and the test would
// have deleted real words. Length carries the separation instead, and sits in
// an empty valley — no homogeneous C0 run anywhere in the corpus is shorter
// than 12 characters.
const RULE_RUN_MIN = 8;

// The C0 set tableHasCorruptCells keys on (C0_CONTROL_RE), as a code-point
// test — this runs over raw items, before any text is assembled to match.
function isC0Control(cp) {
  return (
    cp <= 0x08 ||
    cp === 0x0b ||
    cp === 0x0c ||
    (cp >= 0x0e && cp <= 0x1f) ||
    cp === 0x7f
  );
}

// Is this text item a rule rather than text? See RULE_RUN_MIN above.
export function isDrawnRule(item) {
  const s = typeof item?.str === "string" ? item.str.trim() : "";
  if (s.length < RULE_RUN_MIN) return false;
  const cp = s.codePointAt(0);
  if (!isC0Control(cp)) return false;
  for (let i = 1; i < s.length; i++) if (s.codePointAt(i) !== cp) return false;
  return true;
}

// Single-page reconstruction with cross-page column context. `columnHint` is
// the gutter x the previous page used (or null). Returns { lines, gutter }:
// callers converting multi-page documents thread `gutter` into the next
// page's call, which is what lets a short page-break remainder keep reading
// column-first (see columnRegions).
export function reconstructPage(items, columnHint = null) {
  // Both repairs land before anything measures the text, so column detection,
  // grid banding and the char counts all see it as written. Normalization runs
  // first: it turns compatibility lookalikes into the real characters, which is
  // what the letterspacing check then recognizes as an unspaced script. The
  // run's advance width is left alone in both cases — the spacing was really
  // painted, so the box extent stays honest.
  let glyphs = items
    .filter((it) => typeof it.str === "string" && it.str.length)
    // Rules drawn as repeated glyphs go first, before anything measures or
    // groups: their damage (isDrawnRule) is done through row grouping and the
    // corrupt-cell test, both downstream of here.
    .filter((it) => !isDrawnRule(it))
    .map((it) => {
      const str = unspaceLetterspacedRun(normalizeCompatText(it.str));
      return str === it.str ? it : { ...it, str };
    });
  // A broken text layer: the undecodable runs aren't content, they're a font
  // we can't read painting artwork. Dropping them before reconstruction takes
  // the noise out of the output AND stops it polluting column/grid detection
  // for the real text that survives alongside it (a map's captions, a table's
  // page number). The grid-band recursion below re-enters with already
  // stripped glyphs, so this runs once per page and never double-marks.
  const markers = [];
  if (textLayerGarble(glyphs).garbled) {
    markers.push(garbledTextMarker());
    glyphs = glyphs
      .map((g) => {
        const str = g.str.replace(UNDECODABLE_GLYPH_RE, "");
        if (str === g.str) return g;
        // Advance width covers the whole run; keep it proportional to what
        // survived so the surviving text's boxes stay honest.
        return typeof g.width === "number"
          ? { ...g, str, width: (g.width * str.length) / g.str.length }
          : { ...g, str };
      })
      .filter((g) => g.str.trim().length);
  }
  // A prop text layer, same treatment for the same reason: type set below any
  // readable size is artwork, and leaving it in does double damage — it glues
  // onto the readable commentary it sits among ("what the company owns and
  // whatit owes at the report date. Thebalance sheet is always divided into
  // Investment securities, at cost…") and it presents miniature figures as
  // pipe tables, which reads as data the page never claimed to state.
  const propCut = tinyPropCutoff(glyphs);
  if (propCut != null) {
    markers.push(tinyPropTextMarker());
    glyphs = glyphs.filter((g) => Math.round(g.height || 10) > propCut);
  }
  if (!glyphs.length) return { lines: markers, gutter: null };

  // An aligned grid (a bordered/columnar table) must be read row-major and
  // rebuilt cell-by-cell at its column bands — column-splitting it (below)
  // reads it column-major and scrambles the row bindings. Detected first so it
  // takes precedence over the prose column-reflow path. A "grid" whose bands
  // are really the page's column origins (three aligned prose columns pass
  // the aligned-starts test too) is rejected and falls through to column
  // reflow instead — formalizing it would emit prose as a fake pipe table.
  const grid = validGrid(glyphs);
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
    // ...except the glyphs on those rows that are not the grid's own (isAside).
    // They sit between yTop and yBot, so neither recursive band would reach
    // them: without a band of their own they would vanish with no marker.
    const aside = asideGlyphs(grid);
    const gridGlyphs = new Set(
      grid.rows.flatMap((r) => r.boxes.map((b) => b.g)).filter((g) => !aside.has(g))
    );
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
    // The band BESIDE the grid, reconstructed the same way. It follows the
    // table because it is commentary on it — an annotation that points at a
    // worked example reads as an aside wherever it is placed, while
    // interleaving it row by row reads as neither.
    //
    // One margin at a time. A worked example is annotated from both sides, and
    // the two notes are unrelated to each other: run together they offer the
    // column-pair table upgrade a set of pairwise-aligned blocks and emerge as
    // a two-column table welding one margin's sentences to the other's.
    const beside = { lines: [] };
    for (const margin of asideMargins([...aside])) {
      const { lines: marginLines } = reconstructPage(margin);
      // Each margin is its own note; a break keeps one from reading on into
      // the next.
      if (marginLines.length) marginLines[0].para = true;
      beside.lines.push(...marginLines);
    }
    return {
      lines: [
        ...markers,
        ...above.lines,
        ...gridLines(grid),
        ...beside.lines,
        ...below.lines,
      ],
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
  // Sorts above the confidence markers: "this text is unreadable" is the
  // stronger claim, and it explains why what follows looks so thin.
  if (markers.length) lines.unshift(...markers);
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
  // An aligned grid INSIDE one page column. The page-level pass cannot see
  // one: it groups rows across the full page width, so every row of a table
  // sitting in the right-hand column is welded to whatever the left-hand
  // column happens to set at the same baseline, and no run of rows shares a
  // band set any more. public-famous p17 is the case — a 3-column comparison
  // table inside a 2-column page, where page-level detection finds nothing at
  // all and the table falls through to the column-split path, which reads it
  // as two columns and glues each row's label onto its first value.
  //
  // The region is the right scale to ask at, because reconstructPage's grid
  // branch splits the bands above and below the grid and recurses — correct
  // within a column, but across the full page it would strand the FACING
  // column's text at those same baselines in neither band. Delegate to that
  // branch rather than restating it, and only with a grid already in hand: the
  // mutual recursion is finite because the branch it takes never returns here.
  //
  // Confirmed against what came back, not just what was asked: reconstructPage
  // repairs the glyphs before it looks (drawn rules, undecodable runs, prop
  // layers), so the grid this saw is not always the grid it finds. Taking the
  // delegation on trust costs the region its leaf repairs — the symbol-rail and
  // marginalia passes a multi-panel spread depends on — for a table that was
  // never emitted.
  //
  // A leaf carrying a TAG RAIL keeps its own reading (ADR 0014). Both
  // structures are real on a phased-disclosure spread — the chips and their
  // items do line up in bands — but the rail reading is the specific one: it
  // joins each item's wrapped label into one cell and binds the chips beside
  // it, where the grid splits the label across rows at whatever baseline the
  // text broke on.
  if (validGrid(glyphs) && !railTable(flat, glyphs)) {
    const { lines } = reconstructPage(glyphs);
    if (lines.some((l) => l.geom))
      return { lines, sawTable: true, parts: [lines] };
  }
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
// Monotonic rail-table identity — only inequality matters (adjacent leaves
// must not fuse), never the value.
let railTableId = 0;

function railTable(flat, glyphs) {
  if (!glyphs || flat.some((l) => l.marker || l.grid)) return null;
  if (flat.length < RAIL_MIN_TAGS * 2) return null;
  // Injected symbol labels (ADR 0017) are values to bind per row, not page
  // text: they must not vote in rail/text-band detection, and they emit as
  // each row's own value cell below.
  const allBoxes = glyphs.map(toBox).filter((b) => !b.ws);
  const symBoxes = allBoxes.filter((b) => b.g.symbolLabel);
  const boxes = allBoxes.filter((b) => !b.g.symbolLabel);
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
      blocks.push({ top: l.y, bottom: l.y, lines: [l], tags: [], syms: [] });
    else {
      const cur = blocks[blocks.length - 1];
      cur.lines.push(l);
      cur.bottom = l.y;
    }
    prevY = l.y;
  }
  if (blocks.length < RAIL_MIN_TAGS) return null;

  // A chip (or symbol label) belongs to the block whose y-span contains it
  // (else nearest) — chips are vertically centered on their multi-line items,
  // and injected icon labels sit at their icon's center the same way.
  const assign = (y, push) => {
    let bestB = null;
    let bestD = Infinity;
    for (const b of blocks) {
      const d =
        y > b.top + med ? y - b.top : y < b.bottom - med ? b.bottom - y : 0;
      if (d < bestD) {
        bestD = d;
        bestB = b;
      }
    }
    if (bestB) push(bestB);
  };
  for (const t of best.slice().sort((a, b) => b.y0 - a.y0)) {
    assign(t.y0, (b) => b.tags.push(t.g.str.trim()));
  }
  for (const s of symBoxes.sort((a, b) => b.y0 - a.y0)) {
    assign((s.y0 + s.y1) / 2, (b) => b.syms.push(s.g.str.trim()));
  }

  const withSyms = blocks.some((b) => b.syms.length);
  // Table identity + the leaf's x-extent ride on every row: identity keeps
  // side-by-side leaves from fusing into one pipe table in linesToMarkdown,
  // and the extent is what panel-heading rebinding matches stranded heading
  // cells against (rebindPanelHeadings below).
  const tableId = ++railTableId;
  const x0 = Math.min(...allBoxes.map((b) => b.x0));
  const x1 = Math.max(...allBoxes.map((b) => b.x1));
  return blocks.map((b) => ({
    y: b.top,
    h: med,
    para: false,
    grid: true,
    tableId,
    x0,
    x1,
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
      // The decoded icon values (ADR 0017), one column for the whole table so
      // rows without an icon still align under the value header.
      ...(withSyms ? [{ text: b.syms.join(" "), x: 2, endX: 2 }] : []),
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
    // An injected symbol label (ADR 0017) sits on a lonely band by design —
    // it's the row's VALUE, and lifting it out would divorce it exactly the
    // way the decoding exists to prevent.
    if (last.symbol) return false;
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

// A row's content segments: runs of boxes separated by more than a few
// word-spaces. Each carries its extent and its text, so the same pass serves
// both the band geometry and the content tests that key off it.
function rowSegments(row) {
  const bs = row.boxes.filter((b) => !b.ws).sort((a, b) => a.x0 - b.x0);
  const segs = [];
  let cur = null;
  let prev = null;
  for (const b of bs) {
    const h = b.h;
    if (!cur || b.x0 - cur.x1 > WORD_GAP * row.h * 3) {
      cur = { x0: b.x0, x1: b.x1, h, text: b.g.str };
      segs.push(cur);
    } else {
      cur.x1 = Math.max(cur.x1, b.x1);
      cur.h = Math.max(cur.h, h);
      // Two ROTATED runs side by side are two LINES of one vertical label, not
      // two words on one line — a rail reading bottom-to-top sets its second
      // line alongside its first, an em to the right. Along the page's x they
      // abut, so without this they arrive spelled together ("Out ofscopes").
      const line = prev && prev.rot && b.rot && b.x0 >= prev.x1 - GRID_X_TOL;
      cur.text += (line ? " " : "") + b.g.str;
    }
    prev = b;
  }
  return segs;
}

// Type set at a size the row doesn't otherwise use is not part of its grid: a
// chart's axis label or a margin note sits on the table's baselines and would
// otherwise propose a column of its own, which is exactly the fiction gridLines
// then has to exclude text from (a legend at 6pt beside 10pt rows). Judged per
// row against that row's own median, so a table set entirely small is untouched
// and a heading a size or two up still helps place its columns.
const GRID_BAND_MAX_HEIGHT_RATIO = 1.5;

function gridSegments(row) {
  const segs = rowSegments(row);
  if (segs.length < 2) return segs;
  const med = medianOf(segs.map((s) => s.h));
  return segs.filter(
    (s) => s.h > 0 && Math.max(med, s.h) / Math.min(med, s.h) <= GRID_BAND_MAX_HEIGHT_RATIO
  );
}

// x positions where a row's content segments begin.
function segmentStarts(row) {
  return rowSegments(row).map((s) => s.x0);
}

// 1-D cluster of x positions into bands, ascending. A band is reported at its
// LEFT EDGE, not its mean: it names where a column begins, and the column has
// to contain every start that voted for it — a mean sits right of the widest
// entry in a right-aligned column, which would push that entry into the column
// before it.
function clusterBands(xs, tol = GRID_X_TOL) {
  const bands = [];
  let group = [];
  for (const x of [...xs].sort((a, b) => a - b)) {
    if (group.length && x - group[group.length - 1] > tol) {
      bands.push(group[0]);
      group = [];
    }
    group.push(x);
  }
  if (group.length) bands.push(group[0]);
  return bands;
}

// How a row sits against a set of bands. A band is a column's LEFT EDGE and a
// segment belongs to the band it falls in (bandOf), which is how gridLines
// assigns cells — so a row's fit here and its rendering there cannot disagree.
//
// Matching a start to a band by proximity instead (|x - band| <= GRID_X_TOL,
// as this did) only works for columns set flush left. A column of figures is
// set flush RIGHT, so each row's start moves with the width of its own number:
// down one 10pt column of a sustainability report's emissions table the starts
// range over 17pt, three times the tolerance, and no two rows are ever
// "aligned". The band interval absorbs that; what it costs is that everything
// right of the first band lands somewhere, so occupancy — not alignment — is
// what says a row belongs.
//
//   filled    the set of bands the row begins a segment in.
//   occupied  how many, i.e. filled.size.
//   left      segments beginning left of the first band, which are outside the
//             table's column structure altogether.
function bandFit(bands, starts) {
  const filled = new Set();
  let left = 0;
  for (const x of starts) {
    const i = bandOf(bands, x, -1);
    if (i < 0) left++;
    else filled.add(i);
  }
  return { filled, occupied: filled.size, left };
}

// A row is a WRAPPED CONTINUATION of the row above rather than a row of its
// own when it sits at line spacing instead of row spacing. Both kinds of gap
// are present in the same table, so the test is relative to the run's own
// pitch rather than absolute: a table whose rows are uniformly tight has no
// gap below this fraction of its median and merges nothing, while a table that
// double-spaces its rows and single-spaces the wraps inside them separates
// cleanly. public-famous p17 runs 18pt between rows and 10pt inside them.
const GRID_WRAP_RATIO = 0.7;
// ...and no taller, relative to the row it continues, than ordinary variation
// within one cell's type (a cap-height line against one with descenders).
const GRID_WRAP_MAX_HEIGHT_RATIO = 1.2;
// A column-heading row sets no row label, so it is never complete and can
// never be the seed — yet it is the row that names the table. Exactly one such
// row is taken, immediately above the body, and only if it fills at least this
// many bands. One row, because the absorption has to stay this stingy: rows
// that merely *resemble* the table's column structure are also what N-column
// prose is made of, and the only tell separating a page of three prose columns
// from a three-column table is that a table's aligned run is a SLICE of the
// page with unaligned rows around it (gridIsPageColumns). Swallow those rows
// and the evidence goes with them. The band floor is what spares p17's own
// title, which sets one line at the row-label band directly above the header.
const GRID_HEADER_MIN_BANDS = 2;

// A row belongs to the table when it begins content in this fraction of the
// bands. Rows that don't fill every band are the normal case, not the
// exception: a "% Change" column carrying a figure only on total rows leaves
// two rows in three incomplete, and demanding complete rows means such a table
// never forms a run at all. What raggedness must NOT do is let a stray line
// through, so the bar is a majority of the columns — a run of prose beside a
// diagram begins content in one or two of them, never in six of eleven.
const GRID_MIN_FILL = 0.5;
// Rows a run steps over to reach the next row that does belong. A wrapped cell
// leaves one such row (sometimes two, for a three-line cell) and the run has to
// cross it or the table ends at its first wrap. Bounded, and bounded tightly,
// because the growth is what stops the run walking off into the page: prose
// above a table has no belonging row after it, so two steps exhaust the credit
// and growth halts.
const GRID_RUN_BRIDGE = 2;
// ...and only over rows that begin content in ONE band. A row a run steps over
// has to be plainly NOT a row of the table — a cell's second line, a group
// label on its own baseline — because a row that fills a middling share of the
// bands is the one piece of evidence that says the bands aren't a table's at
// all. Two of the reasons are both on the same report: three columns of prose
// break into aligned runs exactly where a paragraph ends in one column, leaving
// a row that fills the other two; and a page that sets a table beside a column
// of body text alternates one row of each, so anything more generous swallows
// the facing column line by line.
const GRID_BRIDGE_MAX_BANDS = 1;

// The longest run of consecutive rows built on one set of column bands.
// Returns { bands, rows, wraps } (rows top-to-bottom, wraps a parallel array of
// booleans marking rows that continue the row above) or null.
//
// A seed row's own segment starts propose the bands; the run then grows over
// rows that fill a majority of them, and the bands are RE-DERIVED from every
// row the run collected. That second step matters as much as the first. One
// row's starts describe the columns only as that row happens to set them —
// under a right-aligned column, a short number and a long one begin 17pt
// apart, and a header label set flush left begins 20pt left of both. Clustering
// the whole run's starts recovers each column's true left edge, so the header
// lands over its own figures instead of one column across.
function detectGrid(glyphs) {
  // Whitespace-only rows are transparent here. They begin no segment, so they
  // are neither a row of the table nor anything else, but a run that stops at
  // one loses whatever lies beyond it — and a table's heading row is routinely
  // separated from its body by exactly such a row, the blank baseline left
  // where a ruled line used to sit (isDrawnRule). Their gaps would also
  // corrupt the wrap pitch, splitting one row spacing into two short ones.
  const rows = groupRows(glyphs.map(toBox)).filter((r) =>
    r.boxes.some((b) => !b.ws && b.g.str.trim())
  );
  if (rows.length < GRID_MIN_ROWS) return null;
  const segs = rows.map(gridSegments);
  const starts = segs.map((ss) => ss.map((s) => s.x0));

  let best = null;
  for (let i = 0; i < rows.length; i++) {
    const cand = gridFromSeed(rows, segs, starts, i);
    if (!cand) continue;
    if (
      !best ||
      cand.rows.length > best.rows.length ||
      (cand.rows.length === best.rows.length &&
        cand.bands.length > best.bands.length)
    )
      best = cand;
  }
  return best;
}

// The grid the row at `seed` proposes, or null.
function gridFromSeed(rows, segs, starts, seed) {
  const proposed = clusterBands(starts[seed]);
  if (proposed.length < GRID_MIN_COLS) return null;
  // `left` — content outside the columns altogether — disqualifies a row only
  // while the bands are still one row's proposal, where it says the proposal
  // has the wrong leftmost column. Against the derived bands it says nothing:
  // gridLines drops such a box as the floating label it is, and the row is
  // otherwise a row of the table.
  const belongs = (bands, strict) => {
    const floor = Math.max(GRID_MIN_COLS, Math.ceil(bands.length * GRID_MIN_FILL));
    return (k) => {
      const f = bandFit(bands, starts[k]);
      return (!strict || f.left === 0) && f.occupied >= floor;
    };
  };
  // Is the leftmost band a RAIL — a column of markers rather than of text? A
  // balance sheet numbers its line items down the left edge, and the rows that
  // carry a label but no figures ("10 Intangibles (goodwill, patents)—",
  // answered on the line below) fill exactly that band and the label band. They
  // have to be crossable or the statement breaks into fragments. What must not
  // be crossable is the same shape made by a facing column of body text, and
  // the two are told apart by what the leftmost band holds: numbers and short
  // markers, or sentences.
  const railFirstBand = (bands, from, to, owns) => {
    const first = [];
    for (let k = from; k <= to; k++) {
      if (!owns(k)) continue;
      for (const s of segs[k])
        if (bandOf(bands, s.x0, -1) === 0) first.push(s.text.trim());
    }
    return first.every((t) => isTabularCell(t));
  };

  // A row a run may step over on its way to the next row that belongs, judged
  // against `ref` — the bands the last belonging row filled.
  const bridgeable = (bands, rail) => (k, ref) => {
    const f = bandFit(bands, starts[k]);
    if (f.occupied <= GRID_BRIDGE_MAX_BANDS) return true;
    // Or it continues that row and starts nothing of its own: it fills only
    // columns that row filled, and sets no row label. A cell that took three
    // lines to set leaves such a row in the middle of a table, and refusing it
    // ends the table there — an asset manager's TCFD risk table breaks after
    // two rows, and the rest of its own rows then read as evidence that its
    // columns are the page's (gridIsPageColumns).
    //
    // The row-label column is what keeps this from swallowing a facing page
    // column: a report that sets body text beside a table alternates one row
    // of each, and every prose line is "within" the table row above it — but
    // it begins at the leftmost band, where a continuation never does. Waived
    // when that band is a rail (railFirstBand), which is the one case where a
    // row of the table itself legitimately begins there.
    return (rail || !f.filled.has(0)) && [...f.filled].every((i) => ref.has(i));
  };
  const seedBelongs = belongs(proposed, true);
  if (!seedBelongs(seed)) return null;

  // Grow to the outermost belonging row in each direction, stepping over at
  // most GRID_RUN_BRIDGE rows at a time. The stepped-over rows come along —
  // they are a wrapped cell's second line, or a group label set on its own
  // baseline beside the row it heads, and dropping them would lose text the
  // page states. What bounds the growth is that the credit is spent unless a
  // belonging row follows: prose above a table has none, so it stops there.
  const reach = (bands, from, dir, owns, min, max) => {
    const spare = bridgeable(bands, railFirstBand(bands, min, max, owns));
    let last = from;
    let ref = bandFit(bands, starts[from]).filled;
    for (let k = from + dir; k >= min && k <= max; k += dir) {
      if (owns(k)) {
        last = k;
        ref = bandFit(bands, starts[k]).filled;
      } else if (!spare(k, ref) || Math.abs(k - last) > GRID_RUN_BRIDGE) break;
    }
    return last;
  };
  const lo = reach(proposed, seed, -1, seedBelongs, 0, rows.length - 1);
  const hi = reach(proposed, seed, 1, seedBelongs, 0, rows.length - 1);
  // The window the run may settle inside. `lo`/`hi` above are where content
  // OUTSIDE the proposal's columns stopped the reach, which is the right test
  // for choosing a seed but far too strict for a boundary: a table's grand
  // totals are outdented past every column the seed can see, so on a
  // sustainability report's emissions table the strict reach halts three rows
  // early and a fixed two-row margin cannot recover them — the last row ended
  // up outside the table with its figures spilled into the footnotes. Take the
  // window from the same reach with that one test dropped, so it is bounded by
  // how many columns a row fills rather than by where the seed's leftmost is.
  const windowed = belongs(proposed, false);
  let padLo = Math.max(
    0,
    reach(proposed, seed, -1, windowed, 0, rows.length - 1) - GRID_RUN_BRIDGE
  );
  let padHi = Math.min(
    rows.length - 1,
    reach(proposed, seed, 1, windowed, 0, rows.length - 1) + GRID_RUN_BRIDGE
  );

  // Derive the bands by clustering every start the run collected, at the
  // spacing that separated segments in the first place — two starts closer
  // than a segment gap are the same column. Rows the run stepped over are
  // included: a section heading set on its own baseline inside a balance sheet
  // ("DEPOSIT LIABILITY", flush left of the line items it covers) begins at an
  // x no other row uses, and a band set that omits it drops its text as a
  // floating box.
  const derive = (from, to) => {
    const runStarts = Array.from({ length: to - from + 1 }, (_, k) => starts[from + k]);
    return mergeBands(
      clusterBands(
        runStarts.flat(),
        WORD_GAP * medianOf(rows.slice(from, to + 1).map((r) => r.h)) * 3
      ),
      runStarts
    );
  };

  // Bands and extent settle each other: the seed's starts were only a proposal,
  // so a row it excluded — a total indented further left than any of its cells
  // — belongs once the columns are known. The second pass is NOT held to the
  // first pass's reach: the proposal's blind spot can be several rows deep (a
  // sustainability report's emissions table ends three rows past where its
  // seed could see, and clipping there left the last row outside the table with
  // its figures spilled into the footnotes). What bounds it instead is
  // `belongs` against real columns — a footnote fills one band of fourteen.
  let bands = derive(lo, hi);
  let a = seed;
  let b = seed;
  for (let pass = 0; pass < 2; pass++) {
    if (bands.length < GRID_MIN_COLS) return null;
    const runBelongs = belongs(bands, false);
    if (!runBelongs(seed)) return null;
    a = reach(bands, seed, -1, runBelongs, padLo, padHi);
    b = reach(bands, seed, 1, runBelongs, padLo, padHi);
    bands = derive(a, b);
  }
  if (bands.length < GRID_MIN_COLS) return null;
  padLo = Math.max(0, a - GRID_RUN_BRIDGE);
  padHi = Math.min(rows.length - 1, b + GRID_RUN_BRIDGE);
  const run = rows.slice(padLo, padHi + 1);
  const runSegs = segs.slice(padLo, padHi + 1);
  const fits = run.map((_, k) => bandFit(bands, starts[padLo + k]));
  a -= padLo;
  b -= padLo;
  // A table may END on a wrapped cell, which reach() cannot include — it stops
  // at the last row that belongs. Extend over continuations at either edge.
  const wraps = wrapFlags(run, runSegs, fits, bands);
  while (b + 1 < run.length && wraps[b + 1]) b++;
  while (a - 1 >= 0 && wraps[a - 1]) a--;
  // Then the header, if there is one: one row above the body that fills too
  // few bands to belong — a column-heading row sets no row label, so on a
  // narrow table it never can — but enough of them to be a heading rather than
  // stray text, and nothing outside the table's columns.
  if (a - 1 >= 0) {
    const f = fits[a - 1];
    if (f.left === 0 && f.occupied >= GRID_HEADER_MIN_BANDS) a--;
  }
  const kept = run.slice(a, b + 1);
  const keptWraps = wrapFlags(kept, runSegs.slice(a, b + 1), fits.slice(a, b + 1), bands);
  // The floor counts rows the reader will see: one row and five continuations
  // of it is not a grid.
  if (keptWraps.filter((w) => !w).length < GRID_MIN_ROWS) return null;
  // The table's own type size, carried so the caller can tell the table's text
  // from anything else sharing its baselines (asideGlyphs).
  const typeH = medianOf(runSegs.slice(a, b + 1).flatMap((ss) => ss.map((s) => s.h)));
  return { bands, rows: kept, wraps: keptWraps, typeH };
}

// Fold adjacent bands that no row ever occupies together. Two columns are two
// columns because a row can hold both; bands that are never both filled are one
// column whose content is set at more than one x — a row-label column with an
// indent level per nesting depth ("Total", indented less than "Total Scope 1
// and 2", indented less than "Mobile combustion"), or a heading set flush left
// over figures set flush right. Left as separate bands they become columns of
// almost entirely empty cells, and the label a reader needs to identify the row
// lands in a different one for every row.
//
// Only ever folds bands closer together than the run's typical column pitch, so
// a genuinely sparse pair of columns — two alternatives, only one filled per
// row — stays two columns.
function mergeBands(bands, rowStarts) {
  if (bands.length < 2) return bands;
  const gaps = [];
  for (let k = 1; k < bands.length; k++) gaps.push(bands[k] - bands[k - 1]);
  const pitch = medianOf(gaps);
  const filled = rowStarts.map((ss) => {
    const f = new Set();
    for (const x of ss) {
      const i = bandOf(bands, x, -1);
      if (i >= 0) f.add(i);
    }
    return f;
  });
  const out = [bands[0]];
  const group = [0];
  for (let k = 1; k < bands.length; k++) {
    const together = filled.some((f) => group.some((j) => f.has(j) && f.has(k)));
    if (!together && bands[k] - bands[k - 1] < pitch) {
      group.push(k);
      continue;
    }
    out.push(bands[k]);
    group.length = 0;
    group.push(k);
  }
  return out;
}

// Which rows of a run are wrapped continuations of the row above them. The
// first row never is.
//
// Three things have to hold at once, and each rules out a case the others let
// through:
//
//   Pitch. The row sits at line spacing rather than row spacing, measured
//   against the run's own pitch (GRID_WRAP_RATIO) — an absolute gap means
//   nothing, since both kinds are present in the same table. The pitch is taken
//   between the run's BEST-FILLED rows: those are the table's own, and a run
//   that stepped over wrapped rows would otherwise let them halve its idea of a
//   row spacing.
//
//   Type size. A continuation is the rest of one cell's sentence, so it is set
//   at the same size. Without this, a page that runs a large display heading
//   down the side of its body text merges the two: a sustainability report's
//   "Our climate change / response to / climate change" banner landed a
//   fragment on each body baseline, close enough to read as tight spacing, and
//   the merge spliced sentences that appear nowhere in the document.
//
//   Figures don't wrap. A number is complete where it ends; two numbers in one
//   column on consecutive baselines are two values, never one that ran on. This
//   is what keeps a densely set table of figures intact — its row spacing is
//   barely wider than its leading, so pitch alone reads every third row as a
//   continuation and glues "508" to "516".
//
//   Nothing new. A continuation carries on cells that are already there, so it
//   can only fill columns the row above filled. A row that fills a column that
//   one left empty is stating something the row above didn't — a section
//   heading followed by its first entry ("Water (SA)", then "Water withdrawal –
//   total | Kilolitre | 88 603 | …") sits at exactly a continuation's spacing,
//   and merging them files three metrics' figures under one label.
function wrapFlags(run, runSegs, fits, bands) {
  const gaps = [];
  for (let k = 1; k < run.length; k++) gaps.push(run[k - 1].y0 - run[k].y0);
  const most = Math.max(...fits.map((f) => f.occupied));
  const pitchGaps = [];
  let prev = -1;
  run.forEach((row, k) => {
    if (fits[k].occupied < most) return;
    if (prev >= 0) pitchGaps.push(run[prev].y0 - row.y0);
    prev = k;
  });
  if (!pitchGaps.length) return run.map(() => false);
  const pitch = medianOf(pitchGaps);
  const sameSize = (a, b) => {
    const hi = Math.max(a.h, b.h);
    const lo = Math.min(a.h, b.h);
    return lo > 0 && hi / lo <= GRID_WRAP_MAX_HEIGHT_RATIO;
  };
  // A band the two rows both fill where either side is a bare value: two
  // figures stacked are two entries, and a figure under a heading is that
  // heading's first row, never the rest of its words.
  const sharesFigure = (k) => {
    const above = new Map();
    for (const s of runSegs[k - 1]) {
      const i = bandOf(bands, s.x0, -1);
      if (i >= 0) above.set(i, isBareValue(s.text) || above.get(i));
    }
    return runSegs[k].some((s) => {
      const i = bandOf(bands, s.x0, -1);
      return (
        i >= 0 && above.has(i) && (isBareValue(s.text) || above.get(i) === true)
      );
    });
  };
  const within = (k) => [...fits[k].filled].every((i) => fits[k - 1].filled.has(i));
  return run.map(
    (row, k) =>
      k > 0 &&
      gaps[k - 1] <= GRID_WRAP_RATIO * pitch &&
      sameSize(row, run[k - 1]) &&
      within(k) &&
      !sharesFigure(k)
  );
}

// A cell that states a value and nothing else: a number, a percentage, a
// dash or "n/a" standing in for one. Deliberately narrower than isTabularCell,
// which also passes any short phrase.
const BARE_VALUE_RE = /^[\d.,%+\-()/*\s–—−$£€¥¢₹]+$/;

// ...and the placeholder a blank form stands a figure in with: one letter
// repeated to the shape of the number it stands for, grouped like one
// ("xx", "xxx,xxx", "(xx,xxx)"). A specimen financial statement is written
// entirely in them, and to this test they have to count as figures or its rows
// merge into each other.
const PLACEHOLDER_RE = /^[\s()$\-–—]*([a-z])\1*(?:[,.\s]\1+)*[\s()%]*$/i;

function isBareValue(text) {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return false;
  return (
    BARE_VALUE_RE.test(t) || /^n\/?a\*?$/i.test(t) || PLACEHOLDER_RE.test(t)
  );
}

// A detected grid that survived both prose tells, or null. Shared by the two
// scales that look for one — the whole page, and each page column in turn
// (regionProse) — so a grid accepted at one can never be one the other would
// have thrown out.
function validGrid(glyphs) {
  const grid = detectGrid(glyphs);
  if (!grid) return null;
  if (gridIsPageColumns(grid, glyphs) || gridWrapsLikeProse(grid)) return null;
  if (gridHoldsRunningProse(grid)) return null;
  return grid;
}

// The third prose tell, and the one the wrap merge makes necessary. Merging
// continuations means a false grid no longer betrays itself by the shape of
// its rows — the fragments it used to scatter now assemble into cells that
// look deliberate. What they cannot disguise is size: a page of prose laid
// beside a diagram yields cells holding whole paragraphs, several sentences
// each, where a real table cell is a value or a short phrase. On a governance
// spread this was the difference between a readable page and one rebuilt as a
// six-column table whose cells ran to 700 characters of spliced commentary.
const GRID_MAX_CELL_CHARS = 300;

function gridHoldsRunningProse(grid) {
  return gridLines(grid).some((l) =>
    l.cells.some((c) => c.text.length > GRID_MAX_CELL_CHARS)
  );
}

// Is a detected "grid" really the page's own column layout? Three (or more)
// aligned prose columns satisfy detectGrid's alignment test exactly as a
// bordered table does — the geometry is identical inside the grid's rows.
//
// The tell is VERTICAL EXTENT. A table's column is exactly as tall as the
// table: every value in it is a row of that table, and nothing at that x
// position belongs to anything else. A page column is taller than any run of
// rows that happens to line up inside it — the governance spread of a climate
// report sets six committee descriptions side by side, and each keeps setting
// lines at its own x for another ten baselines after the last one they all
// share. So: measure how far each interior band's content reaches past the
// grid's own top and bottom row, and reject when that is true of a majority of
// them. Formalizing such a grid would emit prose as a fake pipe table — and
// gridLines' floating-box exclusion would silently drop the text that doesn't
// fit the fiction.
//
// Extent rather than the old "the band recurs, and its supporters span most of
// the page": that test read the aligned run as a SLICE with unaligned rows
// around it, which only holds while a run is made of complete rows. Once a run
// absorbs the ragged rows of its own table (GRID_MIN_FILL), a table's remaining
// rows would be exactly the outside support the old test took as proof of
// prose, and every ragged table would be rejected as page columns.
const PAGE_COLUMN_MIN_OUTSIDE_ROWS = 2;
// How far past the grid a band's content has to reach, in body rows, before it
// counts as continuing rather than as a footnote or caption that happens to
// share an x position.
const PAGE_COLUMN_OVERHANG_ROWS = 2;
// ...and how many of the interior bands have to do it. Two. One band that keeps
// going is a coincidence and costs a real table its structure — a conversion
// table's "To obtain" column shares an x with the two centred formulae below
// it, and nothing else on that page corroborates. Two independent columns both
// continuing past the run is a layout, not a coincidence, and no proportion is
// asked for on top: a table set beside a column of body text weds only the
// bands the facing column reaches, which on a nine-column table is two of them.
const PAGE_COLUMN_MIN_BANDS = 2;

function gridIsPageColumns(grid, glyphs) {
  const boxes = glyphs.map(toBox);
  const rows = groupRows(boxes);
  const gridTop = Math.max(...grid.rows.map((r) => r.y0));
  const gridBot = Math.min(...grid.rows.map((r) => r.y0));
  const reach = PAGE_COLUMN_OVERHANG_ROWS * medianHeight(boxes);
  const interior = grid.bands.slice(1);
  if (!interior.length) return false;
  let continuing = 0;
  for (const band of interior) {
    const hits = rows.filter((r) =>
      segmentStarts(r).some((x) => Math.abs(x - band) <= GRID_X_TOL)
    );
    const outside = hits.filter((r) => r.y0 > gridTop || r.y0 < gridBot);
    if (outside.length < PAGE_COLUMN_MIN_OUTSIDE_ROWS) continue;
    if (
      outside.some((r) => r.y0 > gridTop + reach || r.y0 < gridBot - reach)
    )
      continuing++;
  }
  return continuing >= PAGE_COLUMN_MIN_BANDS;
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

// Text sharing a grid's baselines but set LARGER than the grid is not the
// grid's. gridLines excludes floating boxes and drops their text, which is
// right for a chart's axis labels and legends — furniture belonging to the
// figure, and shredding it into data rows is worse than omitting it (ADR 0009).
// Furniture is set at or below the size of what it annotates. Text set a size
// tier ABOVE the table is the other way round: the table is the subordinate
// element, and on a page teaching how to read an income statement it is
// deliberately too small to read — a prop for the 9pt annotations that are the
// page's actual subject to point at. Dropping those inverts the page.
//
// So they are neither merged into cells nor dropped: they are handed back to
// reconstruction as their own band (reconstructPage's grid branch), the same
// treatment the material above and below the grid gets.
function isAside(grid, box) {
  const h = box.h;
  return h > 0 && h > GRID_BAND_MAX_HEIGHT_RATIO * grid.typeH;
}

// The glyphs on the grid's rows that aren't the grid's, by that test.
function asideGlyphs(grid) {
  const out = new Set();
  for (const row of grid.rows)
    for (const b of row.boxes)
      if (!b.ws && b.g.str.trim() && isAside(grid, b)) out.add(b.g);
  return out;
}

// Aside glyphs split into the margins they occupy: x-clusters separated by a
// corridor wider than any gap inside a line of text. Each is read on its own,
// top to bottom.
const ASIDE_MARGIN_GAP = 4; // in body heights

function asideMargins(glyphs) {
  if (!glyphs.length) return [];
  const boxes = glyphs.map(toBox).sort((a, b) => a.x0 - b.x0);
  const gap = ASIDE_MARGIN_GAP * medianHeight(boxes);
  const groups = [];
  let cur = null;
  let cover = -Infinity;
  for (const b of boxes) {
    if (!cur || b.x0 - cover > gap) {
      cur = [];
      groups.push(cur);
    }
    cur.push(b.g);
    cover = Math.max(cover, b.x1);
  }
  return groups.map((g) => g.sort((p, q) => q.transform[5] - p.transform[5]));
}

// Which band an x-position belongs to (largest band start at or left of x).
// `below` is what an x left of the first band returns — 0 for callers that
// have already excluded those, -1 for callers that need to know.
function bandOf(bands, x, below = 0) {
  let bi = below;
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
// A ROTATED label in a table's label area heads a BLOCK of rows, not the one
// row its baseline happens to fall in — a sustainability report rails its
// emissions table with "Scope 1 and 2" and "Out of scopes" set bottom-to-top
// beside the rows they cover. Written into the one row, the label reads as that
// row's own, and every other row of its block reads as belonging to whatever
// rail is printed nearest it.
//
// It is stated ONCE, on the first row it covers — where a heading goes.
//
// Not repeated down the block, because how far the block runs is not knowable
// from the label. A rail is set centred in its block and is usually much
// shorter than it: measured against this table, the rail covering eleven rows
// physically reaches three. Repeating it over just those three claims the group
// for them and, by the blank cells either side, denies it of the other eight —
// which reads as a grouping the page never printed. Extending instead (the
// column partitioned at the midpoints between rails, or each rail grown
// symmetrically about its centre) was measured too, and over-claims: on this
// page it files the grand totals under "Out of scopes". A label stated once
// says less than the page does. A label spread over the wrong rows says
// something else.
function railCells(grid, lines) {
  for (const row of grid.rows) {
    for (const b of row.boxes) {
      if (!b.rot || b.ws || !b.g.str.trim()) continue;
      if (b.x0 < grid.bands[0] - GRID_X_TOL) continue;
      const i = bandOf(grid.bands, b.x0);
      const head = lines.find(
        (l) => l.y >= b.y0 - GRID_X_TOL && l.y <= b.y1 + GRID_X_TOL
      );
      if (!head) continue;
      const text = b.g.str.trim();
      head.cells[i].text = head.cells[i].text
        ? `${head.cells[i].text} ${text}`
        : text;
    }
  }
}

function gridLines(grid) {
  const rowCells = grid.rows
    .map((row) => {
      const buckets = grid.bands.map(() => []);
      for (const b of row.boxes) {
        if (!b.g.str.trim()) continue;
        if (b.x0 < grid.bands[0] - GRID_X_TOL) continue;
        if (isAside(grid, b)) continue; // read back as its own band, not a cell
        if (b.rot) continue; // a rail heads a BLOCK of rows — see railCells below
        buckets[bandOf(grid.bands, b.x0)].push(b);
      }
      const cells = buckets.map((rs, i) => {
        rs.sort((a, b) => a.x0 - b.x0);
        let text = "";
        let cover = -Infinity;
        let prev = null;
        for (const b of rs) {
          const gap = b.x0 - cover;
          if (text && gap > COLUMN_GAP * row.h) break;
          // Side-by-side ROTATED runs are consecutive LINES of one vertical
          // label, so they are always word-separated however tightly they sit:
          // along the page's x they abut, and the word-gap test reads that as
          // mid-word ("Out ofscopes").
          const wrapped = prev && prev.rot && b.rot;
          if (
            text &&
            (wrapped || gap > WORD_GAP * row.h) &&
            !/\s$/.test(text) &&
            !unspacedBoundary(text, b.g.str)
          )
            text += " ";
          text += b.g.str;
          if (b.x1 > cover) cover = b.x1;
          prev = b;
        }
        return { text: text.replace(/\s+/g, " ").trim(), x: grid.bands[i], endX: grid.bands[i] };
      });
      // `geom` marks this as an ALIGNED-GRID row specifically, as opposed to
      // the other structures that emit as pipe tables (rail tables, column
      // pairs). regionProse checks it to confirm the grid it delegated for was
      // the grid that came back.
      return { y: row.y0, h: row.h, para: false, grid: true, geom: true, cells };
    });

  railCells(grid, rowCells);

  // Fold each wrapped continuation into the cell it continues, per band, so a
  // cell that took two lines to set arrives as one value ("Seniority of" +
  // "Dividend"). Done here rather than in detectGrid because the merge is
  // per-band text, and the bands are only resolved into text at this point.
  const merged = [];
  rowCells.forEach((line, k) => {
    const into = grid.wraps?.[k] ? merged[merged.length - 1] : null;
    if (!into) {
      merged.push(line);
      return;
    }
    line.cells.forEach((c, i) => {
      if (!c.text) return;
      into.cells[i].text = into.cells[i].text
        ? `${into.cells[i].text} ${c.text}`
        : c.text;
    });
  });
  return merged.filter((l) => l.cells.some((c) => c.text));
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

// What stands in for a page's undecodable glyph runs (textLayerGarble). The
// runs themselves are dropped — printing thousands of U+FFFD teaches a reader
// nothing and buries the text that did survive — so the marker is the only
// notice that anything was there. It PROMISES an attached figure, so callers
// must route the page into the figures flow (perPage[i].garbled — the same
// invariant as hasOmittedChartTable and the vector-chart note).
// What stands in for a page's prop text layer (tinyPropCutoff). Deliberately
// makes no promise about an attachment, unlike garbledTextMarker — routing a
// page into the figures flow is the caller's invariant, and this marker does
// not earn it. It only records that something unreadable was there, so a thin
// page doesn't look like a conversion that quietly lost content.
function tinyPropTextMarker() {
  return markerLine(
    "[miniature text omitted — this page sets unreadably small type as diagram artwork rather than content; only the readable text is transcribed]"
  );
}

function garbledTextMarker() {
  return markerLine(
    "[this page's text could not be decoded — its fonts carry no readable character map, so the unreadable runs were dropped; the page's content is in the attached figure]"
  );
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

// --- Non-Latin scripts: compatibility code points and bidirectional text ---
//
// A PDF's text layer carries whatever code points the font's ToUnicode map
// yields, and for non-Latin scripts that is routinely a LOOKALIKE rather than
// the character a reader (or a model, or a search box) expects. Arabic is the
// worst case: shaped glyphs map into the Arabic Presentation Forms blocks, so
// "التقرير" extracts as seven isolated presentation forms that no Arabic
// keyboard can reproduce. CJK has a quieter version of the same problem —
// Kangxi Radicals (U+2F00–U+2FDF) stand in for the unified ideographs they are
// visually identical to (⽂ for 文). Both have compatibility decompositions, so
// NFKC maps them back; applying it ONLY to those ranges keeps the normalization
// off everything else, where NFKC would also rewrite superscripts, fractions
// and fullwidth forms that carry meaning of their own.
const COMPAT_LOOKALIKE_RE = /[\u2F00-\u2FDF\uFB50-\uFDFF\uFE70-\uFEFF]/;
const COMPAT_LOOKALIKE_RE_G = new RegExp(COMPAT_LOOKALIKE_RE.source, "g");

// Exported for direct unit testing.
export function normalizeCompatText(str) {
  if (!COMPAT_LOOKALIKE_RE.test(str)) return str;
  return str.replace(COMPAT_LOOKALIKE_RE_G, (ch) => ch.normalize("NFKC"));
}

// Strongly right-to-left: Hebrew, Arabic, Syriac, Thaana, and the presentation
// forms above (a line is classified before normalization has necessarily
// reached every glyph, so both spellings must count).
const RTL_CHAR_RE =
  /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
// Strongly left-to-right: Latin, Greek, Cyrillic letters.
const RTL_NEUTRAL_LTR_RE = /[A-Za-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF]/;
// Numbers run left-to-right even inside right-to-left text (Unicode bidi treats
// them as their own direction), so "1,240" and "٢٠٢٦" must survive the mirror
// unreversed — both the Western and the Arabic-Indic digits.
const RTL_NUMBER_RE = /[0-9\u0660-\u0669\u06F0-\u06F9]/;
// Direction-neutral characters a number can pull into its run. Signs and
// terminators ("+12%", "-3") attach to a number on EITHER side; separators
// only bind two numbers together ("1,240", "3.14", "9:30"). They are kept
// apart because the looser rule, applied to separators, also drags the full
// stop that ends an Arabic sentence into an embedded English word (".PDF").
const RTL_NUMBER_SIGN_RE = /^[%$\u00B0\u066A]+$/;
const RTL_NUMBER_SEPARATOR_RE = /^[.,:\/+\-\u066B\u066C]+$/;

// What share of a line's strong characters must be right-to-left for the line
// to READ right-to-left. Not a bare majority: an Arabic caption quoting a long
// English product name ("مثل Markdown") is still an Arabic line, and a bare
// majority hands it to the left-to-right path, where it comes out backwards.
// The far commoner opposite case — an English sentence quoting a word or two of
// Hebrew — sits well under this share and stays left-to-right. A genuinely
// balanced line (an English sentence quoting a long Arabic phrase) is ambiguous
// either way; this errs toward reading it right-to-left.
const RTL_LINE_SHARE = 1 / 3;

// Does this line read right-to-left? Digits and punctuation are direction-
// neutral, so only strongly-directional letters get a vote.
function isRtlLine(glyphs) {
  let rtl = 0;
  let ltr = 0;
  for (const g of glyphs)
    for (const ch of g.str) {
      if (RTL_CHAR_RE.test(ch)) rtl++;
      else if (RTL_NEUTRAL_LTR_RE.test(ch)) ltr++;
    }
  return rtl > 0 && rtl >= (rtl + ltr) * RTL_LINE_SHARE;
}

// Punctuation and signs that take the surrounding paragraph's direction rather
// than one of their own. Inside a right-to-left line they are laid out at the
// OPPOSITE edge of an embedded left-to-right run from the one they belong to,
// so a producer that writes such a run as a single item hands back "12%+" for
// "+12%" and ".PDF" for "PDF." — the string itself is in visual order.
// Deliberately excludes "%", "$" and "°": Unicode bidi resolves those to the
// number they touch, so they are NOT mirrored and must stay put.
const MIRRORED_NEUTRAL_RE = /[.,;:!?()[\]{}«»"'+\-‐-―‘-‟]/;

// Combining marks (Arabic vowel/shadda marks, Latin/Greek diacritics) — drawn
// over the preceding letter with no advance of their own.
const COMBINING_MARK_RE = /[\u0300-\u036F\u064B-\u065F\u0670\u06D6-\u06ED]/;

// Undo that mirroring for one item: leading neutrals belong at the end and
// trailing ones at the front. Bracket-like characters are already stored as
// their mirror image, so moving them lands the right glyph on the right side.
// Exported for direct unit testing.
export function unmirrorNeutralEdges(str) {
  let i = 0;
  while (i < str.length && MIRRORED_NEUTRAL_RE.test(str[i])) i++;
  let j = str.length;
  while (j > i && MIRRORED_NEUTRAL_RE.test(str[j - 1])) j--;
  if (i === j) return str; // all neutral: nothing to anchor the swap to
  if (i === 0 && j === str.length) return str;
  return str.slice(j) + str.slice(i, j) + str.slice(0, i);
}

// Within a mirrored right-to-left line, runs that are themselves left-to-right
// (an English term, a number) were mirrored along with everything else and read
// backwards. Reversing each such run in place restores it. Runs matter only
// when the producer emits one item per glyph — where a whole word arrives as a
// single item, its run is length 1 and this is a no-op.
//
// `slots` carries each position's mirrored geometry and `maxGap` the width at
// which a gap means a COLUMN, not a space: a run must never span one, or two
// numbers in neighbouring table cells reverse as a single run and trade places.
function unmirrorLtrRuns(glyphs, slots, maxGap) {
  const kind = glyphs.map((g) => {
    if (RTL_NUMBER_RE.test(g.str)) return "num";
    if (RTL_CHAR_RE.test(g.str)) return "rtl";
    if (RTL_NEUTRAL_LTR_RE.test(g.str)) return "ltr";
    if (RTL_NUMBER_SIGN_RE.test(g.str)) return "sign";
    return RTL_NUMBER_SEPARATOR_RE.test(g.str) ? "sep" : "neutral";
  });
  // Which neutrals belong to the number beside them, following the Unicode
  // bidi classes: a sign ("+", "-", "%") attaches to a number on EITHER side,
  // a separator (".", ",", ":") only BETWEEN two numbers ("3.14", "1,240").
  // The distinction is what keeps "+12%" whole without also swallowing the
  // full stop that ends an Arabic sentence quoting an English term — that
  // period belongs to the sentence, and dragging it into the run spells
  // ".PDF".
  const base = kind.slice(); // snapshot, so neutrals don't chain off each other
  for (let i = 0; i < kind.length; i++) {
    if (kind[i] === "sign" && (base[i - 1] === "num" || base[i + 1] === "num"))
      kind[i] = "num";
    else if (kind[i] === "sep" && base[i - 1] === "num" && base[i + 1] === "num")
      kind[i] = "num";
  }

  const isRun = (i) => kind[i] === "ltr" || kind[i] === "num";
  const columnBreak = (i) =>
    i > 0 && slots[i].x - (slots[i - 1].x + slots[i - 1].w) > maxGap;

  let start = -1;
  for (let i = 0; i <= kind.length; i++) {
    if (i < kind.length && isRun(i) && !columnBreak(i)) {
      if (start < 0) start = i;
      continue;
    }
    if (start >= 0) {
      for (let a = start, b = i - 1; a < b; a++, b--)
        [glyphs[a], glyphs[b]] = [glyphs[b], glyphs[a]];
      start = -1;
    }
    if (i < kind.length && isRun(i)) start = i; // a run resumes after the break
  }
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
    // Reading order within a line is x order — but for a right-to-left script
    // that means DESCENDING x. pdf.js hands back one item per glyph in
    // ascending-x (visual) order, so an Arabic or Hebrew line assembled
    // left-to-right comes out with its words, and its letters, backwards.
    // Mirroring x lets the identical cell/gap logic below run unchanged: in
    // mirrored space the line reads "ascending" like any other, and the cells'
    // real coordinates are restored afterwards so every downstream geometric
    // decision (columns, grid bands, marginalia) still sees the true page.
    const rtl = isRtlLine(line.glyphs);
    const gx = rtl
      ? (g) => -(g.transform[4] + (g.width || 0))
      : (g) => g.transform[4];
    line.glyphs.sort((a, b) => gx(a) - gx(b));
    // Geometry is read from the SORTED slot, not from the glyph that ends up
    // in it. Un-mirroring a left-to-right run below moves glyph strings within
    // the run, and a glyph carrying its own x back to the front of a run would
    // make the gap to the previous cell read from the run's far edge — the
    // column split between an Arabic label and the number beside it vanishes,
    // or lands in the wrong place. The slots stay in reading order, so the
    // gap arithmetic that follows is unchanged from the left-to-right case.
    const slots = line.glyphs.map((g) => ({ x: gx(g), w: g.width || 0 }));
    if (rtl) {
      unmirrorLtrRuns(line.glyphs, slots, COLUMN_GAP * line.h);
      // Multi-character items carry their own visual order, which the run
      // reversal above cannot reach — it moves whole items, never inside one.
      line.glyphs = line.glyphs.map((g) => {
        if (g.str.length < 2 || RTL_CHAR_RE.test(g.str)) return g;
        const str = unmirrorNeutralEdges(g.str);
        return str === g.str ? g : { ...g, str };
      });
    }
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
    for (let i = 0; i < line.glyphs.length; i++) {
      const g = line.glyphs[i];
      if (!g.str.trim().length) {
        pendingSpace = true;
        continue;
      }
      const { x, w } = slots[i];
      const h = g.height || 10;
      const cell = cells[cells.length - 1];
      const gap = cell ? x - cell.endX : Infinity;
      // An injected symbol label (ADR 0017 — symbol-key.js) is always a cell
      // of its own: welded into a text cell it would corrupt the sentence it
      // lands in, which is the exact failure the decoding exists to avoid.
      if (!cell || cell.symbol || g.symbolLabel || gap > COLUMN_GAP * line.h) {
        finalize(cell);
        hh = new Map();
        const next = { text: g.str, x, endX: x + w };
        if (g.symbolLabel) next.symbol = true;
        cells.push(next);
      } else {
        // Three things decide a word space here, in order:
        //   - Scale: judged at the SMALLER adjacent glyph, not the line's
        //     tallest, or a 34pt display glyph stretches the threshold past a
        //     real 8pt word gap and welds words together ("SSignatory").
        //   - Script: a gap flanked by two characters from a script that does
        //     not delimit words with spaces is letterspacing, not a word break
        //     (unspacedBoundary).
        //   - Marks: a combining mark carries no advance, so the glyph after it
        //     measures its gap from a base letter the mark was drawn over —
        //     wide enough to read as a space and split an Arabic word at its
        //     vowel mark ("محفوظً ا"). Nothing follows a mark across a real
        //     word boundary, so suppressing the space is safe.
        const needsSpace =
          (pendingSpace ||
            (gap > WORD_GAP * Math.min(prevH, h) &&
              !unspacedBoundary(cell.text, g.str))) &&
          !/\s$/.test(cell.text) &&
          !COMBINING_MARK_RE.test(cell.text.slice(-1)) &&
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
    if (rtl) {
      // Back out of mirrored space: a cell that spans [-endX, -x] there covers
      // [x, endX] on the page. The cells themselves stay in READING order —
      // rightmost first — which is what both a sentence's words and a table
      // row's columns need in a right-to-left document.
      for (const c of cells) {
        const x0 = -c.endX;
        c.endX = -c.x;
        c.x = x0;
      }
      line.rtl = true;
    }
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

// A run's box on the page, from its transform rather than from the assumption
// that text runs left-to-right. `width` is the advance along the run's OWN
// baseline and `height` its type size perpendicular to it; where the baseline
// is the x axis those are the page's width and height, and this reduces
// exactly to the old `x0 + width`, `y0 + height`.
//
// Where it is not, the old reading was wrong by ninety degrees. A sustainability
// report rails its emissions table with rotated group labels — "Scope 1, 2 and
// 3" painted bottom-to-top in an 8pt-wide strip down the left margin, spanning
// the sixty-four points of table it heads. Read as horizontal, that strip
// became sixty-four points of text sitting ON one baseline, so it welded to
// whatever was printed there ("Scope 1, 2 and 3Scope 3", "Out ofscopesTotal")
// and claimed a row of the table for itself.
//
// `h` is the TYPE size, kept apart from the box height because for a rotated
// run they are different measurements: the box is as tall as the label is long.
function toBox(g) {
  const [a, b, c, d, e, f] = g.transform;
  const w = g.width || 0;
  const h = g.height || 10;
  const along = Math.hypot(a, b) || 1;
  const up = Math.hypot(c, d) || 1;
  const xs = [];
  const ys = [];
  for (const [p, q] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    xs.push(e + (a / along) * p + (c / up) * q);
    ys.push(f + (b / along) * p + (d / up) * q);
  }
  // ws: whitespace-only run. Some PDFs fill the column gutter with space
  // glyphs; those are ignored when measuring gaps so the gutter stays visible,
  // but they're still carried into line reconstruction for word spacing.
  return {
    x0: Math.min(...xs),
    x1: Math.max(...xs),
    y0: Math.min(...ys),
    y1: Math.max(...ys),
    h,
    rot: Math.abs(b) > Math.abs(a),
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
// Exported for the row-grouping tests, like groupRows: the straddler rules here
// are calibrated against pages too large to synthesize whole, and the decision
// they make is worth pinning at its own level rather than through whatever a
// forty-line fixture happens to emit.
export function columnRegions(boxes, hint = null, exclude = []) {
  // Two views of the same page, and they answer different questions (ADR
  // 0029). The GUTTER is a vertical corridor of whitespace, so it is measured
  // over baseline bands: on a page whose columns are typeset on independent
  // baselines, the corridor between the two streams is only visible in a unit
  // that holds runs from both, and settling those into printed lines would
  // leave findGutter reading each line's own internal spacing instead. ROUTING
  // is per printed row — which cluster shares a line with which is exactly the
  // question "does this straddler have a row-mate across the gutter" asks.
  const { rows: bands } = bandRows(boxes);
  const rows = groupRows(boxes);
  const med = medianHeight(boxes);

  let gx = detectGutter(bands, med, exclude);

  // Page-break remainder: too short for confident detection, but the previous
  // page established a gutter. Accept it when this page's rows agree — at
  // least two rows with text entirely on each side — so the fragment keeps
  // reading column-first instead of interleaving. A full-width page never
  // agrees (its rows straddle the gutter), so a stale hint is inert there.
  if (gx == null && hint != null && fragmentFitsGutter(bands, hint)) {
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
  // Straddling the gutter is not by itself full-width furniture. A figure's
  // specification label outdented a few points past the gutter ("Protective
  // Casing", 66pt of a 495pt measure) was promoted to a spanning region and so
  // separated from the value on its own dot-leader line, which stayed in the
  // column — the value then read as belonging to whatever callout preceded it,
  // which is meaning loss, not merely lost structure.
  //
  // Three shapes are genuine furniture, and a straddler needs one of them:
  //   - ALONE on its row. Nothing else shares the baseline, so it is a banner
  //     or a column header, not one cell of a two-stream row. This is what
  //     keeps a narrow right-hand header over a value column ("Page", above a
  //     table of contents' page numbers) spanning, and with it the table the
  //     rows below it reconstruct into.
  //   - Starts at the measure's left edge — an ordinary full-width line.
  //   - Covers most of the measure — a centred or outdented banner.
  // A straddler with row-mates is none of these: it is that row's content, and
  // it belongs in the column its center picks, beside its own value.
  const content0 = boxes.filter((b) => !b.ws);
  const measureX0 = content0.length
    ? Math.min(...content0.map((b) => b.x0))
    : 0;
  const measureX1 = content0.length
    ? Math.max(...content0.map((b) => b.x1))
    : 0;
  const isFurniture = (cl, rowClusters) =>
    rowClusters === 1 ||
    cl.x0 <= measureX0 + SPAN_LEFT_TOL * med ||
    cl.x1 - cl.x0 >= SPAN_WIDE_FRAC * (measureX1 - measureX0);
  // Tag-rail adoption: a column of 1–2 LETTER chips hugging the gutter from
  // the left (G/RM/S/MT pillar tags beside each disclosure item) annotates
  // the column on its RIGHT — the gutter vote lands in the wide corridor the
  // sparse rail sits inside, and splitting there divorces every tag from its
  // item. Adopted boxes route right regardless of center.
  const adopted = railAdoption(boxes, gx, med);
  // The mirror for injected symbol labels (ADR 0017): the icon sits at its
  // row's END, so a repeated value column hugs its rows' text from the RIGHT
  // — and converges so cleanly it ATTRACTS the gutter vote (gx lands one
  // point left of the labels). Splitting there orphans every value from its
  // row; labels hugging the gutter adopt LEFT and travel with their text.
  const adoptLeft = new Set(
    boxes.filter(
      (b) => b.g.symbolLabel && b.x0 >= gx && b.x0 - gx <= RAIL_REACH * med
    )
  );
  const sideOf = (b) =>
    !adoptLeft.has(b) && (adopted.has(b) || (b.x0 + b.x1) / 2 >= gx);
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
  // Chain a unit's content boxes into horizontal clusters at the same gap that
  // splits cells, so a heading typeset as several adjacent glyph runs stays one
  // unit. Used for both views: the printed row (what routes) and the band (what
  // the straddler tests below ask about).
  const clusterize = (unitBoxes, h) => {
    const content = unitBoxes.filter((b) => !b.ws).sort((a, b) => a.x0 - b.x0);
    const out = [];
    for (const b of content) {
      const cur = out[out.length - 1];
      if (cur && b.x0 - cur.x1 <= COLUMN_GAP * h) {
        cur.boxes.push(b);
        if (b.x1 > cur.x1) cur.x1 = b.x1;
        cur.x0 = Math.min(cur.x0, b.x0);
      } else {
        out.push({ x0: b.x0, x1: b.x1, boxes: [b] });
      }
    }
    return out;
  };
  // "Is this straddler furniture, or one cell of a two-stream row?" is a
  // question about WHAT IS PRINTED AT THIS HEIGHT — so it is asked of the band,
  // not of the settled row (ADR 0029). ADR 0025's demotion depends on it: a
  // figure's outdented specification label ("Protective Casing") is not a
  // banner, and what proves it is the callout printed level with it across the
  // gutter. Settling moves that callout onto its own baseline, so asking the
  // settled row leaves the label alone on its line, reading as furniture, and
  // the column blocks it spans flush apart.
  const bandCtx = new Map();
  for (const bd of bands) {
    const cls = clusterize(bd.boxes, bd.h);
    for (const cl of cls) for (const b of cl.boxes) bandCtx.set(b, { cls, cl });
  }

  let prevBottom = null;
  for (const r of rows) {
    // A large vertical gap ends the current column block (e.g. a heading sitting
    // below the columns), so it isn't merged into a column.
    if (prevBottom != null && prevBottom - r.y1 > GAP_FLUSH * med) {
      flush();
      flushSpan();
    }
    // Whitespace-only boxes ride with whichever cluster they sit in (nearest by
    // center); the chaining itself is clusterize above.
    const clusters = clusterize(r.boxes, r.h);
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
    // ...and demoting a straddler only makes sense if its row really holds two
    // streams: it needs a row-mate on the OPPOSITE side of the gutter from
    // where it would land. A running footer set in letterspaced type
    // ("CL IMA TE R E POR T 2025 | MORGAN STANLEY…") also straddles and also
    // has row-mates, but they sit on its own side — it is one banner broken
    // into runs, not a row of two columns, and splitting it severs the banner.
    const clusterSide = (cl) => (cl.x0 + cl.x1) / 2 >= gx;
    // Both tests read the band the straddler is printed in (see bandCtx above);
    // a cluster with no band context falls back to its own row.
    const ctxOf = (cl) => bandCtx.get(cl.boxes[0]) || { cls: clusters, cl };
    const hasOpposingRowMate = (cl) => {
      const { cls, cl: own } = ctxOf(cl);
      return cls.some((o) => o !== own && clusterSide(o) !== clusterSide(cl));
    };
    const spanning = clusters.filter(
      (cl) =>
        cl.boxes.some(crosses) &&
        (isFurniture(cl, ctxOf(cl).cls.length) || !hasOpposingRowMate(cl))
    );
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
  // heading or intro paragraph straddles gx and is skipped, so it can't
  // collapse the corridor).
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
    // Full-width furniture is skipped by whether it CROSSES gx, not by where
    // its center lands. A full-width intro paragraph set above the columns is
    // one box per line running margin to margin, and its center falls a few
    // points to the LEFT of the gutter (the left margin is wider than the
    // right on a typical page) — so the center test below counted it as a
    // left-column row and dragged leftMaxX1 past the right column's start,
    // making the corridor negative and killing detection on genuinely tall
    // two-column pages. The crossing margin matches columnRegions' own
    // full-width test, so a column line overshooting gx by a point or two is
    // still measured as column content rather than treated as furniture.
    if (rowSpansGutter(r, gx, med * 0.5)) continue;
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

// Group boxes into BANDS of baseline: everything printed at about this height,
// top-to-bottom. A band is a horizontal slice of the page, not a printed line —
// where two streams are typeset on independent baselines (a figure's callouts
// beside its specification list, a balance sheet's asset and liability columns)
// one band holds runs from both. That is the wrong unit for binding a cell to
// its row, and groupRows below settles it into printed lines; it is the RIGHT
// unit for measuring the page's vertical whitespace, which is why detectGutter
// reads bands. See ADR 0029.
function bandRows(boxes) {
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
    const h = b.h;
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
  return { rows, sorted };
}

// Group boxes into printed rows, top-to-bottom: bands, settled onto their
// nearest baseline. Exported for the row-grouping tests — every consumer of a
// row (grid binding, column blocks, the rail detector, column routing) reads
// this, so its own contract is worth pinning directly rather than only through
// whatever a page happens to emit.
export function groupRows(boxes) {
  const { rows, sorted } = bandRows(boxes);
  return settleRows(rows, sorted);
}

// Second pass over the banding above: a box belongs to the NEAREST baseline in
// reach, not to whichever band happened to reach it first (ADR 0029).
//
// The greedy pass admits a box when it falls within half of the band's TALLEST
// box, and the row grows as it goes, so one tall run reaches further down the
// page than the type it is set beside ever justifies — and it claims by
// arriving first, not by being closest. On a USGS well-completion figure
// (messy-scan p31) a 10pt drawing callout reached 5.0pt down and took the
// specification label 4.7pt below it, while that label's own dot-leader line —
// 0.7pt further down, and 0.7pt from the label — started a fresh row:
//
//   ROW y0=659.8 h=10.0: "Locking Cap an"[123-216] "Protective Cas"[290-356]
//   ROW y0=654.4 h=8.0:  ".............."[358-391] "6" x 6" x 5' s"[392-474]
//
// The label is 6.7× nearer its own value than the callout that captured it.
// Settling moves it, and the leader line reads as one row.
//
// Baselines come from the greedy pass and do not move: a row's y0 is its seed
// box's, and a box is never nearer to another baseline than to its own, so a
// seed never migrates and no row empties. Reach is still the receiving row's
// tallest box, so this only ever REASSIGNS a contested box — it admits none
// that the greedy pass would have refused everywhere. Candidates are the
// neighbouring rows: the greedy pass builds rows from a baseline-ordered
// stream, so a box's true home is its own row or one of the two beside it.
function settleRows(rows, sorted) {
  if (rows.length < 2) return rows;
  const home = new Map();
  let moved = false;
  for (let i = 0; i < rows.length; i++) {
    for (const b of rows[i].boxes) {
      let best = i;
      let dist = Math.abs(b.y0 - rows[i].y0);
      for (const j of [i - 1, i + 1]) {
        if (j < 0 || j >= rows.length) continue;
        const d = Math.abs(b.y0 - rows[j].y0);
        if (d < dist && d <= rows[j].h * 0.5) {
          dist = d;
          best = j;
        }
      }
      if (best !== i) moved = true;
      home.set(b, best);
    }
  }
  if (!moved) return rows;

  // Rebuild from the sorted stream so each row's boxes keep the global
  // (baseline desc, x asc) order the greedy pass gave them.
  const settled = rows.map((r) => ({ ...r, boxes: [] }));
  for (const b of sorted) settled[home.get(b)].boxes.push(b);
  for (const r of settled) {
    r.x0 = Math.min(...r.boxes.map((b) => b.x0));
    r.x1 = Math.max(...r.boxes.map((b) => b.x1));
    r.y1 = Math.max(...r.boxes.map((b) => b.y1));
    r.h = Math.max(...r.boxes.map((b) => b.h));
  }
  return settled;
}

// Character-weighted median box height. A plain box-count median breaks on
// pages where a figure's label soup outnumbers the prose (WHO-doc p17: 4.5pt
// median from ~160 tiny chart fragments vs ~40 real 9.5pt body runs), which
// shrinks every med-scaled threshold — GAP_FLUSH fired on an ordinary
// heading-to-body gap and split the column block. Characters vote instead,
// the same principle as modeHeight: body runs are long, chart labels short.
function medianHeight(boxes) {
  const entries = boxes
    .map((b) => ({ h: b.h, w: b.g?.str?.trim().length ?? 1 }))
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
  lines = rebindPanelHeadings(lines);
  const tableStarts = tableRuns(lines, bodyH); // Map<startIndex, endIndex>
  // Geometry-detected grids (Deliverable 1) emit as tables regardless of cell
  // length; take precedence over the content-based runs above. A run breaks
  // where the table identity changes: side-by-side rail-table leaves (one per
  // panel) are separate structures, and fusing them erases the boundary a
  // reader needs to attribute rows to their panel.
  for (let i = 0; i < lines.length; ) {
    if (lines[i].grid) {
      let j = i;
      while (
        j < lines.length &&
        lines[j].grid &&
        lines[j].tableId === lines[i].tableId
      )
        j++;
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

// The rounded height at or below which a page's glyphs are a PROP LAYER —
// artwork drawn in type, not content — or null when the page has none. Works on
// glyphs rather than assembled lines because it runs before reconstruction.
//
// Uses the STRICTER of the two TINY_BODY_* thresholds, and is meant to disagree
// with modeHeight's vote gate below: this one deletes text, that one only
// re-measures. A page may therefore have its 4pt runs barred from defining
// "body" while those same runs are still transcribed, which is the intended
// asymmetry — a wrong heading level is visible and recoverable, a deleted
// sentence is neither.
function tinyPropCutoff(glyphs) {
  const counts = new Map();
  for (const g of glyphs) {
    const n = g.str.trim().length;
    if (!n) continue;
    const k = Math.round(g.height || 10);
    counts.set(k, (counts.get(k) || 0) + n);
  }
  let winner = 0;
  let bestN = 0;
  for (const [k, n] of counts) {
    if (n > bestN) {
      winner = k;
      bestN = n;
    }
  }
  if (!winner || winner > TINY_BODY_MAX_PT) return null;
  let total = 0;
  let tall = 0;
  for (const [k, n] of counts) {
    total += n;
    if (k >= TINY_BODY_RATIO * winner) tall += n;
  }
  if (!total || tall < TINY_BODY_MIN_SHARE * total) return null;
  // The readability floor, not the winning cohort: once a page is known to draw
  // type as artwork, every sub-4pt run on it is part of that artwork. This page
  // also sets its miniature statements' TITLES at 2.9pt, one tier above the
  // 1.6pt figures, and leaving those in interleaves them through the commentary
  // ("…or to the [CONSOLIDATED INCOME STATEMENTS] right of Assets").
  return TINY_BODY_MAX_PT;
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
  // Character-weighted mode, optionally ignoring everything at or below a
  // height already judged to be a prop layer.
  const mode = (above = 0) => {
    let best = 0;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (k <= above) continue;
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return best;
  };

  const winner = mode();
  // Character weighting fixed the case where tiny labels merely OUTNUMBER body
  // lines (see above). It cannot fix the inverse: a prop layer that is both
  // numerous and long, and so wins on characters too. Then the winner is far
  // smaller than the page's real content rather than the other way round, and
  // that content still accounts for a substantial share of the text — the
  // fingerprint of miniature type used as artwork (TINY_BODY_*). Re-take the
  // vote above the prop layer so body height is the readable text's.
  if (winner && winner <= TINY_BODY_VOTE_MAX_PT) {
    let total = 0;
    let tall = 0;
    for (const [k, n] of counts) {
      total += n;
      if (k >= TINY_BODY_VOTE_RATIO * winner) tall += n;
    }
    if (total && tall >= TINY_BODY_MIN_SHARE * total) {
      const readable = mode(TINY_BODY_VOTE_MAX_PT);
      if (readable) return readable;
    }
  }
  return winner || 10;
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

// --- Panel-heading rebinding (multi-panel pages) -----------------------------
// A page of side-by-side PANELS (the Discovery phased-disclosure spread) sets
// each panel's heading at the panel top, on baselines SHARED across panels —
// so reconstruction reads the heading band row-major ("PHASE 1 PHASE 2" as
// one line) and emits it at the page top, far from the panel tables below. An
// LLM reading that output cannot attribute any table's rows to its panel
// (measured: Sonnet placed the phase-2 Governance item under phase 1).
//
// The repair is x-containment on the FINAL lines: rail-table leaves carry
// their panel's x-extent, and a short cell stranded ABOVE the tables whose
// own x-span sits inside a panel's extent is that panel's heading — it moves
// to directly above that panel's table, ordered by its own y so "PHASE 2"
// precedes its subtitle. Deliberately narrow: only pages with two or more
// x-DISJOINT extent-bearing tables qualify (a single-column page never has
// stranded panel headings, and its intro prose must not move), only lines
// above the first table are considered, and cells spanning several panels (a
// banner across the spread) or longer than a heading stay put.
const PANEL_HEADING_MAX_CHARS = 40;
// Panel headings/subtitles are set slightly OUTDENTED from the panel's own
// content (the Discovery subtitles start 4–5pt left of the first chip), so
// containment needs real slack — still an order of magnitude under any
// panel-to-panel gap (~60pt on the measured page).
const PANEL_EXTENT_TOL_PT = 8;

function rebindPanelHeadings(lines) {
  // Extent-bearing table runs in reading order. Runs sharing an extent (a
  // panel's item table and the KEY legend below it) both appear; first-match
  // assignment sends the panel's headings to the upper one.
  const runs = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.grid || l.x0 == null) continue;
    const last = runs[runs.length - 1];
    if (last && last.tableId === l.tableId) continue;
    runs.push({ start: i, tableId: l.tableId, x0: l.x0, x1: l.x1, top: l.y });
  }
  if (runs.length < 2) return lines;
  if (
    !runs.some((a) =>
      runs.some((b) => b !== a && (b.x0 > a.x1 || b.x1 < a.x0))
    )
  ) {
    return lines;
  }

  const tol = PANEL_EXTENT_TOL_PT;
  const first = runs[0].start;
  const pulls = new Map(); // run → [{ y, h, cell }]
  const keep = [];
  for (let i = 0; i < first; i++) {
    const l = lines[i];
    if (l.marker || l.grid || !l.cells) {
      keep.push(l);
      continue;
    }
    const rest = [];
    for (const c of l.cells) {
      const home =
        c.text.length <= PANEL_HEADING_MAX_CHARS && !c.symbol
          ? runs.find(
              (r) =>
                c.x >= r.x0 - tol && c.endX <= r.x1 + tol && l.y > r.top
            )
          : null;
      if (home) {
        if (!pulls.has(home)) pulls.set(home, []);
        pulls.get(home).push({ y: l.y, h: c.domH ?? l.h, cell: c });
      } else {
        rest.push(c);
      }
    }
    if (rest.length) {
      keep.push(rest.length === l.cells.length ? l : { ...l, cells: rest });
    }
  }
  if (!pulls.size) return lines;

  const out = keep;
  for (let i = first; i < lines.length; i++) {
    const run = runs.find((r) => r.start === i);
    const pulled = run && pulls.get(run);
    if (pulled) {
      pulled
        .sort((a, b) => b.y - a.y)
        .forEach((p, k) =>
          out.push({ y: p.y, h: p.h, para: k === 0, cells: [p.cell] })
        );
    }
    out.push(lines[i]);
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

// Provenance marker for decoded icon values (ADR 0017 — symbol-key.js): the
// page's repeated textless icons were matched to its own key legend and their
// labels written into the rows as text. Named so the reader knows those
// values are decoded from symbols, not extracted verbatim.
export function appendSymbolKeyNote(pageMarkdown, labels) {
  const note = `[repeated icons on this page were decoded to text using the page's own key: ${labels.join(", ")}]`;
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
  // Pages whose text layer is undecodable end to end (textLayerGarble's
  // `total`). Like a scanned exhibit, their content exists ONLY as the page
  // image — there is no text fallback to fall back to — so they join
  // scanPageNumbers in being exempt from the attachment cap.
  const unreadablePageNumbers = [];
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
    // The page's fonts carry no readable character map, so its glyphs were
    // dropped as noise (textLayerGarble). This is figure evidence in its own
    // right and needs no raster to corroborate it: undecodable glyphs PROVE
    // something is being painted that we cannot read, which is exactly what
    // low convergence alone cannot establish (flattenedWithEvidence). A map
    // or chart drawn in a cartographic font paints no raster and no colored
    // fills — the glyphs are the artwork — so without this the page shows
    // zero on every other figure signal and silently converts to gibberish.
    const garbled = p.garbled === true;
    // What makes page i a chart page depends on whether it carries usable
    // text. A TEXT page painting any raster is a candidate (an incidental
    // logo is filtered later by significance — selectChartPages). An
    // IMAGE-ONLY page (below the text floor — a scanned exhibit, a full-page
    // figure) qualifies only when it carries a SIGNIFICANT figure: its content
    // exists solely as that image, so dropping it loses the whole page —
    // unlike an incidental image on a text page, whose text still converts. A
    // bare image-only page with no significant figure stays out (that's the
    // document-level passthrough/convert decision's business), as does a
    // flattened marker with no image behind it (nothing to attach). A garbled
    // page qualifies on EITHER side of that split, so its routing never hinges
    // on how much text survived stripping: today the marker alone keeps such a
    // page above the floor, but a page that ever landed on the image-only
    // branch has no image to qualify on and would drop out silently — the very
    // page the signal exists to rescue.
    const chartPage = hasText
      ? p.images >= 1 || flattened || garbled
      : significant || garbled;
    if (!chartPage) return;
    chartPageNumbers.push(i + 1);
    // Garbled pages rank with the flattened ones: in both the emitted text
    // misrepresents the page, so the attachment is the only faithful copy.
    if (flattened || garbled) {
      flattenedPageNumbers.push(i + 1);
      if (p.garbledTotal === true) unreadablePageNumbers.push(i + 1);
    } else if (significant) {
      figurePageNumbers.push(i + 1);
      if (!hasText) scanPageNumbers.push(i + 1);
    }
    // The single-figure ambiguity TRIGGER stays text-page-only: one image-only
    // figure shouldn't flip an otherwise-text document into the prompt (a lone
    // scanned insert). MANY image-only figures instead push chartPages past
    // MIN_CHART_PAGES_FOR_AMBIGUOUS and reach the prompt by volume — the
    // scanned-appendix case (a born-digital report with a scanned annex) that
    // must route into the figures flow so the scans attach.
    if (hasText && (significant || flattened || garbled)) figurePages++;
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
    unreadablePageNumbers,
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
// Two page classes are EXEMPT from the cap, for one reason: their content
// exists only as the page image, so dropping one loses the whole page with no
// text fallback. Those are image-only scans (scanPageNumbers) and pages whose
// text layer is undecodable end to end (unreadablePageNumbers — a data table
// drawn in a font with no character map extracts as nothing at all). The cap
// therefore governs only the text-backed figures, which stay readable as
// Markdown even when their render is dropped. This is why a born-digital
// report with a 30-page scanned annex attaches the whole annex; an all-scan
// document never reaches here (it classifies passthrough).
export function selectChartPages(meta, cap) {
  const all = meta?.chartPageNumbers ?? [];
  const flattened = new Set(meta?.flattenedPageNumbers ?? []);
  const figures = new Set(meta?.figurePageNumbers ?? []);
  // Cap-exempt pages: image-only scans and pages whose text layer is
  // undecodable end to end. Both have the same standing — no text fallback
  // survives, so dropping one loses the page outright — which is exactly what
  // the cap is allowed to do to a text-backed figure and must not do here.
  const exempt = new Set([
    ...(meta?.scanPageNumbers ?? []),
    ...(meta?.unreadablePageNumbers ?? []),
  ]);
  const strong = all.filter((n) => flattened.has(n) || figures.has(n));
  const pool = strong.length ? strong : all;
  // Exempt pages always attach; the cap applies only to the remainder, which
  // stays readable as Markdown even when its render is dropped.
  const exemptPages = pool.filter((n) => exempt.has(n));
  const capped = pool.filter((n) => !exempt.has(n));
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
  return [...exemptPages, ...kept].sort((a, b) => a - b);
}
