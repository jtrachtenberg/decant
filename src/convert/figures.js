// Extract-and-reference (SPEC §4 M3, ARCHITECTURE §5 strategy 1): pull a
// document's embedded raster figures out as image Files so they can ride as
// sibling attachments next to the converted Markdown — the model pays image
// tokens only for the figures that matter, not a rendered page layer.
//
// PPTX/DOCX only: their images are plain zip entries (ppt/media/*,
// word/media/*), so extraction is free via the JSZip dependency the engines
// already use. PDF is the hard case (decoding image XObjects out of pdf.js)
// and stays out until it earns its complexity. Pure (no chrome.*), so the
// whole module unit-tests in Node with synthetic zips.

import JSZipNs from "jszip";

const JSZip = JSZipNs.default ?? JSZipNs;

// Where each format keeps its media parts.
const MEDIA_PREFIX = {
  pptx: "ppt/media/",
  docx: "word/media/",
};

// Raster formats chat surfaces accept. Office's vector metafiles (EMF/WMF)
// and anything else exotic are skipped — a surface that rejects an attachment
// mid-batch helps nobody.
const FIGURE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

// Junk filter (SPEC M3): media below this size is almost always document
// chrome — logos, bullet glyphs, background textures — not a figure worth
// image tokens. Tunable in one place.
export const MIN_FIGURE_BYTES = 4096;

// Attachment cap: chat composers limit per-message attachments, and a deck
// with forty pictures shouldn't explode the upload. First N in document
// (media-number) order; per-site limits can override this when profiles land.
export const MAX_FIGURES = 8;

// Can figures be extracted from this upload at all? Type-gated by extension —
// the same signal the engines route on.
export function figuresSupported(file) {
  return !!MEDIA_PREFIX[extOf(file?.name)];
}

function extOf(name) {
  return (String(name ?? "").match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();
}

// Office numbers media parts image1.png, image2.png, … so a plain lexical
// sort would put image10 before image2. Same digits-based ordering the PPTX
// engine uses for slides.
function mediaNumber(path) {
  return Number((path.match(/\d+/g) || []).at(-1) ?? 0);
}

// Extract the document's figures as File objects named after the upload
// ("deck-fig1.png", …) so their origin is obvious in the composer and in the
// model's context. Resolves to [] for unsupported types or a document with no
// qualifying media — callers degrade to the text-only conversion.
export async function extractFigures(file) {
  const prefix = MEDIA_PREFIX[extOf(file?.name)];
  if (!prefix) return [];

  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const paths = Object.keys(zip.files)
    .filter((p) => p.startsWith(prefix) && !zip.files[p].dir)
    .sort((a, b) => mediaNumber(a) - mediaNumber(b) || a.localeCompare(b));

  const base = file.name.replace(/\.[a-z0-9]+$/i, "");
  const figures = [];
  for (const path of paths) {
    if (figures.length >= MAX_FIGURES) break;
    const ext = extOf(path);
    const mime = FIGURE_MIME[ext];
    if (!mime) continue;
    const bytes = await zip.file(path).async("uint8array");
    if (bytes.length < MIN_FIGURE_BYTES) continue;
    figures.push(
      new File([bytes], `${base}-fig${figures.length + 1}.${ext}`, { type: mime })
    );
  }
  return figures;
}
