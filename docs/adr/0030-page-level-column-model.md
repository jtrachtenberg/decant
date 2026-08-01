# ADR 0030 — A page's columns are the page's, not each band's

- **Status:** Accepted (merged as #92, with the corpus measurement below)
- **Date:** 2026-07-31
- **Builds on:** [ADR 0012](./0012-n-column-guarded-recursion.md) (guarded
  recursive column splits) and [ADR 0013](./0013-display-band-reconstruction.md)
  (display bands). Replaces ADR 0012's binary split with an N-way one where the
  page has a model, and re-scopes ADR 0025's straddler test to the corridor.
  See *Consequences*.

## Context

Multi-column pages had no page-level notion of where their columns are.
`reconstructPage` chops a page into horizontal bands — above and below every
grid it finds, and again inside every region — and each band then ran
`detectGutter` from scratch over its own few rows.

`table-heavy` PDF page 8 (printed page 7) of the decantCC corpus is a designed
four-column spread. The user described it:

> Four columns. The rightmost is the global nav menu and the narrowest. The
> actual content starts at the leftmost column and reads left to right.
>
> - **Column 1** — page header "Our strategic response to climate change",
>   subheader, then six numbered objectives 01–06.
> - **Column 2** — header "Our climate change strategy is aligned with our
>   values and governed by the following principles:", then reads downwards.
> - **Column 3** (largest) — a header, three goal panels, then three text-based
>   infographics reading top to bottom and left to right.

The nav column is stripped correctly as repeated furniture
([ADR 0011](./0011-repeated-text-furniture.md)). Everything else came apart: the
six objectives were emitted in order but with columns 2's and 3's material
spliced between them, and the three infographics glued to each other line by
line.

### Three failures, tangled together

**The level.** The bands were not failing to *find* the page's corridors. They
found them and were outvoted. Column 3 holds three infographics standing side by
side, and the corridors between *those* are wider than either of the page's own
gutters; eighteen bands voted for one of them. A census over what the bands
**propose** cannot separate the two levels.

**The order.** The split was binary and recursed, so *which* corridor was cut
first decided what each side held — and the block flush runs between cuts,
fragmenting whichever side still held two columns.

**The kind.** Geometry cannot tell a page's columns from a data table's cell
boundaries. `clean-text` p16's partners'-capital statement opens corridors 5.7
to 9.0 median heights wide standing over the page's whole height, which is
indistinguishable from p8's 9.3 and 10.8.

## Decision

Decide a page's columns once, over the whole page, and impose them on every band
— in three parts, each of which the corpus insisted on.

### 1. The census counts contradictions, not proposals

A corridor of the page is one that runs the page's height with nothing printed
across it. Unlike a vote, that is a page-wide predicate every band can be asked
about directly and local density cannot sway:

- `open(x)` — bands with content on both sides of `x` and nothing crossing it
- `cross(x)` — bands with a cluster printed straight through `x`

On p8 the two corridors between the columns have `cross = 0` over a 48pt and a
55pt stretch; the infographic corridors carry 7 and 11 crossings, because column
3's own heading and its goal panels are printed across them.

`pageColumnModel(boxes)` returns the surviving corridors left to right, each
carrying a gutter x in `findGutter`'s existing convention (just left of where the
next column starts), so every consumer downstream reads the kind of number it
always did. It is one pass over the bands' clusters into three difference
arrays.

Four geometric guards, all stricter than the per-band ones, because the claim is
stronger — `detectGutter` says "these few rows read as two streams", the model
says "this is where the page's columns are, and no band may disagree":

| guard | value | what it rejects |
| --- | --- | --- |
| `MODEL_CROSS_TOL` | 0.2 of the bands that see it | p8's infographic corridors (0.27, 0.37), while surviving a full-width banner across a real corridor |
| `MODEL_MIN_WIDTH` | 5 median heights | ragged prose — `private-novel` p7 and p11 offered four corridors at 2.3–4.3 med; real design gutters run 6.1–10.8. Nothing sits between. |
| `MODEL_MIN_VSPAN` | 0.55 of the content height | a corridor beside one figure (`chart-heavy` p9, 0.15) or below one heading (`clean-text` p2, 0.48) |
| `MODEL_MIN_OPEN` | 8 bands (2 × `MIN_COL_ROWS`) | `private-novel` p2, a chapter opening whose seven bands cannot establish a page |

