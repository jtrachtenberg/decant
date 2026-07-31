# ADR 0027 — A table's rows need not fill every column

- **Status:** Accepted
- **Date:** 2026-07-31

## Context

`detectGrid` read a table as the longest run of **consecutive rows that all
begin content at the same x positions**. Every part of that sentence turned out
to be too strong for real financial tables.

**Consecutive and complete.** A sustainability report's emissions table
(`table-heavy` p32, printed 31) states `% Change` on its seven total rows and
leaves it empty on the other sixteen — sparse by design, confirmed with the
document's reader. No three consecutive rows ever shared a band set, so no grid
formed at all. The page fell through to the column-split path, which stranded
every row label above the table as a flat list and emitted the figures as a
bare numeric block with each short row's values packed **left**:

```
| SA | UK | US | FY2024 | % Change | FY2023 | FY2022 | FY2021 | FY2020 |
| 869 | 73 | n/a | 942 | 951 | 864 | 696 | 1 056 | 1 262 |          ← FY2023 under % Change
| 27 620 | 852 | 80 | 28 552 | (4%) | 29 630 | 30 589 | 30 012 | …  ← correct
```

Sixteen of twenty-three rows shifted one column, so every historical figure was
filed under the wrong year. The page carries a low-confidence marker, but a
model reading it still misattributes each one.

**The same x positions.** A column of figures is set flush **right**, so each
row's start moves with the width of its own number: down one 10pt column of
that table the starts range over 17pt, nearly three times `GRID_X_TOL`. A
column heading is set flush left over the same column, another 20pt out. One
row's starts describe the columns only as that row happens to set them.

**And the guard.** `gridIsPageColumns` separated N columns of prose from an
N-column table by the aligned run being a **slice** of the page with unaligned
rows around it. Absorbing a table's own ragged rows destroys exactly that
evidence — and the obvious escape (strict run for the guard, absorbed run for
emission) fails hardest where it matters: p32's strict run is a four-row
fragment, and the table's remaining nineteen rows read as textbook "outside
support" for prose.

## Decision

Four changes, and a rebuilt guard.

**Bands are intervals, derived from the run.** A segment belongs to the band it
falls in (`bandOf`, which is how `gridLines` already assigns cells) rather than
matching a band within a tolerance. Bands are then **re-derived** by clustering
every start the run collected at the spacing that separated segments in the
first place, and reported at each cluster's **left edge** — a mean sits right of
the widest entry in a right-aligned column and would push it one column over.
Adjacent bands that no row ever fills together, and that sit closer than the
run's typical column pitch, fold into one: a row-label column with an indent
level per nesting depth is one column, not five of almost entirely empty cells.

**A row belongs when it fills a majority of the bands** (`GRID_MIN_FILL`), not
all of them. The bar is a majority because a run of prose beside a diagram
begins content in one or two columns, never in six of eleven.

**A run steps over rows that don't** — at most two at a time, and only rows that
are plainly not rows of the table: they fill a single band, or they state
nothing outside the columns the last belonging row filled and set no row label.
The row-label clause is what stops a facing column of body text being swallowed
line by line; it is waived when the leftmost band is a **rail** of numbers and
short markers, as a balance sheet's line-item numbering is, because there the
label-only rows genuinely begin at that band.

**Wrapped cells merge, and figures don't wrap.** A row at line spacing rather
than row spacing, set at the same size, filling no column its predecessor left
empty, and sharing no band where either side is a bare value, is a continuation
and folds into the row above. The last clause carries most of the weight: a
densely set table of figures runs its rows barely wider than its leading, so
pitch alone reads every other row as a continuation and glues `508` to `516`.

**The guard is rebuilt on vertical extent.** A table's column is exactly as tall
as the table. A page column is taller than any run of rows that happens to line
up inside it — a governance spread sets six committee descriptions side by side,
and each keeps setting lines at its own x for another ten baselines after the
last one they all share. A grid is rejected when **two or more** interior bands
have at least two rows outside the grid's own vertical span, reaching more than
two body rows past its top or bottom. Two, because one band that keeps going is
a coincidence that costs a real table its structure: a conversion table's "To
obtain" column shares an x with the two centred formulae below it, and nothing
else on that page corroborates.

`regionProse` asks for a grid per page column as well as per page — a 3-column
comparison table inside a 2-column page is invisible to full-width row grouping
— but only takes the answer when an aligned grid actually comes back, and never
over a leaf that carries a tag rail (ADR 0014), whose reading is the more
specific one.

### A table does not own the text set larger than it

`gridLines` drops boxes that float beside a grid, which is right for a chart's
axis label or legend: furniture belonging to the figure, and shredding it into
data rows is worse than omitting it (ADR 0009, and two tests encode it).
Furniture is set **at or below** the size of what it annotates.

`public-famous` p25 is the other way round. The page teaches how to read an
income statement: the statement is set at **4pt** — a prop, deliberately too
small to read, because the page's subject is the document's format and not its
figures — and it is annotated from both margins at 9pt. The annotations *are*
the content. This change makes the page form a grid where it previously did
not, so the drop policy reached them and deleted twelve words of the only text
on the page that says anything.

Text set a size tier above the grid is therefore neither merged into cells nor
dropped. It is handed back to reconstruction as its own band, the same
treatment the material above and below the grid gets, one margin at a time —
run together, a worked example's two margins offer the column-pair upgrade a
set of pairwise-aligned blocks and emerge as a table welding one margin's
sentences to the other's.

The 4pt statement itself **stays transcribed**, which was weighed and decided
rather than left open. The prop-layer test (ADR 0026) drops a page's smallest
cohort only up to 3pt while barring it from setting body height up to 4pt — the
two thresholds differ deliberately, because a WHO statistics report sets **4pt
chart labels that are the data**. p25's props sit in that gap at exactly 4pt,
so dropping them would need a discriminator that size alone cannot supply. And
the cost of keeping them is low here in a way it was not on p7: this statement
is a worked example of a fictional company, so transcribing it asserts nothing
the document does not print, where p7's props were dimensioned artwork whose
figures a reader would have taken for a real balance sheet.

## Consequences

Across the six-document decantCC corpus, whole-document Markdown:

| document | change |
| --- | --- |
| `chart-heavy` | byte-identical |
| `clean-text` | balance sheet and cash-flow statements bind row-major; no text lost |
| `messy-scan` | the report-documentation form binds; one chart-label page formalizes |
| `private-novel` | TCFD risk and opportunity tables complete, including a 5-column matrix that previously spilled its last column as loose prose |
| `public-famous` | the comparison table of p17, both balance sheets and the income statement bind row-major |
| `table-heavy` | p32 gains its row-label columns and stops shifting years; the climate-metrics table binds; the phased-disclosure and governance spreads are byte-identical |

Known residuals, all characterised:

- Two **section headings** inside a table are absorbed into the label cell of
  the row above (`table-heavy` p31: "on-site (renewable via direct line) Water
  (SA)"). They sit at continuation spacing and continue no figure, so nothing
  currently separates them from a wrapped label.
- A page of **chart labels** on a scanned figure page now assembles three rows
  into a pipe table (`messy-scan`). The content is unchanged and the page keeps
  its flattened-figure marker.
