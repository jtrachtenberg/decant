// Figure collection from the live DOM (SPEC §3.11, extract-and-reference
// ADR 0006 applied to a captured page). Runs inside the captured page —
// injected alongside the serializer — because that's where the rendered
// sizes, the session's cookies, and the already-decoded data URIs live.
//
// Best-effort by design (v1): a cross-origin image whose host sends no CORS
// headers can't be read from here, and is skipped — the Markdown still
// carries its absolute URL reference, so nothing is lost, just not attached.
//
// Selection is by *rendered* significance, not file size: what the reader
// actually sees as a content image. Junk (icons, avatars, pixels, site
// chrome) falls to the size floor and the furniture check.

const MIN_RENDERED_W = 120;
const MIN_RENDERED_H = 90;
export const MAX_CAPTURE_FIGURES = 5; // claude.ai's per-message image limit
export const MAX_FIGURE_BYTES = 8 * 1024 * 1024; // total, well under the relay cap
const FETCH_TIMEOUT_MS = 4000;

// Rendered-size + placement filter over the ORIGINAL document's images.
// Pure-ish (reads layout); exported for the harness to probe directly.
export function collectFigureCandidates(doc) {
  const seen = new Set();
  const out = [];
  for (const img of doc.querySelectorAll("img")) {
    const w = img.clientWidth || img.naturalWidth || 0;
    const h = img.clientHeight || img.naturalHeight || 0;
    if (w < MIN_RENDERED_W || h < MIN_RENDERED_H) continue;
    if (img.closest("nav,header,footer,aside,[hidden]")) continue;
    // checkVisibility folds display/visibility/content-visibility into one
    // call (Chrome 105+/FF 106+); older engines just skip the check.
    if (typeof img.checkVisibility === "function" && !img.checkVisibility()) continue;
    const src = img.currentSrc || img.src || "";
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: (img.getAttribute("alt") || "").trim(), w, h });
  }
  return out;
}

// A stable attachment name from the image URL: basename when it has one,
// otherwise fig-N; extension normalized from the response type later.
function nameFor(src, index) {
  try {
    const base = new URL(src).pathname.split("/").filter(Boolean).pop() || "";
    const clean = decodeURIComponent(base)
      .replace(/[\\/:*?"<>|\s]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(clean)) return clean;
    if (clean) return clean; // extension added from the MIME type below
  } catch {
    // data: URIs and oddities fall through to fig-N
  }
  return `fig-${index + 1}`;
}

const EXT_BY_TYPE = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
};

function withExt(name, type) {
  const ext = EXT_BY_TYPE[type];
  return ext && !name.toLowerCase().endsWith(ext) && !/\.[a-z0-9]{2,4}$/i.test(name)
    ? name + ext
    : name;
}

async function fetchBytes(src) {
  // Page-credentialed fetch: same-origin and CORS-permitting hosts succeed;
  // everything else throws and the figure is skipped. AbortSignal.timeout
  // keeps one dead CDN from eating the whole capture budget.
  const res = await fetch(src, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = (res.headers.get("content-type") || "").split(";")[0].trim();
  const buf = await res.arrayBuffer();
  return { buf, type: type.startsWith("image/") ? type : "application/octet-stream" };
}

function toBase64(buf) {
  const u8 = new Uint8Array(buf);
  let s = "";
  const CHUNK = 0x8000; // String.fromCharCode arg-count limit
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode(...u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

// Collect up to MAX_CAPTURE_FIGURES page images as wire files
// ({ name, type, data(base64) }), largest-rendered-first, capped by total
// bytes. Returns { figures, skipped } — skipped counts candidates that
// couldn't be read (CORS, timeouts, HTTP errors) or didn't fit the budget.
export async function collectFigures(doc) {
  const candidates = collectFigureCandidates(doc)
    .sort((a, b) => b.w * b.h - a.w * a.h)
    .slice(0, MAX_CAPTURE_FIGURES * 2); // fetch headroom: some will fail
  const settled = await Promise.allSettled(
    candidates.map(async (c) => ({ ...c, ...(await fetchBytes(c.src)) }))
  );

  const figures = [];
  const used = new Set();
  let total = 0;
  let skipped = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled") {
      skipped++;
      continue;
    }
    const { buf, type, src } = s.value;
    if (figures.length >= MAX_CAPTURE_FIGURES || total + buf.byteLength > MAX_FIGURE_BYTES) {
      skipped++;
      continue;
    }
    total += buf.byteLength;
    let name = withExt(nameFor(src, figures.length), type);
    // Two same-named images (common CDN basenames) must not collide.
    for (let k = 2; used.has(name.toLowerCase()); k++) {
      name = name.replace(/(\.[a-z0-9]+)?$/i, (ext) => `-${k}${ext}`);
    }
    used.add(name.toLowerCase());
    figures.push({ name, type, data: toBase64(buf) });
  }
  return { figures, skipped };
}

// The association footer for the captured Markdown — same voice as
// figures.js's separateFilesNote, with the page-capture caveat when some
// images couldn't be read.
export function captureFiguresNote(figures, skipped) {
  let note =
    `The page's images are attached as separate files, in page order: ` +
    `${figures.map((f) => `"${f.name}"`).join(", ")}.`;
  if (skipped > 0) {
    note += ` ${skipped} more couldn't be read from this page and remain as URL references.`;
  }
  return note;
}
