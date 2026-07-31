# ADR 0029 — A baseline band is not a printed row

- **Status:** Proposed — the code change is in, the corpus measurement is not.
  See *Consequences*.
- **Date:** 2026-07-31

## Context

[ADR 0025](./0025-straddling-runs-are-not-furniture.md) left a defect open and
named it precisely:

> A row's merge tolerance is its *tallest* box, so the callout `Locking Cap and
> Padlock` (h=10, reach 5.0pt) claimed `Protective Casing` 4.7pt below it, while
> that label's own leader — 5.4pt below the callout, 0.7pt below the label —
> started a fresh row.

```
ROW y0=659.8 h=10.0: "Locking Cap an"[123-216] "Protective Cas"[290-356]
ROW y0=654.4 h=8.0:  ".............."[358-391] "6" x 6" x 5' s"[392-474]
```

`groupRows` walks boxes in baseline order and admits one to the current row when
it lies within half the row's height — where "the row's height" is the tallest
box admitted so far. Two things are wrong with that. The reach is set by the
largest type on the line, which has nothing to do with how far the *next* line
sits; and the row claims by arriving first rather than by being closest. The
label above is 6.7× nearer its own value than the callout that captured it.

ADR 0025 measured the direct fix — assign a run to the nearer baseline — and
rejected it: it perturbed financial-table reconstruction, `public-famous`'s
balance sheet trading liability-column bindings for asset-column ones. That
verdict was read afterwards as an artifact of the prop layers
([ADR 0026](./0026-prop-text-layers.md) drops those miniature statements
outright), and so as void. It is not void, and the mechanism is worth writing
down, because it is not about balance sheets at all.

**Correct rows destroy the evidence gutter detection runs on.** `findGutter`
reads each row's largest interior gap and clusters the results; it needs at
least `MIN_COL_ROWS` rows showing a corridor. When a page's two columns are
typeset on *independent* baselines — a figure's callouts beside its
specification list, or two financial statements set side by side — no printed
line holds both streams, so no printed line has an interior corridor at all.
Today's mis-grouped rows do hold both, and the gap between the streams is
exactly the corridor `findGutter` wants. It has been finding the right gutter
off the back of the wrong rows.

Sweeping p31's geometry while moving the dot leaders away from their labels —
opening a corridor *inside* the right-hand column — shows the trade directly:

| leader start | gutter, bands | gutter, settled rows |
| --- | --- | --- |
| abutting the label | 317 | 317 |
| 370 | 317 | 317 |
| 380 | 317 | 379 |
| 390 | 317 | 389 |
| 400 | 317 | 399 |
| 412 | 317 | 411 |
| 420 | 317 | 419 |

The true corridor is at 317, between the callouts and the labels. Settled rows
put the gutter *inside* the spec list, which glues every drawing callout to the
label beside it. `findGutterByColumnStarts` is the designed fallback for
independent-baseline columns and gets 317 right — but it only runs when
`findGutter` returns null, and `findGutter` now returns a wrong answer instead
of nothing.

## Decision

Stop conflating two units that were never the same thing, and give each
consumer the one it actually asks for.

- A **band** (`bandRows`) is a horizontal slice of the page: everything printed
  at about this height, including runs from streams that share no line. This is
  the existing greedy grouping, unchanged.
- A **printed row** (`groupRows`) is a band settled onto nearest baselines: each
  contested box goes to the nearer of its own baseline and its neighbours',
  still bounded by the receiving row's reach.

`detectGutter` and `fragmentFitsGutter` read **bands** — a gutter is a corridor
of vertical whitespace, and only a unit spanning both streams can see one.
Everything that means "which cells share a printed line" reads **rows**: grid
binding (`detectGrid`), page-column detection (`gridIsPageColumns`), the
two-column text tables of `columnBlocks`, the tag-rail detector, and
`columnRegions`' own routing walk — including ADR 0025's `hasOpposingRowMate`
test, which asks literally whether a straddler shares its *line* with something
across the gutter.

Settling is deliberately conservative:

- Baselines come from the banding pass and never move. A band's `y0` is its seed
  box's, and no box is nearer to another baseline than to its own, so a seed
  never migrates and **no row can empty**.
- Reach stays the receiving row's tallest box. Settling only ever *reassigns* a
  contested box; it admits none the greedy pass would have refused everywhere.
- Candidates are the two neighbouring bands. Bands are built from a
  baseline-ordered stream, so a box's true home is its own or one beside it.

The rejected alternative was to tighten the reach itself — admit on
`min(row, box)` height rather than the row's. That splits legitimate rows
wherever small type sits beside large (a footnote marker, a superscript, a short
label beside a display figure), and it is the calibration ADR 0025's financial
tables were sensitive to. Settling changes no admission threshold.

Note the limit this inherits: settling needs a competing baseline to exist. When
a tall run's reach swallows a neighbouring line *entirely*, nothing seeds the
victim row and there is nothing to settle onto. Only a reach change reaches that
case, and this is not one.

## Consequences

`groupRows` now reports p31's rows as printed: the callout alone, and the
specification label with its own leader and value. That is the grouping ADR 0025
described and could not take.

Across the test suite `groupRows` is called 449 times and settling engages on 7
of them — it is a correction to a narrow, contested case, not a re-shaping of
row grouping. Every existing test is unchanged, and the p31 gutter sweep above
is byte-identical to `main` at all seven leader positions.

**The corpus measurement is outstanding, and this ADR should not be marked
Accepted without it.** ADR 0025 rejected this change on evidence from seven
documents and ~500 pages, using the project's column-convergence metric; that
corpus is not reachable from the environment this work was done in, so what is
recorded here is a mechanism and a controlled sweep, not a corpus delta. The
band/row split neutralises the one regression mechanism found — and it is the
mechanism that most plausibly produced ADR 0025's balance-sheet result, since a
side-by-side statement pair is exactly an independent-baseline two-column page.
But "most plausibly" is not "measured". Before this merges, re-run the
convergence sweep and check `public-famous`'s balance sheets specifically: the
question ADR 0025 left open — whether that sheet should bind its asset or its
liability column when it cannot bind both — is the one this change is most
likely to move.
