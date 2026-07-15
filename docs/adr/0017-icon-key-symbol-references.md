# ADR 0017 — Icon-key symbol references: naming textless symbols instead of attaching their page

- **Status:** Accepted
- **Date:** 2026-07-14 (proposed and implemented)

## Context

Some "chart pages" are really a small set of repeated icons interleaved with
lots of text: a boxed KEY defines each icon once, and the body repeats the
icons as per-row values. Attaching the whole page to the charts PDF pays a
full page-image cost to convey a handful of symbols. The exploration prompt
suggested the raster path (`repeatedImageDims` in raster-gate.js) as the
detection seam; the measurements below say the real work is on the vector
side.

Findings on the table-heavy corpus doc (the Discovery climate report; its
cover is labeled "A", so printed page N = physical page N+1):

- **Printed p9 (physical 10)** — the phased-disclosure matrix of ADR 0014.
  The KEY holds 7 icons: four G/RM/S/MT pillar chips and three status badges
  (Disclosed ✓ / Not started ✗ / In progress →). All seven are **vector**,
  not raster — the page's only repeated raster XObjects are the panel
  backgrounds and wave art, which the dims census already demotes as
  furniture. So `repeatedImageDims` cannot see this pattern at all.
  ADR 0014's rail table already recovers every one of the 24 disclosure rows
  with its pillar chip bound (`| MT | KPIs used to assess progress… |`) and
  decodes the KEY's chip rows inline. **The only information the Markdown
  loses is the per-row status badge** — textless vector paint, currently
  covered by the vector-chart note ("rows here may be missing their values")
  plus a 50%-of-page band-crop attachment.
- The three badge types reach the operator list through **three different
  paint mechanisms** (measured):
  - *In progress*: `rgb(0,181,176)` 12×12 pt path fills — 10 instances, one
    per arrow row plus the KEY, positions exact. Already recoverable from
    `constructPath` minMax geometry — but NOT from the existing
    `coloredFillBoxes`, whose 6-bucket hue is for the chart gate, not for
    identity.
  - *Not started*: `rgb(77,77,79)` fills — achromatic (chroma ≈ 2), so the
    current chroma-gated scan is blind to them. Two fills per badge (12 pt
    circle + 6 pt inner mark), 2 badges (KEY + the one "not started" row).
  - *Disclosed*: gradient circles — `shadingFill` inside form XObjects (the
    page runs 166 shadingFills). `shadingFill` paints the current **clip**
    region, which the scan's CTM replay doesn't track, and its color rides
    in a pdf.js-version-dependent pattern IR. The hardest of the three.
- **Printed p24 (physical 25)** — a different pattern: 2 standalone photos
  (383×467 px and 437×390 px XObjects) amid a large text block, each with
  its caption in the text layer. Not an icon-key page — a *per-figure
  attachment* case (see Companion scope).
- **Printed p22 (physical 23)** — neither pattern: an all-text scenario page
  whose 304 image ops are transparency-flattening debris of the header wave
  art. Its attachment is the known ADR 0015 residual (the 0.32-footprint
  wave component), not something icon extraction can or should fix.