### 2. A layout column is not a table column (`MODEL_MAX_CELLY`)

No geometric guard can answer the third failure, and measuring says so plainly.
What separates them is **what is printed beside the corridor**. A data table's
columns are values lining up under a heading, so what abuts the corridor is
short or numeric; a layout's columns are blocks of prose standing side by side.
The fraction of abutting clusters reading as table cells (`isTabularCell`)
separates the corpus's two populations with a wide gap and nothing in it:

| | pages | score |
| --- | --- | --- |
| layout columns | table-heavy p8, p15, p21, p23, p26, p28, p34 | 0.07 – 0.21 |
| a tag rail | table-heavy p10 (chip \| item \| status) | 0.44 – 0.48 |
| data tables | clean-text p16, p37; messy-scan p32, p35 | 0.92 – 1.00 |

The threshold is 0.3. The model claims prose columns and nothing else, so a
statement, a worksheet, a tag rail and a chart's tick columns are left exactly
as they were — right twice over, since those pages are read row-major by
machinery that already understands them, and nothing else here could have told
them apart. `public-famous`'s balance sheets never produce a corridor at all.

This guard is what makes the next part safe.

### 3. Route every column in one pass, and ask the corridor about straddlers

With the model holding only layout boundaries, `columnRegions` cuts **all** of
them at once instead of one and a recursion. Each column becomes its own region
in reading order, and whatever is nested inside a column is found by the guarded
sub-split with its full budget. Cutting all of a *statement's* corridors at once
would slice its rows with no recursion left to re-test them — a first attempt at
this, before part 2 existed, did exactly that to `clean-text` p16 and
`table-heavy` p10.

And when the model supplied the gutter, a box must cross the whole **corridor**
to count as full-width furniture, not a line drawn through the middle of it.
Half a median height is a guess at the gutter's width; the model measured it.
Column 2 of p8 hangs its headings 14pt left of its own text edge, so they begin
inside the whitespace and reach only their own column — they cross the centre
line and nothing else. Judged against the centre they were promoted to spanning
regions, which shattered that heading and dragged column 3's heading and its
goal panels' term labels in with them.

All three parts are needed for p8: parts 1+3 without 2 destroy financial tables;
parts 1+2 without 3 leave p8's headings shattered and p26 badly interleaved.

### `COLUMN_SPLIT_MAX_DEPTH` still binds, and now means what it says

The depth limit exists to bound *speculation*. A corridor the page has already
established is not speculation, so taking one no longer spends the budget,
leaving both guarded levels for the sub-columns *inside* a column.

## Consequences

The decantCC corpus, six documents and 308 analysed pages, swept with
`scripts/sweep-corpus.mjs` (`columnConvergence`, threshold 0.5, min cells 12):

| | count |
| --- | --- |
| pages whose convergence rose | 1 |
| pages whose convergence fell | 3 |
| pages newly flagged low-confidence | 2 |
| pages newly clean | 0 |
| unreliability markers | 45 → 46 |
| pages whose Markdown changed | 12 of 308 |

| document | pages | decision | attached |
| --- | --- | --- | --- |
| chart-heavy | byte-identical | ambiguous | 20 |
| clean-text | byte-identical | ambiguous | 2 |
| messy-scan | byte-identical | ambiguous | 66 |
| private-novel | byte-identical | ambiguous | 3 |
| public-famous | byte-identical | convert | 0 |
| table-heavy | 12/36 differ | ambiguous | 9 → 10 |

**Five of six documents are byte-identical.** Only the designed report moves,
which is the whole of this ADR's remit. Every page the task named as at risk —
`public-famous` p17/p22/p33, `clean-text` p2 and p16, `messy-scan` p31,
`table-heavy` p32's rotated rails, `table-heavy` p10's tag-rail table — is
untouched.

### No page loses a word

Every changed page was compared word by word against the base revision. Nothing
is deleted. p8 *gains* three words by un-gluing streams the old reading ran
together: `withour` → `with our`, `withTCFD` → `with TCFD`, `transparencyand` →
`transparency and`.

