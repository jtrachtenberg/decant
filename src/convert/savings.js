// Token-savings estimate (M2). The project's thesis, made visible: uploading a
// raw PDF costs the model its text *plus* a rendered image of every page, so
// handing it Markdown drops that image layer. This module estimates how many
// tokens that saved, for a brief post-conversion badge.
//
// It is explicitly an ESTIMATE (and labeled "~" in the UI): token counts vary
// by model — claude.ai, ChatGPT, and Gemini all tokenize differently and price
// images differently — so we use a portable chars-per-token approximation and
// a conservative per-page image-token figure rather than false precision. Pure
// and exported; the constants are tunable in one place.

// ~4 chars per token is the standard rough figure for English-ish text. Good
// enough for a motivational estimate; a real tokenizer could drop in here.
const CHARS_PER_TOKEN = 4;
export function estimateTokens(chars) {
  return Math.ceil(Math.max(0, chars || 0) / CHARS_PER_TOKEN);
}

// Conservative tokens for one full-page image. A raw PDF renders every page to
// an image on top of its text (docs/ARCHITECTURE.md §1: a 100-page PDF whose
// text is ~30k tokens lands at 70–100k once page-images are counted →
// ~400–700 image tokens/page). We take the low end so we under-promise.
export const IMAGE_TOKENS_PER_PAGE = 500;

// Estimate one converted result's savings, or null when we can't defensibly
// estimate. PDFs only for now: their per-page image layer is exactly what
// conversion removes, and their meta carries pageCount. Office/HTML uploads
// aren't page-rendered the same way, so we don't claim savings there (yet).
// Returns { savedTokens, markdownTokens, originalTokens }.
//
// NOTE for when Office savings land: the ambiguous prompt's "Convert + attach
// figures" choice (Office-only today) sends the Markdown PLUS the document's
// images — each attached figure costs real image tokens on the destination
// model. An Office estimate must net that cost out, or the badge overstates
// savings exactly when the user chose to pay for images. Today this is moot
// by construction: figure-choice results are Office results, which return
// null here, so the badge stays silent rather than wrong.
export function estimateSavings(result) {
  const meta = result?.meta;
  if (meta?.pageCount == null) return null;
  const markdownTokens = estimateTokens(meta.totalChars);
  const savedTokens = meta.pageCount * IMAGE_TOKENS_PER_PAGE;
  return { savedTokens, markdownTokens, originalTokens: markdownTokens + savedTokens };
}

// Sum the estimable savings across a batch of converted results. Returns
// { savedTokens, originalTokens, percent, files } or null if nothing was
// estimable (e.g. a batch of only DOCX conversions).
export function aggregateSavings(results) {
  let savedTokens = 0;
  let originalTokens = 0;
  let files = 0;
  for (const r of results || []) {
    const s = estimateSavings(r);
    if (!s) continue;
    savedTokens += s.savedTokens;
    originalTokens += s.originalTokens;
    files++;
  }
  if (!files || savedTokens <= 0) return null;
  return {
    savedTokens,
    originalTokens,
    percent: Math.round((savedTokens / originalTokens) * 100),
    files,
  };
}
