# ADR 0034 — A form's band headings sit between the columns' rules, not on them

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR 0025](./0025-straddling-runs-are-not-furniture.md) — a second
  promotion path beside the crossing test, for spans crossing can never see.
  [ADR 0029](./0029-baseline-bands-and-printed-rows.md) — a repair for the one
  cell shape that no baseline assignment can bind.

## Context

Standard Form 93 (a two-page government medical-history form) surfaced two
reading-order failures in one page, both in its item-10 checklist — a
three-column block of ~26 check items per column, each column headed
`CHECK EACH ITEM | YES | NO | DON'T KNOW`, with the form's items 8, 9 and the
block's own numbered title printed in a band directly above the columns.

### 1. A centred heading too narrow to cross anything

"10. PAST/CURRENT MEDICAL HISTORY" is set in 9pt over a 7pt body, centred on
the page — and 170pt wide over a 565pt measure, printed entirely inside the
middle column's x-range (x 222–392 against corridors at ≈209 and ≈397). Every
spanning promotion to date starts from a cluster **crossing** a corridor (ADR
0025's furniture tests then decide what it is). This heading crosses nothing,
so it routed into the middle column's bucket — and column-major emission put
item 9's "LEFT HANDED" (routed right) *after* the item-10 title, all of it
after every line of column 1. The band above the columns scrambled exactly as
far as the column walk reached.

### 2. A two-line cell centred on its row's baseline

The header's `DON'T KNOW` cell is set as two stacked lines vertically centred
on the row: baselines 427.3 and 418.9 flanking the row's 423.1, a half-leading
each side. No baseline assignment can bind that — "DON'T" is 4.2pt from the
row, beyond same-line reach, and nearer to nothing else — so the header read
as three lines: `DON'T` / `CHECK EACH ITEM YES NO` / `KNOW`. On page 2 the
same stack sits beside other header cells and the upper half glued *sideways*
into the neighbouring date-headers line instead.

## Decision

### Centred narrow headings span without crossing (`centeredHeading`)

`columnRegions` promotes a non-crossing cluster to a spanning region when it
reads as a block heading: **alone on its band**, in **larger type** than the
unit's median (≥ 1.2×), **centred on the measure** (± 1.5 median heights),
and **not flush-left** (an ordinary line). Two rejections carry the corpus:

- **Not a wrap's last line.** A same-size line one leading above, overlapping
  the candidate's x-range, makes the candidate that line's continuation —
  chart-heavy p50's "STAGE TO MEMBERSHIP", the third line of a wrapped column
  heading, promoted without this and welded two delegate columns into a fake
  pipe table.
- **Not mid-sentence.** A lowercase opening letter is a wrapped prose line
  whose position happens to centre (table-heavy p25's "behaviours like not
  speeding and", the middle of a paragraph).

A column's own heading never passes: left-aligned it starts at its column's
edge, centred it centres on its *column*, and only the full measure's centre
qualifies.

### Straddled stacks bind at the line level (`mergeStraddledStacks`)

After line assembly, three consecutive lines merge into one when the outer two
are each a **single terse cell** (≤ 2 tokens, ≤ 8 heights wide) of **matching
width** (mutual x-overlap ≥ 0.8 — a wrap's second line is short, which is what
keeps "Finished goods" / "intended use." apart), one leading apart, with the
middle line's baseline on their **midpoint** (± 0.3 heights) and every middle
cell **x-disjoint** from the stack (a prose or formula line between two others
overlaps them), one near enough to anchor it. The halves splice into the
middle line as one cell, in x order: `CHECK EACH ITEM YES NO DON'T KNOW`.

The first cut was a glyph-level merge before reconstruction, and the corpus
refused it: bullet dingbats pair with each other down every list, a definition
term pairs with its own wrap, and a formula's stacked labels pair across a
line that holds real content — 7 pages of damage across 4 documents. At the
line level the pattern only exists when the stack **survived assembly as
three separate lines**, which is precisely the failure being repaired; the
page-2 variant (upper half glued sideways into a neighbouring line) is out of
reach by construction and stays as it was.

## Consequences

- SF-93 page 1 reads in form order: items 8, 9 (both hands), the item-10
  title, then three columns each headed `CHECK EACH ITEM YES NO DON'T KNOW`.
- The 6-document corpus is **byte-identical** under both changes.
- A genuinely centred narrow heading over a two-column layout (a "Chapter"
  line narrower than the gutter gap) now spans instead of riding a column —
  the same shape, met in the wild before it was met in the corpus.
- Residual: page 2's `DON'T` still glues into the date-headers line (the
  sideways variant), and `PERIOD` — the wrap of `DATE OF LAST MENSTRUAL
  PERIOD` — still strays into the header row. Both are the pre-existing
  behaviour, untouched.