### What the twelve pages do

| page | change |
| --- | --- |
| p8 | headers joined into one line each; the goal panels keep their term labels and bindings; objectives 01–06 contiguous; the three infographics separate |
| p26 | the three commitments become their own headings and blocks — they were one welded cell reading "Achieve carbon neutrality in Extend beyond Scope 1 and 2 our SA and US operations by to include all GHG emissions" |
| p23 | scenario descriptions stop interleaving; convergence 0.91 → 0.99 |
| p24 | `# CLIMATE-RELATED` + `# OPPORTUNITIES` join; a two-line subheading joins and moves to where it belongs |
| p14, p22 | a sentence stranded at the top of the page returns to its place in the stream |
| p21 | five welded table rows become seven headings and their blocks |
| p7, p15, p17, p34 | headings join; block boundaries move |
| p20 | a false pairing removed — see below |

**p20 is a correction, not a regression, and the page settles it.** It read as
`| Short term | Medium term | Long term |  |` over
`| Very high | High | Medium | Low |` and now reads as
`Risk rating:` / `Time frame` / `Very high High Medium Low Short term Medium
term Long term`. The page shows two *independent* legends side by side — four
coloured dots keyed to risk ratings, and a colour-gradient bar keyed to time
frames. The old table asserted "Short term = Very high", a pairing that does not
exist; four rating columns against three time frames was the tell. Both legend
labels survive and the values keep their printed order. Neither reading carries
the meaning, because the meaning is the colour: without the image layer this
area is a key to symbols that the text layer does not contain.

So **no page in the corpus reads worse.**

### Residuals

- **`columnConvergence` cannot referee this change.** p26 falls 0.53 → 0.22 and
  gains a "labels may be scrambled" marker on the page where its three
  commitments have just been un-scrambled — and that marker is what pulls it
  into the attached-figures PDF (9 → 10). p8 falls 0.59 → 0.26 while reading
  correctly for the first time, though it carries no marker (a table was
  recognised on it, so that branch never runs) and its attachment is unchanged.
  *Corrected in [ADR 0031](./0031-kind-aware-confidence-flag.md), which
  attributed this attachment to p8 on first writing.* The metric pools
  every cell start on the page and rewards them clustering on a few x positions.
  That is a sound proxy for a data table, whose cells *should* align, and an
  unsound one for a layout, whose blocks should not. `partsCharScore` already
  exists for precisely this reason and says so in its own comment — "judging the
  concatenation systematically punishes honest splits" — but it is used only
  inside `acceptSubSplit`, not for the page-level flag.
  Swapping the page flag to it naively was measured and is *worse*: six
  `clean-text` pages become newly flagged. The right shape is a kind-aware flag
  — convergence where the page reads as data, direct interleaving evidence
  (`multiCellFraction`, `gluedFraction`, which measure the actual failure rather
  than a proxy) where it reads as layout — and that is its own change with its
  own measurement, now that this ADR supplies the layout/data distinction it
  needs.
- **The page header on p8 is still in two pieces**, `# Our strategic response
  to` and `# climate change`, and the same header is emitted a second time
  mid-page. Improved from four fragments; not solved.
- **The cross-page `hint` is not unified with the model.** They are the same
  idea at two scales, and `hint` remains a single x accepted by
  `fragmentFitsGutter`.
- **A layout panel still emits as a pipe table** where a grid is detected inside
  it (p8's goal panels). The bindings survive and read correctly down each
  column, but a layout is being presented as data. `gridIsPageColumns` is the
  existing test for this and does not fire on so short a run.

### Why this needed a corpus run and not an argument

Four mechanisms here were wrong on the first try and only the corpus said so:
the leftmost-first ordering silently deleted 423 words on p28 through a spurious
table upgrade; the corridor's derived gutter was rejected by 0.9pt by a bound
that looked principled; relaxing the table stand-aside to "content on both
sides" destroyed p10's rail table *while raising its convergence*; and N-way
routing without `MODEL_MAX_CELLY` took a partners'-capital statement apart. The
distinction that finally worked — layout columns against data columns — came
from the user looking at the page, not from any measurement of it.
