// Icon-key symbol references (ADR 0017): decode a page's repeated textless
// icons into words using the page's own KEY, so per-row symbol values
// (Disclosed / Not started / In progress) reach the Markdown as text instead
// of surviving only in an attached page image.
//
// The pipeline: scanPageOps records every icon-sized path fill (exact RGB)
// and every icon-sized-clip shadingFill; here those paint boxes merge into
// icon COMPOSITES (a badge is several stacked paints: circle + inner mark),
// composites with identical paint fingerprints form a CLASS, and a class
// whose instances are textless earns a name when EXACTLY ONE instance sits
// immediately left of a short text label — the key legend row. Every other
// instance is a usage: a pseudo text item carrying the label is injected at
// its position, and the ordinary reconstruction (classify.js) binds it to
// its row like any other glyph — railTable emits it as a third table cell.
//
// The one-label rule is the false-positive brake: colored list bullets have
// text right of EVERY instance (no unique legend row → no key), and a chart's
// varying bars fingerprint as singletons (no class → no key).
//
// Suppressing the page's vector-chart note and its figures-flow membership is
// gated harder than injection (symbolSuppression below): a partially-decoded
// symbol column presented as complete is the "quietly make answers worse"
// failure, so the accounting must close exactly — else the note and the
// attachment stay, and the injected labels are a pure addition.
//
// Pure (no pdf.js/chrome imports) so it unit-tests in Node, like raster-gate.

import { MIN_IMAGE_EDGE_PT, hueBucket } from "./raster-gate.js";

// Paint boxes within this gap merge into one icon composite. Badges stack
// their paints concentrically (gap ≤ 0), so this only needs to absorb
// rounding; anything looser starts chaining neighbouring chart marks.
export const SYMBOL_MERGE_GAP_PT = 1.5;
// Fingerprint size quantum: member paints of the "same" icon agree to well
// under a point (vector geometry is exact); 2pt absorbs CTM rounding without
// conflating a 12pt badge with a 16pt one.
export const SYMBOL_SIZE_QUANTUM_PT = 2;
// A symbol class needs at least this many instances — one key entry plus one
// usage. A lone decorated dot has nothing to reference.
export const SYMBOL_MIN_INSTANCES = 2;
// A key label starts within this many composite-heights right of the icon.
// Legend rows set the label a few points off the icon; the nearest OTHER
// text right of a usage instance (the next panel's column) sits several
// corridor-widths away on every measured page.
export const SYMBOL_LABEL_CORRIDOR_RATIO = 1.5;
// Longer "labels" are running text beside the icon, not a legend entry.
export const SYMBOL_LABEL_MAX_CHARS = 40;
// A credible key is a LEGEND — at least two keyed classes whose key icons sit
// in one list. One labeled instance alone is weak evidence (a map page's
// scattered marks with incidental text to the right of one of them formed a
// "key" on the messy-scan corpus doc); a legend's entries are set flush in a
// column (x-aligned, vertically adjacent) or along one row (y-aligned).
export const KEY_MIN_ENTRIES = 2;
export const KEY_ALIGN_TOL_PT = 6;
// Stacked legend entries sit within this many icon-heights of each other;
// side-by-side entries within this many icon-heights horizontally (the label
// text between icons makes horizontal gaps wide).
export const KEY_STACK_GAP_RATIO = 4;
export const KEY_ROW_GAP_RATIO = 20;

const quantize = (v) =>
  Math.round(v / SYMBOL_SIZE_QUANTUM_PT) * SYMBOL_SIZE_QUANTUM_PT;

const boxesTouch = (a, b) =>
  a.x0 <= b.x1 + SYMBOL_MERGE_GAP_PT &&
  b.x0 <= a.x1 + SYMBOL_MERGE_GAP_PT &&
  a.y0 <= b.y1 + SYMBOL_MERGE_GAP_PT &&
  b.y0 <= a.y1 + SYMBOL_MERGE_GAP_PT;

