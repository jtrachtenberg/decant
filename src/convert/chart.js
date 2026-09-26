// Shared OOXML chart-data recovery (Tier 1, SPEC §3.9), used by the PPTX,
// DOCX, and XLSX engines. A native Office chart is not an image — its chart
// part (`<base>/charts/chartN.xml`) stores the cached data series inline
// (`<c:ser>` → `c:tx`/`c:cat`/`c:val`). This module turns one chart part into
// a category×series table, and offers a helper to pull every chart part out of
// an already-open zip.
//
// Pattern-based like the format engines (no DOMParser in Node); the DrawingML
// chart schema uses stable `c:`/`a:` prefixes across producers.

// Upper bound on the dense point array a single series can materialize. Real
// charts have at most a few thousand points; anything past this is corrupt or
// hostile and its excess points are dropped rather than allocated.
const MAX_CHART_POINTS = 100_000;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-f]+);/gi, (m, e) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    // fromCodePoint throws for values above 0x10FFFF (and lone surrogates); a
    // malformed numeric entity must not abort the whole conversion, so fall
    // back to the raw text.
    if (!Number.isFinite(code)) return m;
    try {
      return String.fromCodePoint(code);
    } catch {
      return m;
    }
  });
}

// Parse a chart part into { title, rows } — a category column plus one column
// per data series, from the cached data. Scatter/bubble series (c:xVal/c:yVal,
// no shared categories) come back in long form instead: one row per point,
// [Series, X, Y(, Size)]. Returns null when there's no usable cached data
// (caller falls back to a marker). Pure/exported.
export function parseChartXml(chartXml) {
  const date1904 = /<c:date1904\s+val="(?:1|true)"/.test(chartXml);
  const series = [];
  const xySeries = [];
  let categories = null;
  for (const ser of chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)) {
    const vals = cachePoints(ser[0], "c:val", date1904);
    if (vals) {
      const cats = cachePoints(ser[0], "c:cat", date1904);
      if (cats && !categories) categories = cats; // categories are shared
      series.push({ name: seriesName(ser[0]), vals });
      continue;
    }
    // Scatter/bubble: each point is an (x, y) pair, not a category value (B6).
    const ys = cachePoints(ser[0], "c:yVal", date1904);
    if (ys) {
      xySeries.push({
        name: seriesName(ser[0]),
        xs: cachePoints(ser[0], "c:xVal", date1904),
        ys,
        sizes: cachePoints(ser[0], "c:bubbleSize", date1904),
      });
    }
  }
  if (!series.length && xySeries.length) return xyTable(chartXml, xySeries);
  if (!series.length) return null;

  const npts = Math.max(
    categories ? categories.length : 0,
    ...series.map((s) => s.vals.length)
  );
  if (!npts) return null;

  const rows = [["Category", ...series.map((s, i) => s.name || `Series ${i + 1}`)]];
  for (let i = 0; i < npts; i++) {
    const cat = categories ? categories[i] ?? "" : String(i + 1);
    rows.push([cat, ...series.map((s) => s.vals[i] ?? "")]);
  }
  return { title: chartTitle(chartXml), rows };
}

function xyTable(chartXml, xySeries) {
  const withSize = xySeries.some((s) => s.sizes);
  const rows = [["Series", "X", "Y", ...(withSize ? ["Size"] : [])]];
  let total = 0;
  xySeries.forEach((s, k) => {
    const name = s.name || `Series ${k + 1}`;
    for (let i = 0; i < s.ys.length && total < MAX_CHART_POINTS; i++) {
      const x = s.xs ? s.xs[i] ?? "" : String(i + 1);
      const y = s.ys[i] ?? "";
      if (x === "" && y === "") continue;
      rows.push([name, x, y, ...(withSize ? [s.sizes?.[i] ?? ""] : [])]);
      total++;
    }
  });
  return rows.length > 1 ? { title: chartTitle(chartXml), rows } : null;
}

// Enumerate and parse every chart part under `dir` (e.g. "word/charts",
// "xl/charts", "ppt/charts") in an open JSZip, in chart-number order. Returns
// { tables, omitted }: the parsed tables ({ title, rows }) and how many chart
// parts yielded none — no usable cached data, an unreadable part, or an Office
// 2016 chartEx part (waterfall, treemap, sunburst, histogram, box & whisker,
// funnel), whose data model this parser doesn't read. Callers must mark the
// omitted ones: a chart that silently vanishes breaks the "never silently
// degrade" rule (B6). Async (zip reads).
export async function chartPartsFromZip(zip, dir) {
  const re = new RegExp(`^${dir}/chart(Ex)?\\d+\\.xml$`);
  const paths = Object.keys(zip.files)
    .filter((p) => re.test(p))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));
  const tables = [];
  let omitted = 0;
  for (const p of paths) {
    if (/\/chartEx\d+\.xml$/.test(p)) {
      omitted++;
      continue;
    }
    // Chart recovery is an auxiliary bonus, not the conversion itself: one part
    // with a corrupt deflate stream (async rejects) or unparseable XML must not
    // abort the whole engine and discard an otherwise-good document. Count the
    // bad part as omitted and keep going.
    try {
      const parsed = parseChartXml(await zip.file(p).async("string"));
      if (parsed) tables.push(parsed);
      else omitted++;
    } catch {
      omitted++;
    }
  }
  return { tables, omitted };
}

