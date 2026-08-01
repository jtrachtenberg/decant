# ADR 0030 — A page's columns are the page's, not each band's

- **Status:** Proposed
- **Date:** 2026-07-31
- **Builds on:** [ADR 0012](./0012-n-column-guarded-recursion.md) (guarded
  recursive column splits) and [ADR 0013](./0013-display-band-reconstruction.md)
  (display bands). Constrains the gutter those choose, and gates
  `tableFromColumns` on the result. See *Consequences*.

## Context

Multi-column pages had no page-level notion of where their columns are.
`reconstructPage` chops a page into horizontal bands — above and below every
grid it finds, and again inside every region — and each band then ran
`detectGutter` from scratch over its own few rows.

`table-heavy` PDF page 8 (printed page 7) of the decantCC corpus is a designed
four-column spread. The user described it:

> Four columns. The rightmost is the global nav menu and the narrowest — page
> number at top, reading down from "About this report" to "Application
> register", nav buttons at the bottom. The actual content starts at the
> leftmost column and reads left to right.
>
> - **Column 1** — page header "Our strategic response to climate change",
>   subheader "Discovery's climate change strategy outlines the following
>   objectives:", then six numbered objectives 01–06.
> - **Column 2** — header "Our climate change strategy is aligned with our
>   values and governed by the following principles:", then reads downwards.
> - **Column 3** (largest) — a header, three rows with a header between them,
>   then three text-based infographics reading top to bottom and left to right.

The nav column is stripped correctly as repeated furniture
([ADR 0011](./0011-repeated-text-furniture.md)). Everything else came apart. The
six numbered objectives were emitted in order but with column 2's and column 3's
material spliced between them, objective 06 glued to column 2's "governance,
empowered people", and the three infographics glued to each other line by line.

Instrumenting `columnRegions` shows why. The page is processed as 27 separate
calls, and the ones with enough rows to decide disagree:

```
534  322  678  795  …
```

The corridors between the columns sit at x≈322 and x≈533. They were found — and
then the page was cut at the middle one first, which is the whole problem.

### What the bands were actually failing at

Two different failures were tangled together, and separating them is the ADR.

**The level.** The bands were not failing to find the page's corridors. They
were finding them and being outvoted. Column 3 holds three infographics standing
side by side, and the corridors between *those* are real corridors — locally
they are the densest evidence on the page, wider than either of the page's own
gutters. Eighteen of the page's bands voted for one of them. A census over what
the bands *propose* cannot separate the two levels, because the sub-column
corridors win that vote.

**The order.** The split is binary and recurses ([ADR 0012](./0012-n-column-guarded-recursion.md)),
so *which* corridor is cut first decides what each side holds. Cutting at the
middle corridor leaves columns 1 and 2 sharing a side and column 3 alone; the
block-flush that runs between cuts then fragments the shared side, and on p8
only a 23-box scrap of columns 1 and 2 ever reached a second cut. That is where
the objectives got spliced.

## Decision

Decide a page's columns once, over the whole page, and hand that decision to
every band the reconstruction chops the page into.

### The census counts contradictions, not proposals

A corridor of the page is one that runs the page's height with nothing printed
across it. That is a cheap page-wide predicate every band can be asked about
directly, and unlike a vote it is not swayed by local density:

- `open(x)` — bands with content on both sides of `x` and nothing crossing it
- `cross(x)` — bands with a cluster printed straight through `x`

On p8 this separates the levels cleanly. The two corridors between the columns
have `cross = 0` over a 48pt and a 55pt stretch; the infographic corridors carry
7 and 11 crossings apiece, because column 3's own heading and its three header
rows are printed across them.

`pageColumnModel(boxes)` returns the surviving corridors left to right, each
carrying the gutter x derived from it in `findGutter`'s existing convention
(just left of where the next column starts), so every consumer downstream — the
straddler tests, rail adoption, side routing — reads the kind of number it
always did. The census is one pass over the bands' clusters into three
difference arrays, not a scan per candidate x.

### What a corridor must be before the page is held to it

All four guards are stricter than the per-band ones, because the claim is
stronger: `detectGutter` says "these few rows read as two streams", the model
says "this is where the page's columns are, and no band may disagree".