// Merge the scan's small paints into icon composites. Unlike figure-tile
// merging (raster-gate figureComponents), containment merges too — a badge's
// inner mark sits INSIDE its circle and is the same icon. Composites whose
// union outgrows icon size are dropped whole: a gradient strip sliced into
// abutting slivers chains into a band, and a band is figure material for the
// existing gates, never a symbol.
export function symbolComposites(scan) {
  const members = [
    ...(scan.smallFills ?? []).map((f) => ({ kind: "f", rgb: f.rgb, box: f.box })),
    ...(scan.smallShadings ?? []).map((s) => ({ kind: "s", rgb: null, box: s.box })),
  ];
  const comps = [];
  for (const m of members) {
    const homes = comps.filter((c) => c.members.some((o) => boxesTouch(o.box, m.box)));
    if (!homes.length) {
      comps.push({ members: [m] });
      continue;
    }
    const [home, ...rest] = homes;
    home.members.push(m);
    for (const r of rest) {
      home.members.push(...r.members);
      comps.splice(comps.indexOf(r), 1);
    }
  }
  const out = [];
  for (const c of comps) {
    const box = {
      x0: Math.min(...c.members.map((m) => m.box.x0)),
      y0: Math.min(...c.members.map((m) => m.box.y0)),
      x1: Math.max(...c.members.map((m) => m.box.x1)),
      y1: Math.max(...c.members.map((m) => m.box.y1)),
    };
    if (box.x1 - box.x0 >= MIN_IMAGE_EDGE_PT || box.y1 - box.y0 >= MIN_IMAGE_EDGE_PT) {
      continue; // chained band, not an icon
    }
    out.push({ box, members: c.members, fingerprint: fingerprintOf(c.members) });
  }
  return out;
}

// One icon's identity: the multiset of its member paints — kind, exact color
// (fills only; a shading's color lives in a pattern object the operator list
// only names), quantized size.
function fingerprintOf(members) {
  return members
    .map(
      (m) =>
        `${m.kind}:${m.rgb ? m.rgb.join(",") : ""}:` +
        `${quantize(m.box.x1 - m.box.x0)}x${quantize(m.box.y1 - m.box.y0)}`
    )
    .sort()
    .join("+");
}

// Non-whitespace text anchors from getTextContent items (baseline-left point,
// plus enough metrics to read a label off to the right).
function textAnchors(items) {
  const out = [];
  for (const it of items ?? []) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    out.push({
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0,
      h: it.height || 10,
      str: it.str,
    });
  }
  return out;
}

// Does any text sit inside the composite's box? A letter chip (G/RM/S/MT)
// carries its meaning as a glyph — ADR 0014 already binds those, and a
// text-bearing mark needs no image identity.
function hasTextInside(comp, anchors) {
  const { x0, y0, x1, y1 } = comp.box;
  return anchors.some(
    (a) => a.x >= x0 - 1 && a.x <= x1 + 1 && a.y >= y0 - 1 && a.y <= y1 + 1
  );
}

// The short text label immediately right of a composite, or null. Chains
// same-baseline runs (a legend label may arrive as several items) and rejects
// anything long enough to be running prose beside the icon.
function labelRightOf(comp, anchors) {
  const { y0, y1, x1 } = comp.box;
  const h = Math.max(y1 - y0, 4);
  const corridor = SYMBOL_LABEL_CORRIDOR_RATIO * h;
  const starts = anchors
    .filter(
      (a) =>
        a.y >= y0 - 2 &&
        a.y <= y1 + 2 &&
        a.x >= x1 - 1 &&
        a.x - x1 <= corridor
    )
    .sort((a, b) => a.x - b.x);
  const first = starts[0];
  if (!first) return null;
  // Chain rightward along the label's own baseline.
  const run = anchors
    .filter((a) => Math.abs(a.y - first.y) <= first.h * 0.6 && a.x >= first.x)
    .sort((a, b) => a.x - b.x);
  let text = "";
  let cover = first.x;
  for (const a of run) {
    if (text && a.x - cover > 1.5 * first.h) break;
    text += (text && !/\s$/.test(text) && !/^\s/.test(a.str) ? " " : "") + a.str;
    if (a.x + a.w > cover) cover = a.x + a.w;
  }
  text = text.replace(/\s+/g, " ").trim();
  if (!text || text.length > SYMBOL_LABEL_MAX_CHARS) return null;
  if (!/[A-Za-z0-9]/.test(text)) return null;
  return text;
}