// The parsed tables only (see chartPartsFromZip).
export async function chartTablesFromZip(zip, dir) {
  return (await chartPartsFromZip(zip, dir)).tables;
}

// The points inside a series' <c:cat>/<c:val>/<c:xVal>/<c:yVal> cache, as a
// dense array indexed by idx (gaps → ""). Each value is read from inside its
// own <c:pt>…</c:pt> — a point with no <c:v> is a gap, never the next point's
// value (B10). Numeric caches honour their format code for percentages and
// dates (B10: an axis of 0.25 is "25%", a date axis is dates, not Excel
// serials). Multi-level category caches (<c:lvl>) join their levels,
// outermost first ("2024 / Q1"), instead of letting the last level overwrite.
function cachePoints(serXml, tag, date1904 = false) {
  const block = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`).exec(serXml);
  if (!block) return null;
  const levels = [...block[0].matchAll(/<c:lvl>[\s\S]*?<\/c:lvl>|<c:lvl\/>/g)];
  if (levels.length > 1) return multiLevelPoints(levels.map((l) => l[0]));
  const format = /<c:formatCode>([\s\S]*?)<\/c:formatCode>/.exec(block[0])?.[1];
  return densePoints(block[0], (v, ptFormat) =>
    formatCached(v, decodeEntities(ptFormat ?? format ?? ""), date1904)
  );
}

// { idx → value } from one cache fragment, as a capped dense array; null when
// the fragment holds no valued point.
function densePoints(fragment, map = (v) => v) {
  const pts = [];
  for (const m of fragment.matchAll(/<c:pt\b([^>]*[^/>]|)>([\s\S]*?)<\/c:pt>/g)) {
    const idx = /\bidx="(\d+)"/.exec(m[1]);
    const v = /<c:v>([\s\S]*?)<\/c:v>/.exec(m[2]);
    if (!idx || !v) continue;
    const ptFormat = /\bformatCode="([^"]*)"/.exec(m[1])?.[1];
    pts.push([Number(idx[1]), map(decodeEntities(v[1]).trim(), ptFormat)]);
  }
  if (!pts.length) return null;
  // `idx` comes straight from the document, so a hostile/corrupt part can carry
  // a huge value (e.g. idx="99999999"). Sizing the dense array from it would
  // force a multi-GB allocation and crash the tab — the one failure the
  // passthrough guarantee can't survive. Compute the max without spreading a
  // (potentially enormous) argument list, and cap the dense array.
  let maxIdx = 0;
  for (const [n] of pts) if (n > maxIdx) maxIdx = n;
  const size = Math.min(maxIdx + 1, MAX_CHART_POINTS);
  const arr = Array(size).fill("");
  for (const [i, v] of pts) if (i < size) arr[i] = v;
  return arr;
}

// <c:lvl> 0 is the leaf level; each outer level labels a run of leaves starting
// at its point's idx, so it carries forward until its next point.
function multiLevelPoints(levelXml) {
  const levels = levelXml.map((l) => densePoints(l) ?? []);
  const n = levels[0].length;
  const rows = Array(n).fill("");
  const carried = levels.map(() => "");
  for (let i = 0; i < n; i++) {
    const parts = [];
    for (let k = levels.length - 1; k >= 1; k--) {
      if (levels[k][i]) carried[k] = levels[k][i];
      if (carried[k]) parts.push(carried[k]);
    }
    if (levels[0][i]) parts.push(levels[0][i]);
    rows[i] = parts.join(" / ");
  }
  return n ? rows : null;
}

// Render a cached numeric value the way its format code displays it, for the
// two cases where the raw number misleads: percentages and dates/times. Any
// other format (currency, separators, General) keeps the raw value.
export function formatCached(value, formatCode, date1904 = false) {
  const n = Number(value);
  if (!formatCode || value === "" || !Number.isFinite(n)) return value;
  // Only the positive section matters, minus quoted literals, escapes and
  // [bracketed] locale/colour/elapsed codes.
  const code = formatCode
    .split(";")[0]
    .replace(/"[^"]*"|\\.|\[[^\]]*\]/g, "")
    .trim();
  if (!code || /^general$/i.test(code)) return value;
  if (code.includes("%")) {
    const decimals = /\.(0+)/.exec(code)?.[1].length ?? 0;
    return `${(n * 100).toFixed(decimals)}%`;
  }
  const hasDate = /[yd]/i.test(code) || (/m/i.test(code) && !/[hs]/i.test(code));
  const hasTime = /[hs]/i.test(code);
  if (!hasDate && !hasTime) return value;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  const d = new Date(epoch + Math.round(n * 86400000));
  if (Number.isNaN(d.getTime())) return value;
  const iso = d.toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  if (hasDate && hasTime) return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  if (hasDate) return iso.slice(0, 10);
  return iso.slice(11, /s/i.test(code) ? 19 : 16);
}

function seriesName(serXml) {
  const tx = /<c:tx>[\s\S]*?<\/c:tx>/.exec(serXml);
  const v = tx && /<c:v>([\s\S]*?)<\/c:v>/.exec(tx[0]);
  return v ? decodeEntities(v[1]).trim() : "";
}

function chartTitle(chartXml) {
  const t = /<c:title>[\s\S]*?<\/c:title>/.exec(chartXml);
  if (!t) return "";
  const runs = [...t[0].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]);
  const text = runs.length
    ? runs.join("")
    : /<c:v>([\s\S]*?)<\/c:v>/.exec(t[0])?.[1] ?? "";
  return decodeEntities(text).trim();
}
