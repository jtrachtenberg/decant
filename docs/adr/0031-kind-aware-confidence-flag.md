# ADR 0031 — A low convergence score only means something on a page made of fragments

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR 0030](./0030-page-level-column-model.md) — closes the residual
  it recorded, and corrects one attribution in it. See *Consequences*.

## Context

`columnConvergence` pools every emitted cell's start x across a page and scores
how tightly they cluster on a few positions. Below
`CONVERGENCE_FLAG_THRESHOLD` the page gets the flattened-figure marker: *"labels
may be scrambled and any values here are unreliable"*, and the page becomes a
candidate for attachment as an image.

It was calibrated on a WHO statistics report where confirmed chart-soup pages
scored ≤0.49 and clean prose and tables ≥0.95, and on that evidence the
threshold is sound. What the calibration never contained was a **designed
layout** — a page whose blocks legitimately start at many different x, because
that is what a layout is.

[ADR 0030](./0030-page-level-column-model.md) made such pages readable and
immediately produced the proof. `table-heavy` p26 holds three climate
commitments that used to come out as one welded cell —

> Achieve carbon neutrality in Extend beyond Scope 1 and 2 our SA and US
> operations by to include all GHG emissions

— and now reads as three headings with their own blocks. Its convergence fell
0.53 → 0.22, it gained the marker telling the reader its labels may be
scrambled, and that marker pulled it into the attached-figures PDF. The page had
just been un-scrambled.

**The metric is not wrong. Its meaning is conditional.** A chart's label soup and
a table read badly *should* line up and don't — there, failing to converge is
real evidence. A layout's blocks have no reason to share a left edge, so there
it is evidence of nothing.

### The pair that settles it

Two pages of the corpus score **0.48 apiece**:

| page | conv | what it is |
| --- | --- | --- |
| `table-heavy` p11 | 0.48 | "Governance", a subheading, and three commitment blocks — clean prose |
| `table-heavy` p33 | 0.48 | a Scope 3 category table whose values came away from their labels |

The marker is wrong on the first and right on the second, and no threshold on
the score can separate them.

## Decision

Keep the metric and the threshold. Add the second half of the question: **is the
page made of fragments or of sentences?**

`readsAsFragments(lines)` is the fraction of a page's emitted cells that read as
table cells (`isTabularCell` — short, or numeric). The marker fires only when
convergence is low **and** that fraction is at least `FLAG_MIN_FRAGMENTS`
(0.35). Over the corpus this splits every page the marker fires on today into
the two groups it should, with a clear gap:

| | pages | fragment fraction |
| --- | --- | --- |
| marker is wrong | table-heavy p26, p11 | 0.17, 0.26 |
| marker is right | table-heavy p33, chart-heavy p53, messy-scan p27, p43 | 0.42, 0.51, 0.54, 0.85 |

p53 is a CERN staff pie chart whose percentages have come away from their
labels; p27 is a location map read as county names and a legend; p43 is a
figure's `EXPLANATION` block. All three are exactly what the marker is for.

This is the page-level twin of ADR 0030's `MODEL_MAX_CELLY`, which asks the same
question of the material either side of a corridor. Both rest on the same
observation: **short and numeric is what data looks like; sentences are what
prose looks like**, and geometry cannot tell you which you have.

### What was measured and rejected

**Scoring per region instead of per page.** `partsCharScore` already exists,
already scores each leaf part separately, and already carries the diagnosis in
its own comment — *"judging the concatenation systematically punishes honest
splits, the support threshold scales with the combined line count"*. Using it
for the page-level flag looked obviously right and was measured during ADR
0030's development. It is worse: six `clean-text` pages become newly flagged,
`chart-heavy` p53 — a genuine flattened chart — becomes unflagged, and
`table-heavy` loses all three of its markers including the true one. (The test
also changed two things at once: `partsCharScore` returns the character-weighted
`charScore` where the flag reads the cell-count `score`.) Per-region scoring may
still be the right answer for `acceptSubSplit`, where it lives; it is not the
right answer here, because the problem is not the *scope* of the measurement but
the *kind* of page being measured.

**A new metric.** Not needed. Nothing about how cells line up was mismeasured.

## Consequences

The decantCC corpus, six documents and 308 analysed pages, swept against `main`
at `01b2cdb` (ADR 0030 merged):

| | count |
| --- | --- |
| pages whose convergence rose | 0 |
| pages whose convergence fell | 0 |
| pages newly flagged low-confidence | 0 |
| pages newly clean | 0 |
| unreliability markers | 46 → 44 |
| pages whose Markdown changed | 2 of 308 |

| document | pages | decision | attached |
| --- | --- | --- | --- |
| chart-heavy | byte-identical | ambiguous | 20 |
| clean-text | byte-identical | ambiguous | 2 |
| messy-scan | byte-identical | ambiguous | 66 |
| private-novel | byte-identical | ambiguous | 3 |
| public-famous | byte-identical | convert | 0 |
| table-heavy | 2/36 differ | ambiguous | 10 → 9 |

Both changed pages change by exactly one line — the false marker, 116
characters, removed. No other text on any page of the corpus moves, and no
convergence score moves, because nothing about the measurement changed. Every
marker that was right is still raised: `chart-heavy` p53, `messy-scan` p27 and
p43, `table-heavy` p33.

`table-heavy` p26 also leaves `flattenedPageNumbers`, so the attached-figures
PDF returns to the nine pages it held before ADR 0030. That closes ADR 0030's
only user-visible cost.

### A correction to ADR 0030

ADR 0030's residual attributed the extra attachment (9 → 10) to p8. It was p26 —
p8 falls in convergence but carries no marker at all, because a table is
recognised on it and that branch never runs. Its attachment never changed. The
sweep records this plainly and it was not read carefully enough at the time;
ADR 0030 is corrected in place.

### Residuals

- **The threshold is calibrated on six pages**, because six is how many the
  marker fires on across the corpus. The gap it sits in (0.26 → 0.42) is wide,
  but a seventh page could land inside it. The direction of error is unchanged
  from the original calibration: it errs toward *not* flagging.
- **`isTabularCell` is doing a second job.** It was written to decide whether a
  cell belongs to a table and is now also the corpus's best available answer to
  "is this text a fragment or a sentence". The two questions agree everywhere
  measured, but they are not the same question, and a document that sets real
  prose in very short lines — verse, a narrow sidebar — would read as fragments.
  `private-novel` does not, and it is the corpus's only literary text.
- **The low-structural-confidence table marker is untouched.** It fires from
  `looksTabular` on the branch above this one and was not examined here.
- Convergence remains the QA metric `scripts/sweep-corpus.mjs` reports, where it
  still cannot tell a well-read layout from a badly-read one. Reading it as a
  *change detector* is fine; reading it as a *quality score* on a layout page is
  what this ADR stops the product doing.