- Benchmark stake: the corpus Q&A set already probes the pillar binding
  (`governance-elements-all-phases`); a status question ("which elements are
  not started?") is unanswerable from today's Markdown without the attached
  figure. Recovering status as text answers it directly and frees an
  attachment slot (the doc offers 29 figure pages against the cap).

The essential reframe: the user-visible goal ("extract each icon once and
reference it") is better served by **naming** the icons than by attaching
their pixels. The KEY already pairs every icon with its text label — decode
that mapping and each usage instance becomes a word, which is worth more to
an LLM reader than an image reference and costs nothing to attach.

## Decision

Three layers, all render-free (operator-list + text-layer geometry only):

1. **Symbol census** (raster-gate.js scanPageOps):
   - The CTM replay now composes `paintFormXObjectBegin` matrices (a
     latent bug fix: every box painted inside a form previously landed at
     the form's LOCAL coordinates — the Discovery badges live inside
     transparency-group forms) and tracks the clip box (pdf.js emits `clip`
     BEFORE the `constructPath` carrying its path).
   - `smallFills`: every geometry-bearing path fill with both edges under
     `MIN_IMAGE_EDGE_PT`, recorded with its **exact RGB** — no chroma gate,
     no hue bucketing: identity needs `rgb(0,181,176)` vs `rgb(0,214,253)`,
     not "both cyan-ish", and a "Not started" badge is achromatic dark.
   - `smallShadings`: `shadingFill` ops whose clip region is icon-sized.
     Their color rides in a pattern object the op args only name, so
     shading symbols fingerprint by geometry alone.
2. **Key plan** (symbol-key.js — pure, Node-tested):
   - Small paints merge into **icon composites** (containment merges too —
     a badge is circle + inner mark; a sliver-chained gradient strip
     outgrows icon size and drops). Class = identical multiset of member
     fingerprints (kind, exact RGB, ~2 pt-quantized size).
   - Candidate class: ≥ 2 instances, all **textless** (no text anchors in
     the box — letter chips are ADR 0014's job). Key entry: **exactly one**
     instance with a short label immediately right (colored bullets label
     every instance — no key forms). The keyed classes' key icons must
     form a **legend cluster** — one x-aligned stacked list or one
     baseline row — which is what separates a real KEY from a map page
     whose scattered marks happen to touch text (the messy-scan corpus FP).
   - Each usage becomes a **pseudo text item** carrying the label at the
     icon's position, flagged `symbolLabel`, injected before
     reconstruction — the ordinary pipeline binds the value to its row
     like any other glyph.
3. **Reconstruction binding + the suppression gate** (classify.js,
   inbrowser.js):
   - A `symbolLabel` glyph is always a cell of its own (never welded into
     a sentence), is exempt from marginalia extraction, and **adopts
     leftward** across a gutter it hugs — the value column converges so
     cleanly it ATTRACTS the gutter vote, and splitting there would orphan
     every value (the mirror of ADR 0014's rail adoption). railTable binds
     each label to its item block by y and emits it as the row's own value
     cell: `| MT | KPIs used… | Disclosed |`.
   - The vector-chart note and the page's figures-flow membership stand
     down ONLY when the accounting closes exactly (`plan.suppress`): no
     textless multi-instance class left unkeyed or ambiguously labeled,
     and every chromatic fill either decoded (keyed class) or text-bearing
     — a real chart's bars are neither, so its note survives any legend
     sharing the page. Any residue keeps today's behavior byte-identical;
     the injected labels are then a pure addition. A partially-decoded
     status column presented as complete is precisely the "quietly make
     answers worse" failure this gate exists to prevent.

scripts/inspect-pdf.mjs mirrors the wiring: a `k` flag per page, a
per-page symbol readout (entries, usage counts, accounting verdict), and
the `--page` dump shows the decoded Markdown.

## Companion scope (separate slices, not this ADR)

- **Per-figure photo attachment** (printed p24 case): on a figures-flow page
  with no chart evidence (no vector-chart fills, no flattened marker) whose
  significant components are each a single decodable XObject, decode each
  photo individually (the extractPdfRasterFigures machinery, minus its
  one-per-page and vector-op gates, which exist to protect charts that
  aren't there) and emit one mini-PDF page per photo, stamped "document
  page 24 · photo 1 of 2", with the association note quoting the nearest
  caption line. Replaces a 42%-of-page crop union with two small JPEGs.
- **Printed p22's false attach** is the ADR 0015 wave-debris residual and
  should be fixed there (its symbol census finds nothing to reference).

## Consequences

- The Discovery status matrix is fully text-faithful: all 24 rows carry
  pillar AND status (verified cell-by-cell against the rendered page —
  24/24 correct), the page leaves the charts PDF (attachments 10 → 9, one
  cap slot freed), and the ADR 0014 consequence line "status values …
  present only in the attached figure" closes. A provenance note
  (`appendSymbolKeyNote`) tells the reader the values were decoded from
  symbols via the page's key.
- Corpus sweep: the other five corpus docs are byte-identical. The
  messy-scan soil-map page formed a spurious two-class "key" during
  development (incidental map text right of scattered marks); the legend-
  cluster gate removed it and is a permanent requirement, at the cost of
  never decoding a page whose key has only one entry or whose legend is
  scattered — the fail-safe direction.
- The form-matrix fix in the CTM replay corrects all in-form geometry for
  every scan consumer (colored-fill boxes, xobject boxes); the sweep showed
  no existing signal shifted on the corpus, but future pages with charts
  inside form XObjects will now measure correctly where they silently
  didn't before.
- Scope honesty: this decodes *legend-defined repeated symbols on text
  pages*. It does not generalize to icons that vary per instance (sparkline
  thumbnails), keys defined on a different page, or raster icon sets — the
  census seam (composite fingerprints) extends to raster objIds naturally,
  but no corpus page needs it yet. Shading symbols fingerprint by geometry
  only, so two same-size gradient badge types on one page would collide
  into one class and (correctly) fail the one-label rule rather than
  mislabel.
- The decantCC corpus should gain a status question for this doc so the
  benchmark measures the recovery end-to-end (tracked separately).
