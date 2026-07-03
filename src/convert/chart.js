// Shared OOXML chart-data recovery (Tier 1, SPEC §3.9), used by the PPTX,
// DOCX, and XLSX engines. A native Office chart is not an image — its chart
// part (`<base>/charts/chartN.xml`) stores the cached data series inline
// (`<c:ser>` → `c:tx`/`c:cat`/`c:val`). This module turns one chart part into
// a category×series table, and offers a helper to pull every chart part out of
// an already-open zip.
//
// Pattern-based like the format engines (no DOMParser in Node); the DrawingML
// chart schema uses stable `c:`/`a:` prefixes across producers.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-f]+);/gi, (m, e) => {
    if (ENTITIES[e.toLowerCase()]) return ENTITIES[e.toLowerCase()];
    const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

// Parse a chart part into { title, rows } — a category column plus one column
// per data series, from the cached data. Returns null when there's no usable
// cached data (caller falls back to a marker / skips). Pure/exported.
export function parseChartXml(chartXml) {
  const series = [];
  let categories = null;
  for (const ser of chartXml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)) {
    const vals = cachePoints(ser[0], "c:val");
    if (!vals) continue; // scatter (xVal/yVal) and empty series skipped
    const cats = cachePoints(ser[0], "c:cat");
    if (cats && !categories) categories = cats; // categories are shared
    series.push({ name: seriesName(ser[0]), vals });
  }
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

// Enumerate and parse every chart part under `dir` (e.g. "word/charts",
// "xl/charts", "ppt/charts") in an open JSZip, in chart-number order. Returns
// the parsed tables ({ title, rows }); parts with no usable cached data are
// skipped. Async (zip reads).
export async function chartTablesFromZip(zip, dir) {
  const re = new RegExp(`^${dir}/chart\\d+\\.xml$`);
  const paths = Object.keys(zip.files)
    .filter((p) => re.test(p))
    .sort((a, b) => Number(a.match(/\d+/g).at(-1)) - Number(b.match(/\d+/g).at(-1)));
  const tables = [];
  for (const p of paths) {
    const parsed = parseChartXml(await zip.file(p).async("string"));
    if (parsed) tables.push(parsed);
  }
  return tables;
}

// The <c:pt idx="N"><c:v>…</c:v></c:pt> points inside a series' <c:cat>/<c:val>
// cache, as a dense array indexed by idx (gaps → "").
function cachePoints(serXml, tag) {
  const block = new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`).exec(serXml);
  if (!block) return null;
  const pts = [
    ...block[0].matchAll(/<c:pt\b[^>]*\bidx="(\d+)"[^>]*>[\s\S]*?<c:v>([\s\S]*?)<\/c:v>/g),
  ];
  if (!pts.length) return null;
  const arr = Array(Math.max(...pts.map((p) => Number(p[1]))) + 1).fill("");
  for (const p of pts) arr[Number(p[1])] = decodeEntities(p[2]).trim();
  return arr;
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
