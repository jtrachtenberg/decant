# ADR 0025 — Crossing the gutter does not make a run full-width furniture

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

`columnRegions` splits a two-column page into reading-order regions. Rows whose
content genuinely spans the page — titles, headings, a full-width intro
paragraph — must not be cut at the gutter, so a cluster that crosses it is
collected into a *spanning* region instead of being routed into a column. That
test was crossing alone:

```js
const spanning = clusters.filter((cl) => cl.boxes.some(crosses));
```

Three quite different things cross a gutter, and promoting all of them costs
real meaning on one of them.

A USGS well-completion figure (`messy-scan` p31) prints drawing callouts down
the left and a specification list on the right. Its spec labels start at x≈318,
just right of the gutter at 317.4 — except `Protective Casing`, outdented to
x=290.3, 66pt wide on a 495pt measure. It crossed, so it was promoted to a
spanning region, while the value on its own dot-leader line stayed in the
column:

```
Protective Casing                          ← spanning region
Locking Cap and Padlock
Inner Well Cap
...............6" x 6" x 5' steel cover    ← right column, orphaned
```

That is worse than an interleave. An interleave is unreadable and therefore
self-announcing; this reads cleanly and asserts something false — a steel-cover
dimension belonging to the inner well cap. Nothing downstream can detect it.

The underlying cause sits further upstream, in `groupRows`, and is worth
recording because it is not fixed here. A row's merge tolerance is its
*tallest* box, so the callout `Locking Cap and Padlock` (h=10, reach 5.0pt)
claimed `Protective Casing` 4.7pt below it, while that label's own leader —
5.4pt below the callout, 0.7pt below the label — started a fresh row:

```
ROW y0=659.8 h=10.0: "Locking Cap an"[123-216] "Protective Cas"[290-356]
ROW y0=654.4 h=8.0:  ".............."[358-391] "6" x 6" x 5' s"[392-474]
```

Fixing that directly (assign a run to the *nearer* baseline) makes p31 perfect
and was measured on the corpus: it also perturbs financial-table
reconstruction, because `public-famous`'s balance sheet then trades
liability-column bindings for asset-column ones. Row grouping is upstream of
tables, headings and columns alike, so re-calibrating it is its own change.

## Decision

Keep the crossing test, and add a furniture test that a crossing cluster must
also pass. A crossing cluster is furniture when any of these hold:

1. **It is alone on its row.** Nothing shares the baseline, so it is a banner or
   a column header rather than one cell of a two-stream row.
2. **It starts at the measure's left edge** (within `SPAN_LEFT_TOL` median
   heights). Ordinary full-width lines do — including a paragraph's *short last
   line*, which is why width alone cannot be the test.
3. **It covers most of the measure** (`SPAN_WIDE_FRAC`) — a centred or outdented
   banner.

And a crossing cluster is only demoted when its row genuinely holds two
streams — when it has a row-mate on the **opposite** side of the gutter from
where it would land. A demoted cluster routes into the column its own centre
picks, where it rejoins its value.

Clause 1 is what a table of contents needs. There the gutter falls *between*
the entry labels and the page numbers (`clean-text` p2, gutter 516.3), and a
short right-hand `Page` header at [510.2–534.9] overhangs it. That header is
alone on its row; demoting it costs the table that the rows below it
reconstruct into. The opposite-side requirement is what a running footer needs:
`CL IMA TE R E` / `OR T 2025` / `MORGAN STANLEY…` crosses and has row-mates,
but they sit on its own side — it is one banner broken into runs, and splitting
it severs the banner.

## Consequences

p31 reads correctly for the first time: every specification label carries its
own value, and the four cross-stream bindings that the ADR-0012-era gutter work
repaired stay repaired.

Measured over seven real documents (~500 pages), by the project's own
column-convergence metric:

| | count |
| --- | --- |
| pages whose convergence rose | 11 |
| pages whose convergence fell | 8 |
| pages newly flagged low-confidence | **0** |
| pages newly clean | 1 |
| unreliability markers | 17 → 16 |

`public-famous` p33 — the page the preceding gutter fix rescued — is
byte-identical. `public-famous` p22 is a substantial further win of the same
class: prose that had been glued to a facing table column (`…inventory turnover
METHOD ONE`, `…goods are bought, Common Stock $`) now separates cleanly.

Line-level churn is larger than the page counts suggest (~1,290 lines) because
demoting a cluster changes region shape, which shifts the convergence scores
that `acceptSubSplit` compares — so nested-split decisions move on pages whose
output is otherwise equivalent. Two thresholds (`SPAN_LEFT_TOL`,
`SPAN_WIDE_FRAC`) are calibrated on this corpus and inherit its blind spots.

Left open: the `groupRows` nearest-baseline defect above, and with it the
question of whether the balance sheet should bind its asset or its liability
column when it cannot bind both.