| guard | value | what it rejects |
| --- | --- | --- |
| `MODEL_CROSS_TOL` | 0.2 of the bands that see it | column 3's infographic corridors (0.27 and 0.37) — while still surviving a full-width banner printed across a real corridor |
| `MODEL_MIN_WIDTH` | 5 median heights | ragged prose. The corpus's real design gutters run 6.1–10.8 med; the false ones — `private-novel` p7 and p11 offered four — run 2.3–4.3. Nothing real sits between. |
| `MODEL_MIN_VSPAN` | 0.55 of the page's content height | a corridor beside one figure (`chart-heavy` p9, 0.15) or below one heading (`clean-text` p2, 0.48). Real ones reach 0.59–0.90. |
| `MODEL_MIN_OPEN` | 8 bands (2 × `MIN_COL_ROWS`) | `private-novel` p2, a chapter opening of seven bands, six of which agreed on a corridor. Six bands are not a page. |

A corridor that survives is still put to `detectGutter`'s own confidence guards
in each band. A page corridor is stronger evidence than a band's vote; it is not
a licence to split a band that has no columns in it.

### The leftmost corridor is cut first

The split stays binary. Taking the **leftmost** interior corridor peels exactly
one column off per cut, so the remainder that recurses is one column smaller
each time. This is what unsplices p8's objectives.

### Three things the model is deliberately not allowed to do

**It does not see inside a table.** A corridor is offered to a unit only when
that unit has rows *wholly* on each side of it — not merely content on each
side. This is the guard, not an accident: a table's rows straddle every one of
its cell boundaries, because a row is what a table is made of, while independent
columns produce rows confined to one column, because that is what a column is.
Relaxing it to "content on both sides" was tried and the corpus refused: it took
`table-heavy` p10's tag-rail disclosure table ([ADR 0014](./0014-tag-rail-row-binding.md))
apart into loose lines, 35 table rows down to 8 — *while the page's convergence
rose from 0.92 to 0.57*, because the metric reads unbound text as well-aligned.

**It is not computed over a table's cell gaps.** When `validGrid` claims a page,
the model is computed from the glyphs the grid did *not* claim. A table's cell
gaps are corridors by every measure the census takes — vertical, open the
table's whole height, crossed by nothing — and they are not the page's columns.
`table-heavy` p32 (rotated rails, [ADR 0028](./0028-rotated-text-and-rails.md))
is the case: its six cell gaps outnumbered anything the prose around it had, and
imposing them moved that page's gutter from 417 to 380.

**A page corridor is not a table's gutter.** `tableFromColumns` upgrades an
ambiguous pair — independent prose columns, or a table whose cells are long free
text — to a row-major table, and nothing could resolve that ambiguity before.
A page corridor resolves it: a corridor open the page's height is where the
page's *columns* are, and columns are read column-major whatever their
paragraphs happen to line up with. A table's own gutter opens where the table
starts and closes where it ends. `table-heavy` p28 forced this: columns 2 and 3
of a three-column spread paired into a six-row "table" whose cells carried the
page's U+001F bullet glyphs, and `tableHasCorruptCells` then dropped all **423
words** of it as an unreliable chart table.

### `COLUMN_SPLIT_MAX_DEPTH` still binds, and now means what it says

The depth limit exists to bound *speculation* — a candidate sub-gutter alone is
not evidence, so nested splits are guarded and rationed. A corridor the page has
already established is not speculation, so taking one no longer spends the
budget. On a four-column page that leaves both guarded levels for the
sub-columns *inside* a column, which is the level the budget exists to buy.

Measured, this is nearly inert: it changes three pages in the corpus
(`table-heavy` p8 by 2 characters, `messy-scan` p32 and p35 by ~100 each). It is
kept because it makes the constant honest, not because it moves the corpus.

## Consequences

The decantCC corpus, six documents and 308 analysed pages, swept with
`scripts/sweep-corpus.mjs` (`columnConvergence`, threshold 0.5, min cells 12):

| | count |
| --- | --- |
| pages whose convergence rose | 7 |
| pages whose convergence fell | 3 |
| pages newly flagged low-confidence | 0 |
| pages newly clean | 0 |
| unreliability markers | 45 → 46 |
| pages whose Markdown changed | 14 of 308 |

