# ADR 0029 — A baseline band is not a printed row

- **Status:** Accepted
- **Date:** 2026-07-31
- **Amends:** [ADR 0025](./0025-straddling-runs-are-not-furniture.md) — its
  straddler test is re-scoped to bands here. See *Consequences*.

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
`columnRegions`' own routing walk.

ADR 0025's straddler test is the exception, and it took a corpus run to find it.
`isFurniture` and `hasOpposingRowMate` decide whether a run crossing the gutter
is page furniture or one cell of a two-stream row, and the first of the three
furniture shapes is *alone on its row*. Read against settled rows that
misfires exactly where settling did its work: `Protective Casing` moves onto its
own leader's baseline, is then alone on its line, reads as a banner, and is
promoted to a spanning region — which flushes the accumulated column blocks and
drops the page from column-major to y-order. **ADR 0025's demotion was resting
on the mis-grouping this ADR removes**: the proof that the label was not a banner
was the callout printed level with it, and settling takes that row-mate away.

So both tests read **bands**. "Is anything else printed at this height, across
the gutter" is a question about the page's horizontal slice, not about which
cells share a line — a straddler with a band-mate opposite is that band's
content whether or not the two sit on one baseline. Everything else in the
routing walk still reads settled rows, so clusters still form per printed line.

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
of them — a correction to a narrow, contested case, not a re-shaping of row
grouping. Every pre-existing test is unchanged, and the p31 gutter sweep above
is byte-identical to `main` at all seven leader positions.

### The corpus measurement

The decantCC corpus, six documents and 275 analysed pages, swept with
`scripts/sweep-corpus.mjs` (`columnConvergence`, `CONVERGENCE_FLAG_THRESHOLD`
0.5, `CONVERGENCE_MIN_CELLS` 12):

| | count |
| --- | --- |
| pages whose convergence rose | 3 |
| pages whose convergence fell | 0 |
| pages newly flagged low-confidence | 0 |
| pages newly clean | 0 |
| unreliability markers | 45 → 45 |
| pages whose Markdown changed | 5 of 275 |

| document | pages | decision | attached |
| --- | --- | --- | --- |
| chart-heavy | byte-identical | ambiguous | 20 |
| clean-text | byte-identical | ambiguous | 2 |
| messy-scan | 1/98 differ | ambiguous | 66 |
| private-novel | 1/29 differ | ambiguous | 3 |
| public-famous | byte-identical | convert | 0 |
| table-heavy | 3/36 differ | ambiguous | 9 |

**ADR 0025's balance sheets are byte-identical.** The question it left open —
whether `public-famous`'s statement pair binds its asset or its liability column
when it cannot bind both — does not move. Neither does `clean-text` p2, the
table of contents whose short right-hand `Page` header depends on the
alone-on-its-row clause, nor `table-heavy` p32's rotated rails.

The five pages that move are all the same defect, the greedy band reaching
across independent baselines and gluing two streams into one line:

| page | before | after |
| --- | --- | --- |
| table-heavy p9 | `486companies` glued across two type sizes | three separate headings |
| private-novel p26 | formula subscripts glued to the run beside them | subscripts on their own baselines |
| table-heavy p15 | a sentence interrupted by a heading block | `strategy; bolstering the procurement` rejoins `process (including…` |
| table-heavy p22 | two columns 2.2pt apart glued into fabricated sentences | each stream's line intact; the one genuinely shared baseline still shared |
| messy-scan p35 | chart axis labels glued (`21Dec`, `21June`) | glue removed, labels scattered |

messy-scan p35 is the one page where the change is not clearly an improvement:
the false joins go, but the month labels emit as loose blocks. It is chart-axis
label soup either way, on a page already flagged and attached as a figure.

### What the measurement cost, and what it says

The first corpus run — settled rows in the straddler test — moved 8 pages and
regressed 2 of them, `messy-scan` p31 and `table-heavy` p8, both from
column-major to y-order. That is what surfaced the ADR 0025 coupling above, and
the band-scoped test removes both. It also gave up two real wins that the
regression mechanism had produced as a side effect (a rejoined sentence on
`public-famous` p41, and a heading un-glued on `table-heavy` p15); those pages go
back to `main`'s output. Removing a regression on the page this ADR is named for
is worth more than gaining a line elsewhere.

Worth stating plainly: **on p31 the corrected row model emits byte-identical
Markdown**. The rows are genuinely fixed — `test/rowgroup.test.mjs` pins the
specification label onto its own leader's baseline — but the output does not
move, because ADR 0025 had already patched around the mis-grouping from the
other side. The visible payoff is three modest wins on other pages. The value
here is that the row model now means what it says, and that the patch resting on
the broken model has been re-scoped rather than left to rot.

An honest limit on all of this: `table-heavy` p8 and p22 remain badly wrong in
both revisions. They are four-column and three-column layouts that column
detection never resolves, so column 1 glues to column 2 and three infographics
glue to each other. That is the n-column gap ([ADR 0012](./0012-n-column-guarded-recursion.md)),
untouched here.