// The page's decoded symbol key, or null when no keyed class exists.
//
// Returns {
//   entries:  [{ label, key, usages }] — one per keyed class
//   suppress: whether the vector-chart note / figures-flow membership may be
//             dropped for this page (the strict accounting — see below)
// }
export function symbolKeyPlan(scan, items) {
  const comps = symbolComposites(scan);
  if (!comps.length) return null;
  const anchors = textAnchors(items);
  for (const c of comps) c.textless = !hasTextInside(c, anchors);

  const classes = new Map();
  for (const c of comps) {
    if (!classes.has(c.fingerprint)) classes.set(c.fingerprint, []);
    classes.get(c.fingerprint).push(c);
  }

  const entries = [];
  // Suppression blockers: a textless multi-instance class with NO key entry
  // could be data we failed to decode; one with SEVERAL labeled instances is
  // ambiguous — unless every instance is labeled (self-labeled bullets, each
  // already beside its own text).
  let blocked = false;
  for (const instances of classes.values()) {
    if (instances.length < SYMBOL_MIN_INSTANCES) continue;
    if (!instances.every((c) => c.textless)) continue;
    const labeled = instances
      .map((c) => ({ c, label: labelRightOf(c, anchors) }))
      .filter((e) => e.label);
    if (labeled.length === 1) {
      const key = labeled[0];
      const usages = instances.filter((c) => c !== key.c);
      for (const u of usages) u.keyed = true;
      key.c.keyed = true;
      entries.push({ label: key.label, key: key.c, usages });
    } else if (labeled.length !== instances.length) {
      // 0 of N labeled (an unexplained repeated mark), or some-but-not-all
      // (ambiguous legend) — either way the page may hold undecoded values.
      blocked = true;
    }
  }
  if (!isLegendCluster(entries)) return null;

  // The chromatic-fill accounting: the vector-chart note may only drop when
  // every fill that could have triggered it is accounted for — a member of a
  // keyed class (decoded) or of a text-bearing composite (its meaning already
  // reaches the text layer). Any chromatic paint outside a small composite
  // (a real chart's bars/bands, a bare-verb fill with no geometry) fails the
  // count check and keeps the note.
  const chromaticSmall = (scan.smallFills ?? []).filter(
    (f) => hueBucket(f.rgb) != null
  ).length;
  let accounted = 0;
  for (const c of comps) {
    if (!(c.keyed || !c.textless)) continue;
    accounted += c.members.filter(
      (m) => m.kind === "f" && hueBucket(m.rgb) != null
    ).length;
  }
  const suppress =
    !blocked &&
    (scan.coloredFills ?? 0) === chromaticSmall &&
    accounted === chromaticSmall;

  return { entries, suppress };
}

// Do the keyed classes' key icons form one legend list? Vertical form: all
// starts x-aligned and each within a few icon-heights of the next. Horizontal
// form: all on one baseline, spaced within the room a label needs. Anything
// looser is coincidence, not a key.
function isLegendCluster(entries) {
  if (entries.length < KEY_MIN_ENTRIES) return false;
  const boxes = entries.map((e) => e.key.box);
  const h = Math.max(4, ...boxes.map((b) => b.y1 - b.y0));
  const adjacent = (vals, maxGap) => {
    const sorted = [...vals].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] - sorted[i - 1] > maxGap) return false;
    }
    return true;
  };
  if (
    boxes.every((b) => Math.abs(b.x0 - boxes[0].x0) <= KEY_ALIGN_TOL_PT) &&
    adjacent(boxes.map((b) => b.y0), KEY_STACK_GAP_RATIO * h)
  ) {
    return true;
  }
  return (
    boxes.every((b) => Math.abs(b.y0 - boxes[0].y0) <= KEY_ALIGN_TOL_PT) &&
    adjacent(boxes.map((b) => b.x0), KEY_ROW_GAP_RATIO * h)
  );
}

// Pseudo text items for the plan's usage instances: the class label, placed
// at the icon's own position, flagged `symbolLabel` so reconstruction keeps
// it a cell of its own (classify.js) and railTable emits it as the row's
// value cell. Height sits just under body text so a handful of labels can't
// move the page's size statistics.
const INJECTED_LABEL_H = 8;

export function symbolLabelItems(plan) {
  const out = [];
  for (const e of plan.entries) {
    for (const u of e.usages) {
      const { x0, y0, y1 } = u.box;
      const y = (y0 + y1) / 2 - INJECTED_LABEL_H / 2;
      out.push({
        str: e.label,
        transform: [1, 0, 0, 1, x0, y],
        width: e.label.length * INJECTED_LABEL_H * 0.5,
        height: INJECTED_LABEL_H,
        symbolLabel: true,
      });
    }
  }
  return out;
}