| document | pages | decision | attached |
| --- | --- | --- | --- |
| chart-heavy | byte-identical | ambiguous | 20 |
| clean-text | 2/42 differ | ambiguous | 2 |
| messy-scan | 2/98 differ | ambiguous | 66 |
| private-novel | byte-identical | ambiguous | 3 |
| public-famous | byte-identical | convert | 0 |
| table-heavy | 10/36 differ | ambiguous | 9 |

**Every page the task named as at risk is byte-identical**: `public-famous`
p17/p22/p33 (the balance sheets), `clean-text` p2 (the table of contents whose
short right-hand `Page` header depends on ADR 0025's alone-on-its-row clause),
`messy-scan` p31 (independent-baseline figure callouts), `table-heavy` p22 and
p32. The whole of `private-novel` and `chart-heavy` is unchanged: a novel and a
chart deck have no page columns to find, and the model finds none.

### No page loses a word

Every changed page was compared word by word against `main`. Nothing is deleted
anywhere in the corpus. Two pages gain words, both by *un*-gluing streams the
old reading had run together:

| page | before | after |
| --- | --- | --- |
| table-heavy p8 | `withour`, `withTCFD`, `transparencyand` | `with our`, `with TCFD`, `transparency and` |
| messy-scan p32 | `CELSIUS14Feb` | `CELSIUS`, `14 Feb` |

One page moves the other way. `messy-scan` p35, a scanned USGS chart page
already attached as a figure, glues at five axis-title boundaries
(`SURFACE AT` → `SURFACEAT`, `IN FEET DAILY` → `FEETDAILY`) and gains a
low-confidence marker; it also stops emitting one caption twice. That is the
whole of the corpus's negative text movement, and it is re-joining, not
deletion.

### What p8 reads like now

The six numbered objectives are contiguous and in order, unspliced, and
`aligned with TCFD recommendations` is no longer glued. Two defects the task
named remain open on that page and are recorded below.

### Residuals

- **p8's page header still shatters.** `Our strategic response to climate
  change` comes out as three fragments interleaved with columns 2's and 3's
  headers. The cause is the straddler machinery in `columnRegions`, not the
  column model: the top band's clusters are promoted to a spanning region before
  routing. Unchanged by this ADR, better or worse.
- **p8's `SHORT-TERM / MEDIUM-TERM / LONG-TERM GOAL` grid degrades to plain
  text.** It was a clean three-column pipe table. Its rows and their bindings
  survive as text in the right order; only the markup is lost. This is a direct
  cost of cutting the leftmost corridor first, and it was weighed against the
  objectives splicing, which corrupts meaning rather than presentation.
- **p10's `PHASE 3` heading detaches from its subtitle**, which
  [ADR 0018](./0018-panel-heading-rebinding.md) exists to bind. The page's three
  disclosure tables are intact (the 8 table rows it loses are the icon KEY
  legend, which had two empty columns and reads better as lines); the page's
  title is newly joined into one heading.
- **p26 still interleaves.** Its convergence rises 0.53 → 0.76 and its worst
  welded cells are gone, but a three-column page with a panel over it is not yet
  read cleanly.
- **The model is binary-split, not N-way.** `columnRegions` routes into `left` /
  `right` / `span`, so a page with three corridors is still consumed one cut at
  a time and the ordering question above exists at all. Routing N-way in one
  pass would remove it, and would let `tableFromColumns` see adjacent columns
  only. That is the obvious next step and is not taken here.
- **The cross-page `hint` is not unified with the model.** They are the same
  idea at two scales — a corridor established elsewhere, imposed here — and
  `hint` remains a single x accepted by `fragmentFitsGutter`. Unifying them
  would make a page-break remainder inherit the previous page's whole column
  model rather than one gutter.

### Why this needed a corpus run and not an argument

Three mechanisms in this ADR were wrong on the first try and only the corpus
said so: the leftmost-first ordering silently deleted 423 words on p28 through a
spurious table upgrade; the corridor's derived gutter was rejected by 0.9pt by a
bound that looked principled; and relaxing the table stand-aside to "content on
both sides" destroyed p10's rail table *while raising its convergence*. That
last one is the standing warning: `columnConvergence` cannot tell a well-read
page from a page whose structure has been dissolved into evenly-aligned lines.
