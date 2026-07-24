# ADR 0024 — An undecodable text layer is figure evidence, not text

- **Status:** Accepted
- **Date:** 2026-07-24

## Context

The USGS Deer Trail report (the `messy-scan` decantCC corpus doc, 98 pages)
converted with its entire figures section missing from the charts PDF, and
with a quarter of the emitted Markdown — 43,159 of 170,067 characters — being
the replacement character U+FFFD.

Physical page 28 (printed page 20, **Figure 2**, the METROGRO Farm map) is the
clean example. Its operator list is 420 `showText` ops and 24 paths: the map
is not drawn as vector artwork with labels on top, it is drawn *as font
glyphs*, from a cartographic font whose subset carries no usable `ToUnicode`.
pdf.js maps every one of those glyphs to U+FFFD, so the page extracts as 1,545
characters of which 1,464 are replacement characters — and that counts as
text. Every gate then read the page as healthy prose:

| signal | value on page 28 | consequence |
| --- | --- | --- |
| `chars` | 1,888 | above the text floor → a text page |
| `images` | 0 | no raster evidence |
| colored fills / hues | 0 / 0 | `hasVectorChartFills` false — the map is monochrome |
| convergence | 0.75 | above the flag threshold → not "label soup" |

`chartPage = hasText ? (images >= 1 || flattened) : significant` was therefore
false, and the page never reached the figures flow. The document's whole
figures section (Figures 1–4, 7, 8, 10, 13) and its data tables (physical
pages 46–66, drawn in the same kind of font, up to 99 % undecodable) failed
the same way. Only the 34 image-only scanned annex pages attached.

Two things were wrong, and they compound:

1. **The output was noise.** Pages emitted thousands of U+FFFD characters,
   which carry no information and actively bury the text that *did* decode.
   Page 28's real caption — "Figure 2 Metro Wastewater Reclamation District
   biosolids-application areas (METROGRO Farm)…" — was in there all along,
   drowned under 1,464 replacement characters.
2. **The page never attached.** The one faithful representation of a
   font-drawn map is a render of the page, and nothing routed it there.

This is the same root cause the corrupt-table hard signal already handles
(SPEC §3.9 — a font with no usable `ToUnicode`, which the WHO doc showed as C0
control characters in chart cells). Same disease, different symptom and a far
wider blast radius: C0 junk lands in a few cells of an otherwise-real table,
while this arrives as whole pages of it.

## Decision

**Measure the text layer's decodability, strip what fails, and treat the
failure as figure evidence in its own right.**

`textLayerGarble(items)` returns the fraction of a page's non-space extracted
characters that pdf.js could not decode — U+FFFD, plus private-use code points
(the glyph mapped, but only into a range whose meaning is the font's private
business). Whitespace is excluded: it survives a broken font map, so counting
it would dilute a 100 %-broken page toward "fine".

Three calibrated constants:

- `GARBLED_TEXT_RATIO = 0.3` — at/above this the text layer is broken.
- `GARBLED_MIN_CHARS = 50` — below this there is too little text to judge.
- `GARBLED_TOTAL_RATIO = 0.8` — at/above this essentially nothing readable
  survives, so the page has **no text fallback at all**.

Consequences, in order:

1. **Reconstruction strips the undecodable runs** before column/grid detection
   and leaves one marker line in their place. Stripping first also stops the
   noise polluting the reconstruction of the real text beside it — page 28's
   convergence rises 0.75 → 1.00 once the junk is gone.
2. **Classification routes the page into the figures flow** on the `garbled`
   flag alone. This deliberately does *not* go through
   `flattenedWithEvidence`: that gate exists because low convergence alone can
   be an ornate but purely textual layout, whose every word is already in the
   Markdown. Undecodable glyphs are a stronger claim — they *prove* something
   is being painted that we cannot read — so they need no corroborating
   raster. Which is essential here, because there is none to find.
3. **Totally-unreadable pages are exempt from the attachment cap**, joining
   image-only scans under one rule: their content exists only as the page
   image, so dropping one loses the page outright. Partly-readable garbled
   pages keep a text fallback and stay under the cap.

### Why a ratio, and why 0.3

The threshold sits in an empty valley rather than on a slope. Across the six
other corpus PDFs (clean text, chart-heavy, table-heavy, novel, famous,
image-only) **no page reaches even 0.05**; within `messy-scan` the affected
pages run 0.41–1.00 and nothing at all lands between 0.05 and 0.41. The
signal is essentially bimodal, so the exact cut is not load-bearing.

### Rejected: vector paint volume as figure evidence

The first candidate for rescuing these pages was "many path ops with no
raster = a drawn figure". Measured across the corpus it is unusable: the
figure pages carry 121–467 paths, but `clean-text` has a median of 243 and
`table-heavy` a median of 248 (max 3,245) — ordinary rules, underlines and
cell borders. The distributions overlap almost completely. Dropped.

## Consequences

On `messy-scan`, end-to-end through the built CLI:

- Charts PDF **35 → 66 pages**, now including page 28 and the whole figures
  section; every one of the 32 newly-detected pages attaches.
- Markdown **170,067 → 120,436 characters**, with **43,159 → 0** replacement
  characters, and page 28 emitting its page label, its real map labels
  (U.S. HIGHWAY 36, JOLLY ROAD, ARAPAHOE COUNTY ROAD 34) and its Figure 2
  caption instead of a wall of replacement characters.
- The other six corpus documents' inspect reports are **byte-identical** — no
  page in any of them is garbled, so the whole path is inert for them.

Costs and residuals:

- **Attachment volume.** A document this broken now attaches 66 of 98 pages.
  That is the honest outcome (the alternative is silently losing them), but it
  is a large companion PDF, and there is still no hard size budget on vector
  page copies.
- **Marker text counts toward `chars`.** As with every other marker,
  `linesToText` includes the marker line, so a wholly-undecodable page reports
  ~140 characters rather than ~0. Routing does not depend on this (the
  `garbled` flag qualifies a page on either side of the text floor), but
  `contentPages` and `totalChars` are correspondingly optimistic. A document
  that is *entirely* garbled would therefore classify `ambiguous` rather than
  `passthrough` — the user is still offered the original, so this is
  acceptable, not silent data loss.
- **Not covered: clean-text charts with no raster.** `messy-scan` pages 39–42
  (Figures 11 and 12) are genuine charts whose labels decode fine. Convergence
  flags them (0.20–0.49) but `flattenedWithEvidence` rejects them for want of
  a raster or colored fill, exactly as before this change. They remain
  unattached. Rescuing them needs a monochrome-vector figure signal that the
  path-count measure above failed to provide — left open.
