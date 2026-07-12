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
// The ambiguous prompt's "Convert + attach figures" choice sends the Markdown
// PLUS figure attachments the destination re-renders — those pages' image
// cost was NOT saved. The caller records how many pages it reattached
// (result.attachedFigurePages) and each is netted out at the full per-page
// figure, which under-promises: a cropped figure costs less than the whole
// page it came from.
//
// NOTE for when Office savings land: the same netting applies to attached
// zip figures / contact sheets. Today Office results return null here, so
// their badge stays silent rather than wrong.
export function estimateSavings(result) {
  const meta = result?.meta;
  if (meta?.pageCount == null) return null;
  const markdownTokens = estimateTokens(meta.totalChars);
  const reattached = Math.max(0, result.attachedFigurePages || 0);
  const savedTokens =
    Math.max(0, meta.pageCount - reattached) * IMAGE_TOKENS_PER_PAGE;
  // The original's full cost includes every page's image layer — also the
  // reattached ones (they were part of the original upload's price).
  const originalTokens =
    markdownTokens + meta.pageCount * IMAGE_TOKENS_PER_PAGE;
  return { savedTokens, markdownTokens, originalTokens };
}

// Compact token count for display: 500 → "500", 1500 → "1.5k", 25000 → "25k".
// Shared by the post-conversion badge and the options page's lifetime total.
export function formatTokens(n) {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
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
