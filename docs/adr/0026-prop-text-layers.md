# ADR 0026 — Type set as artwork is not body text

- **Status:** Accepted
- **Date:** 2026-07-30

## Context

`modeHeight` estimates a document's body-text height as the mode of line
heights weighted by character count. That weighting was itself a fix (commit
a05485b): counting *lines* let 40+ tiny chart labels out-vote ~18 real body
lines on a WHO figure page, making every 9.5pt paragraph look 1.7× "taller than
body" so it emitted as a heading.

Character weighting cannot fix the inverse case, where the small type is both
numerous *and* long. A financial primer's explainer spread (`public-famous` p7)
draws three miniature financial statements as **1.6pt** type — purely visual
structure for the 9pt commentary wrapped around them:

| type size | chars | what it is |
| --- | --- | --- |
| 20.0 | 52 | page title |
| 11.5 | 291 | deck |
| 10.0 | 188 | statement labels |
| 9.0 | 1,193 | **the commentary** |
| 8.5 | 544 | commentary cont. |
| 2.9 | 192 | miniature statement titles |
| **1.6** | **6,971** | **the miniature statements** |

The props are 7,163 of 9,431 characters — more than 3× the real content. They
won the vote outright, so `bodyH` was 2pt and every readable line measured 4.5×
body. The page emitted 32 heading lines, including its own body prose as `# `
H1s. They also glued onto the commentary and shipped as pipe tables:

```
Balance SheetGives a “snapshot” of the CONSOLIDATED BALANCE SHEETS(Dollars in…
what the company owns and whatit owes at the report date. Thebalance sheet is
always divided into Investment securities, at costTotal Other AssetsTotal Assets…
| Accounts receivable—net of allowance… | 156,000 | 145,000 | Accrued expenses…
```

Those pipe tables are the sharper problem. The figures in them are not data the
document states — they are dimensioned artwork illustrating where numbers *go*.
Emitting them as a table asserts a balance sheet that was never claimed.

## Decision

Detect a **prop layer**: a page's smallest type cohort, when all three hold —
the cohort is implausible as body type in absolute terms, the readable cohort is
a clear tier taller, and that readable cohort holds a real share of the page's
characters. All three are needed. A ratio alone cannot distinguish "the winner
is artwork" from "the page has a 34pt display heading" (also a 3.8× spread), and
demoting the latter reads a legend as a table.

Apply it at **two strictnesses**, because the two consumers carry different
risk:

- **Drop** (`tinyPropCutoff`, in `reconstructPage`): ≤3pt and ≥3×. Strips the
  runs before reconstruction, mirroring ADR 0024's treatment of undecodable
  text, and leaves a marker. Cutoff is the readability floor rather than the
  winning cohort, so p7's 2.9pt statement *titles* go with its 1.6pt figures —
  left in, they interleave through the commentary.
- **Vote** (`modeHeight`): ≤4pt and ≥2×. Bars props from defining body height
  without deleting anything.

The marker deliberately makes **no promise of an attached figure**, unlike
`garbledTextMarker` — routing a page into the figures flow is a caller
invariant this does not earn.

Calibration came from a real false positive, not from theory. WHO statistics
pages set **4pt chart labels that are the data** — `"1. Diabetes mellitus"`,
`"1. COVID-19"`, `"AFR"`, 1,500+ characters of leading-cause names per page —
beside 10pt commentary. A 4pt cap with a 2× ratio deleted them, which is far
worse than the artwork the test was written to drop. The drop thresholds exclude
those pages twice over: 4pt exceeds the cap, and at 3× their 10pt commentary
stops counting as "clearly taller", taking the share to 0.4%.

## Consequences

Six of seven corpus documents are **byte-identical**, the WHO report among them.
All change is confined to `public-famous`:

| page | before | after |
| --- | --- | --- |
| p7 | 32 heading lines; commentary shredded and interleaved; prop figures as pipe tables | 4 heading lines; commentary reads as continuous prose; marker |
| p13 | prop layer inline | marker; readable text only |
| p35 | 11 heading lines, incl. body prose and `# page 32` as H1s | 4 heading lines; annotations read as prose |

The absolute margin between artwork and data is thin — 3pt versus 4pt — and it
is only comfortable in *ratio* (5.6× versus 2.5×), which is why the ratio
carries the decision. A document setting genuine content at 3pt or below would
lose it; nothing in the corpus does, and such type is unreadable at 100% zoom by
construction.

Left open: p25 keeps its 4pt prop layer in the transcription, since at 4pt this
corpus offers no evidence separating artwork from data. Only the body-height
vote protects it.
