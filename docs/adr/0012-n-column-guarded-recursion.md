# ADR 0012 — N-column layouts via guarded recursive splits

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

Column detection split a page at **one** gutter. Designed reports (the
Discovery climate report / `table-heavy` corpus doc) run 3–4 side-by-side
streams per page: two prose columns plus a commitments panel whose entries
carry R/S symbol letters in a narrow rail. One gutter leaves two of those
streams in a single region, where they interleave line-by-line and often glue
mid-word ("goals.health."). On p7 the scramble was bad enough that the page
attached as a flattened figure — the attachment was compensating for text we
were mangling ourselves.

A naive fix — recurse `columnRegions` into each side, depth 2 — read the
3-column prose pages perfectly but regressed the corpus badly: a candidate
gutter exists *inside* tables and garbled scans too, and splitting those
reads them column-major (table-heavy p31 convergence 0.98→0.42, messy-scan
p50 0.80→0.18, private-novel p26 gained a false flattened-figure marker).

Two adjacent failures surfaced with it:

- **Prose-as-grid:** three aligned prose columns satisfy `detectGrid`'s
  aligned-starts test exactly like a bordered table, so p7 emitted fake
  3-column pipe tables — and `gridLines`' floating-box exclusion silently
  dropped the text that didn't fit the fiction (~95 chars on p7).
- **Symbol rails:** the most confident corridor in the commitments panel is
  the one in front of the letters rail; splitting there reads every entry,
  then a bare run of "R / S / R S" — each symbol divorced from its referent.

## Decision

**Recurse, but make every nested split earn acceptance**
(`regionProse` / `acceptSubSplit`, classify.js).

- Each non-table region gets nested split attempts up to depth 2
  (page → band → prose|panel). A candidate gutter alone is never sufficient.
- The guard compares the region read whole vs split:
  - **No degradation:** char-weighted convergence (each leaf column scored
    against its *own* line population — the page-wide support threshold
    misreads a legitimate short sidebar as noise, and per-cell counting lets
    one-letter cells veto the split that honestly separated them) may drop at
    most 0.06; 0.10 when the multi-cell interleave signature collapses by
    ≥ 0.4. Real over-splits crater it by 0.4–0.6 and stay rejected.
  - **Measurable improvement:** convergence gain ≥ 0.05, OR the multi-cell
    line fraction drops ≥ 0.1 (streams sharing baselines read as 2-cell
    lines), OR ≥ 15 % of whole-region lines have a cell running straight
    across the candidate gutter (the glue symptom).
  - **Not a table:** a split whose cells read short/numeric (`looksTabular`)
    is a table being scrambled — rejected. A nested `tableFromColumns` row
    correspondence upgrade is trusted as-is.
  - **No symbol orphans:** a leaf made ≥ 80 % of 1–2-char cells is a symbol
    rail; the split is rejected outright and the region retries once with
    that gutter excluded — the *next* corridor is often the right first cut,
    after which the rail pairs row-major with its entries.
- **Prose-vs-grid discriminators** (either demotes a detected grid to column
  reflow): bands that keep recurring as segment starts *outside* the grid's
  own rows across ≥ 60 % of the page height are the page's column origins,
  not table columns; and cells that wrap mid-sentence down each band
  (no terminal punctuation, lowercase continuation, ≥ 25 % of adjacent pairs
  with ≥ 50 % long cells) are running prose, which no table's vertically
  adjacent cells exhibit.

## Consequences

- table-heavy p3 and p7 read column-by-column; p7's commitments panel pairs
  every entry with its R/S letters on its own line — the letters were always
  in the text layer, only the ordering was wrong. p7 and p19 stop attaching
  as flattened figures (+817 chars recovered document-wide, the fake pipe
  tables gone).
- No corpus regression: decisions unchanged on all 6 docs, no page newly
  crosses the 0.5 convergence flag, the naive prototype's three regressions
  stay fixed (p31 0.98, p50 0.80, p26 unmarked). chart-heavy p50's delegate
  directory upgrades from a fake 4-column pipe table (with dropped names) to
  clean per-country lists; public-famous p7 recovers ~590 chars of financial
  values into labelled table rows; messy-scan p64/p66 shed false flags.
- Honest readings can score *lower* convergence than glued ones (a freed
  sidebar's ragged starts vs everything piled on one margin), so several
  pages' scores drop while their text improves (p28 0.96→0.62, still well
  clear of the 0.5 flag). Convergence measures start alignment, not order —
  the guard's multi-signal design exists because no single score can bless a
  split.
- The symbol-rail guard applies only to *nested* splits; a page whose
  top-level gutter fronts a symbol rail would still orphan it (no corpus doc
  does — noted as a residual).
