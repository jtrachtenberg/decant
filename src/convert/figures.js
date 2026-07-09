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
import { fileBytes } from "./read-file.js";

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

// Extraction cap: a deck with forty pictures shouldn't explode the upload.
// First N in document (media-number) order. Sites whose per-message image
// limit is lower than this don't lose the overflow — the figures combine into
// a single labeled contact sheet instead (combineFiguresToSheet below).
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

  const zip = await JSZip.loadAsync(await fileBytes(file));
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

// --- Contact sheet: many figures → one labeled image ------------------------
//
// When a document yields more figures than the site accepts as attachments
// (claude.ai limits images per message), they combine into a single grid image
// with each figure's name drawn under its tile — the label lives in the
// pixels, so the model can still reference "deck-fig3" reliably. This is also
// the cheaper shape: the destination model downscales every image to the same
// effective budget, so one sheet costs roughly one image, not N. The tradeoff
// is per-figure resolution (an n-column grid divides it by n), which is why
// the sheet is the overflow path, not the default.

// Tile edge and caption strip, px. 3 columns of 512 ≈ 1536 — right at the
// long-edge budget chat models actually keep, so larger tiles would be
// downscaled anyway.
export const SHEET_TILE = 512;
export const SHEET_CAPTION = 24;

// Grid geometry for n tiles: near-square, row-major. Pure — unit-tested in
// Node; the canvas compositing below is not (no OffscreenCanvas outside the
// browser), so it stays a thin layer over this.
export function sheetLayout(count) {
  const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
  const rows = Math.max(1, Math.ceil(count / cols));
  return {
    cols,
    rows,
    width: cols * SHEET_TILE,
    height: rows * (SHEET_TILE + SHEET_CAPTION),
  };
}

// Compose the figures into one PNG File ("<doc>-figures.png"). Browser-only
// (OffscreenCanvas + createImageBitmap); callers catch and fall back to
// attaching what fits individually.
export async function combineFiguresToSheet(figures, docName) {
  const { cols, width, height } = sheetLayout(figures.length);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  for (let i = 0; i < figures.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = col * SHEET_TILE;
    const y0 = row * (SHEET_TILE + SHEET_CAPTION);

    const bmp = await createImageBitmap(figures[i]);
    // Contain-fit, centered; never upscale — a small logo blown up to 512px
    // reads worse than it does at natural size.
    const s = Math.min(SHEET_TILE / bmp.width, SHEET_TILE / bmp.height, 1);
    const w = bmp.width * s;
    const h = bmp.height * s;
    ctx.drawImage(bmp, x0 + (SHEET_TILE - w) / 2, y0 + (SHEET_TILE - h) / 2, w, h);
    bmp.close();

    // Tile border + caption make the grid legible to a vision model: each
    // cell is visibly one figure with its name attached.
    ctx.strokeStyle = "#d0d0d0";
    ctx.strokeRect(x0 + 0.5, y0 + 0.5, SHEET_TILE - 1, SHEET_TILE - 1);
    ctx.fillStyle = "#111111";
    ctx.font = "600 15px ui-sans-serif, system-ui, sans-serif";
    ctx.textAlign = "center";
    // Strip the extension from the caption — "deck-fig3", not "deck-fig3.png".
    const label = figures[i].name.replace(/\.[a-z0-9]+$/i, "");
    ctx.fillText(label, x0 + SHEET_TILE / 2, y0 + SHEET_TILE + 17, SHEET_TILE - 12);
  }

  const blob = await canvas.convertToBlob({ type: "image/png" });
  const base = String(docName ?? "figures").replace(/\.[a-z0-9]+$/i, "");
  return new File([blob], `${base}-figures.png`, { type: "image/png" });
}
