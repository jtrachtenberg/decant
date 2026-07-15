# ADR 0018 — Panel-heading rebinding: attributing side-by-side tables to their headings

- **Status:** Accepted
- **Date:** 2026-07-14

## Context

A page of side-by-side PANELS (the Discovery phased-disclosure spread, the
same page ADR 0014 and ADR 0017 worked) sets each panel's heading at the
panel top — and the three headings share baselines. Reconstruction reads
those baselines row-major, so the headings emit at the page top as
interleaved band lines ("PHASE 1 PHASE 2", "Foundation Enhancements and
additions of strategy"), far from the panel tables below — which themselves
fused into ONE contiguous pipe table, since linesToMarkdown merged every
adjacent grid line into a single run.

Measured end-to-end: asked which Governance elements are In progress and
under which phase heading they fall, Sonnet found the right element (the
ADR 0017 status column works) but attributed it to PHASE 1 — it sits under
PHASE 2. Nothing in the emitted Markdown could answer the phase half of the
question; the guess was the best available.

## Decision

Two mechanisms, both in classify.js emission:

- **Per-leaf table identity**: every railTable leaf stamps a `tableId` (and
  its panel's x-extent) on its rows; linesToMarkdown breaks grid runs where
  the identity changes. Side-by-side leaves emit as separate pipe tables —
  the boundary a reader needs before any heading can mean anything.
  Geometry-grid and column-table lines carry no id and fuse exactly as
  before.
- **Heading rebinding** (`rebindPanelHeadings`, on the final lines): a short
  cell (≤ 40 chars) stranded ABOVE the first table whose own x-span sits
  inside one panel's extent (± 8 pt — panel subtitles are set a few points
  OUTDENTED from the panel's content) moves to directly above that panel's
  table, ordered by its own y so "PHASE 2" precedes its subtitle. First-match
  assignment sends headings to the upper of two runs sharing an extent (a
  panel's table and the KEY legend below it).

Deliberately narrow gates: the pass runs only when the page has two or more
x-DISJOINT extent-bearing tables (a single-column page's intro prose must
never move — most documents never qualify); only lines above the first table
are candidates; and a cell spanning several panels (a banner across the
spread) or longer than a heading stays put.

## Consequences

- The measured failure closes: each phase table now opens with its own
  heading (`### PHASE 2 Enhancements and additions` directly above the
  In-progress Governance row), and the phase-attribution question is
  answerable from the Markdown alone.
- A pleasant side effect: pulling the band cells out of the display band lets
  the left column's display heading merge cleanly ("OUR PHASED APPROACH TO
  ADVANCING OUR" instead of four interleaved fragments).
- Whole-document Markdown across the six-doc corpus is byte-identical except
  the intended page.
- Residual: the KEY legend still shares the phase-1 table (same railTable
  leaf, per ADR 0014 — its rows are self-describing). And headings BELOW or
  BESIDE their panel don't rebind — no corpus page needs that yet.
