# ADR 0014 — Tag rails: binding letter chips to the items they annotate

- **Status:** Accepted
- **Date:** 2026-07-11

## Context

The Discovery report's phased-disclosure matrix (document page 9) tags every
disclosure item with 1–2-letter pillar chips (G/RM/S/MT), set in a narrow
rail a ~1.5-line corridor LEFT of each phase column's item text, vertically
centered on the (often multi-line) item. Measured end-to-end with an LLM:
asked which items relate to Governance, Sonnet answered correctly from the
original PDF but found only 2 of 4 from our Markdown — one item's chip had
spliced mid-label ("related issues in G reviewing capital"), and a whole
phase's chips were divorced entirely, because the depth-0 gutter vote landed
in the wide corridor the sparse rail sits inside and split the rail away
from its items.

Three structural reasons the existing machinery couldn't hold the binding:

- Gutter votes are corridor-dominated: a rail of ~12 sparse chips inside a
  130pt corridor cannot move the vote, so splits fall between rail and text.
- `tableFromColumns` requires row-block tops to pairwise align; chips are
  vertically CENTERED on their items, so a rail never row-corresponds.
- The chip-to-text corridor (~1.5 heights) straddles the cell-merge
  threshold, so per-cell handling is unstable: a fraction of a point decides
  whether a chip becomes its own cell or welds onto a wrapped line's text.

## Decision

Two mechanisms:

- **Rail adoption** (`railAdoption`, inside `columnRegions`): a cluster of
  ≥3 pure-letter chips whose start x agrees within half a median height,
  hugging the chosen gutter from the left across ≤3 heights, is an
  annotation rail of the RIGHT column — its boxes route right regardless of
  center, so the rail travels with its text down the recursion. Two vetoes:
  running text starting on the chip band (that's a text column's left edge),
  and a same-row neighbour close on the chip's left (that's a TRAILING
  anchor of the left column — a footnote letter after its line — not a
  leading tag of the right one).
- **Rail-table reconstruction** (`railTable`, in leaf prose): a leaf whose
  raw GLYPHS show a letter-chip band hugging the text band from the left is
  rebuilt as one grid row per item — chips in the first cell, the item's
  wrapped label joined into the second, chips assigned to item blocks by
  y-containment (blocks split at paragraph-sized gaps). Chips are detected
  on glyphs, not cells, because cell structure is unstable exactly in the
  corridor regime rails live in. The KEY legend sharing the leaf comes out
  as rows of the same table (| G | Governance |), which is the legend's
  meaning anyway.

Guard learned the hard way: the rail-table's "text side" must exclude ALL
chip-like boxes, not just the winning band — a region holding nothing but an
R-rail beside an S-rail (produced by the very split the symbol-rail veto
exists to reject) must not emit as a | R | S | table, because `sawTable`
bypasses that veto and locks the bad split in.

## Consequences

- The measured LLM failure closes: all four Governance items emit as
  `| G | <full joined label> |` rows, the KEY legend decodes the tags
  inline, and no chip splices into label text anywhere on the page.
- table-heavy p35 (the TCFD cross-reference index) improves as a side
  effect: its a/b enumeration anchors bind to their disclosure rows instead
  of gluing mid-sentence into the neighbouring pillar description.
- clean-text improves as a side effect: letter-"o" bullets pair with their
  items instead of floating as orphan lines.
- Every other corpus page is byte-identical.
- The item status values (Disclosed / In progress / Not started) are colored
  dots with no text layer; the existing vector-chart note continues to mark
  them as present only in the attached figure.
