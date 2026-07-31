# ADR 0028 — Rotated text, and the rails a table heads its rows with

- **Status:** Accepted
- **Date:** 2026-07-31

## Context

`toBox` built every run's box as `x0 + width`, `y0 + height`. That is only true
where the run's baseline is the page's x axis, and pdf.js does not promise it:
`width` is the advance along the run's **own** baseline and `height` its type
size perpendicular to it.

`table-heavy` p32 rails its emissions table with rotated group labels — set
bottom-to-top in an 8pt-wide strip down the left margin, spanning the rows they
head:

```
[0 8 -8 0] x=75 y=314 w=54  "Scope 1 and 2"        → strip x 67–75, y 314–368
[0 8 -8 0] x=48 y=226 w=64  "Scope 1, 2 and 3"     → strip x 40–48, y 226–290
[0 8 -8 0] x=75 y=222 w=30  "Scope 3"              → strip x 67–75, y 222–252
[0 8 -8 0] x=48 y=113 w=25  "Out of"               → strip x 40–48, y 113–139
[0 8 -8 0] x=57 y=113 w=25  "scopes"               → strip x 49–57, y 113–139
```

Read as horizontal, each strip became sixty-odd points of text sitting **on one
baseline**. It welded to whatever was printed there, and claimed a row of the
table for itself:

```
| Scope 1 and 2Total Scope 1 and 2 (location-based) |  | 27 620 | 852 | …
| Scope 1, 2 and 3Scope 3 |  |  |  |  |  |  |  |  |  |  |  |        ← a row with no data
| Out ofscopes | Total |  |  | 10 | – | – | 10 | (87%) | 80 | …
```

This surfaced only once ragged rows bound (ADR 0027) and the page formed a grid
at all; before that the same glyphs were scrambled by the column-split path,
where the damage was invisible among everything else that page got wrong.

## Decision

**The box comes from the transform.** Four corners, mapped through the run's
own axes. Where the baseline is the x axis this reduces exactly to `x0 + width`
/ `y0 + height`, so horizontal documents are byte-identical; where it is not,
the box is the narrow strip the label actually occupies. The **type size** is
carried alongside as `h`, because for a rotated run the two are different
measurements — the box is as tall as the label is long — and every height test
(row grouping, body-height votes, the wrap and band-derivation size tests)
wants the type size.

**Two rails side by side are two lines of one label.** A rail that runs to two
lines sets the second alongside the first, an em to the right. Along the page's
x they abut, so the word-gap test read them as mid-word (`Out ofscopes`).

**A rail states its label once, on the first row it covers.** A rail heads a
*block*; written into the one row its baseline falls in, it reads as that row's
own label — and because a rail reads upward, that row is the block's **last**.
On p32 that put `Out of scopes` on the second of its two rows while the same
group's printed heading landed a column further in on the first, so the section
read as nested inside `Scope 1, 2 and 3` rather than beside it.

Once, and not repeated down the block, because **how far the block runs is not
knowable from the label**. A rail is centred in its block and usually much
shorter. Three rules were measured against the printed table:

| rule | `Scope 1 and 2` (7 rows) | `Scope 3` (11 rows) | `Scope 1, 2 and 3` (20 rows) | `Out of scopes` (2 rows) |
| --- | --- | --- | --- | --- |
| repeat over the rows the strip covers | 6 | 4 | 7 | 2 ✓ |
| partition the column at midpoints between rails | 7 ✓ | over by 6 | 16 | over by 6 |
| grow each rail symmetrically about its centre | 7 ✓ | 9 | 14, and none of them its first six | — |

Every extension rule over-claims somewhere, and over-claiming files rows under
a group the page never put them in — on p32 it puts the grand totals inside
`Out of scopes`. Repeating over the covered rows only is worse than stating the
label once: it claims the group for those rows and, by the blank cells either
side, *denies* it of the rest. A label stated once says less than the page does.
A label spread over the wrong rows says something else.

What actually closes a block on that page is the totals (`Total Scope 1 and 2
(location-based)`) together with the label indents — items at x 150, scope
totals at 88, cross-scope totals at 68, grand totals at 37. But `Scope 1`
(opens a block) and `Total Scope 1 and 2` (closes one) sit at the **same**
indent, so nothing separates opening from closing without reading the words.
That is left undone rather than guessed.

### Two repairs the same page forced

**The settle window.** `gridFromSeed` bounded its second pass by a reach that
rejects rows with content outside the seed's columns. That is the right test
for choosing a seed and far too strict for a boundary: a statement's grand
totals are outdented past every column the seed can see, so the reach halted
three rows early and a fixed two-row margin could not recover them. p32's last
row ended up outside its own table with its figures spilled into the footnotes.
The window now comes from the same reach with that one test dropped, so it is
bounded by how many columns a row fills rather than by where the seed's
leftmost is.

**Placeholders are figures.** A blank form writes each value as a placeholder
shaped like the number it stands for — `xx`, `(xx,xxx)`, `$X,XXX,XXX`. To
"figures don't wrap" (ADR 0027) those have to count as figures, or specimen
statements merge: whole sections of `clean-text`'s balance sheet were arriving
as a single row holding eight line items and their sixteen values in two cells.

## Consequences

Across the six-document decantCC corpus, whole-document Markdown, measured
against the branch this sits on:

| document | change |
| --- | --- |
| `chart-heavy` | byte-identical |
| `public-famous` | byte-identical |
| `private-novel` | binds a financed-emissions table's labels to its figures |
| `clean-text` | the specimen statements' line items come back as rows (278 lines) |
| `messy-scan` | rotated axis titles separate from their tick labels |
| `table-heavy` | p32 loses the welded labels and the empty row, keeps its last row, and reads 24 rows against a hand-checked reference of 24 |

Nothing is lost anywhere: the words that leave the output are the glued
compounds splitting back into real ones (`FEETDAILY` → `FEET` / `DAILY`,
`Out ofscopesTotal` → three separate cells).

Known residual, characterised: the rails are stated once rather than carried
down the rows they head, for the reason above. `table-heavy` p32 therefore
differs from its reference only in the two group columns, and only by blanks —
never by a figure, a label, or a row.
