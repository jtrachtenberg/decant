# ADR 0032 — A generated report is laid out by a program, and it shows

- **Status:** Proposed
- **Date:** 2026-08-01
- **Amends:** [ADR 0015](./0015-decoration-demotion.md) — the dims census now
  answers *where* as well as *how often*.
  [ADR 0031](./0031-kind-aware-confidence-flag.md) — extends its "what is this
  made of" question to a band-local gutter, in a narrower form.

## Context

A four-page site-report export — a project header, then issues laid out as
field/value pairs with a photograph beside each — came out of Decant as an
ambiguous prompt with **all four pages** in the attached-charts PDF, for a
document that is almost entirely text. Three separate failures met on it, and
each is a case the corpus had no example of, because the corpus is six
*authored* documents and this is a *generated* one.

### 1. The dims census cannot see a photo gallery

The census fingerprints an image by its intrinsic pixel dimensions and demotes
any fingerprint seen on two or more pages as decoration. ADR 0015 recorded the
accepted risk in as many words: *"across the graded corpus every exact-dims
cross-page repeat was decoration"*.

A report generator breaks that. It normalizes every attached photo to one
thumbnail size, so six **distinct site photographs** paint at 382×382 across
three pages and every one of them was called furniture. With nothing on any
page qualifying as a figure, `selectChartPages` fell through to its "no page
carries stronger evidence" branch — which attaches *every* chart page — and
"chart page" for a text page is `images >= 1`, satisfied by the footer logo.
Hence four pages of four, page 1 included, whose only image is the cover logo.

### 2. The page-area floor is asked of the wrong thing

`MIN_FIGURE_PAGE_FRACTION` (5%) is a per-figure gate. The report's photographs
are 95×95pt on A4 — **1.8%** each — so even freed from the census they failed
it. So did `chart-heavy` p3, which is a row of three 3.2% diagrams: 9.6% of
figure that read as nothing at all.

### 3. A form's labels are not a column

The issue blocks set `Name:`, `Description:`, `Due Date:`, `Priority:`,
`Status:`, `Assigned To:` at x=235 and their values at x=325.
`pageCorridors` reached the right verdict — `readsAsCells` judged **every** one
of those corridors celly — but the model only records what it *accepts*, and
three of the four then failed a column guard (`MODEL_MIN_VSPAN`,
`MIN_COL_HEIGHT`) and dropped out. `detectGutter`'s own band-local vote found
the same corridor and split there unopposed, emitting six labels and then six
values with nothing left to say which belonged to which.

A fourth, smaller failure rode along: a `Description:` whose value wrapped onto
a second line put a one-cell line inside the details block, which ended the
table there and left an eleven-row block as a four-row table, a loose sentence,
and a seven-row table.

## Decision

**Furniture is the same thing in the same place.** That is what the *text*
furniture detector has always keyed on (`createFurnitureDetector`), and the
dims census now asks the same question. `classifyDimsFamilies` splits its
answer:

- **`repeatedDims`** — one paint per page, page after page. Demoted as before.
  A logo stays furniture even when the cover prints it larger and elsewhere
  than the running header does: same asset, one instance a page.
- **`contentDims`** — a size some page lays out as a **set**: two or more of
  them in different places. Kept, and exempt from the page-area floor.

**The page-area floor moves from the figure to the page.** Per-figure was the
wrong unit in both directions — it admitted nothing from a page whose figures
are several small ones, while the crop path went on framing their union
regardless. Measured as a **union**, not a sum, so a page that paints one logo
twice at the same spot reports its footprint once (`table-heavy` p1 does
exactly that, and summing floated its 3.1% logo over a 5% bar).

**A label rail is not a column boundary.** `detectGutter` vetoes its own vote
when three quarters of the clusters immediately left of the gap are short and
end in a colon. Left unsplit, the block reaches the table binders, which pair
the labels back with their values.

**A wrapped value folds into the cell it continues.** Identified by three
things together: the line above states a value (≥2 cells) while this one states
only a remainder (exactly 1), that cell starts under the previous row's *last*
cell, and it is set at leading — a little over its own type size, **and**
tighter than the rows around it.

### What was measured and rejected

**Vetoing the band-local gutter on `readsAsCells` itself** — the obvious move,
and the same test ADR 0031 uses. The corpus refused it: ten tests fail, among
them `two-column page reads left column fully, then right`. `isTabularCell`
passes any string ≤16 characters, so short lines in genuine two-column prose
measure as cells too, and the split those pages need goes with them. The
trailing colon is the narrower claim and the one that actually names the
relation — a label *belongs to* the value beside it, which is a row.

**Recording only the corridors the model accepts.** This is what produced the
failure. The guards that killed three of the four corridors ask whether a
corridor is tall, wide and open enough to be one of the page's **columns**, and
none of them bears on whether the text either side reads as a table's cells. So
the kind is now decided first and the verdict kept either way; corridors read
as cells ride along on the model rather than vanishing from it.

**A median row pitch for the wrap test.** The document has two pitches — 12pt
in the details block, 9pt in the issue list — and one leading of 7pt. A median
over the page called the details block's wrap a row. Leading measured against
the *type size* is scale-free and judges both blocks identically.

**Lowering `MIN_FIGURE_PAGE_FRACTION`.** Rejected. ADR 0015's own comment gives
the population — *"logos land at ~1–2% of the page"* — and the report's
photographs are 1.8%. There is no threshold that separates them; only the
census's position evidence and the page's combined footprint do.

## Consequences

The decantCC corpus, six documents and 308 analysed pages, swept against `main`
at `f851d73`:

| | count |
| --- | --- |
| pages whose convergence rose | 1 |
| pages whose convergence fell | 2 |
| pages newly flagged low-confidence | 0 |
| pages newly clean | 0 |
| unreliability markers | 44 → 44 |
| pages whose Markdown changed | 3 of 308 |

| document | pages | decision | attached |
| --- | --- | --- | --- |
| chart-heavy | 2/56 differ | ambiguous | 20 |
| clean-text | byte-identical | ambiguous | 2 |
| messy-scan | byte-identical | ambiguous | 66 |
| private-novel | byte-identical | ambiguous | 3 |
| public-famous | byte-identical | convert | 0 |
| table-heavy | 1/36 differ | ambiguous | 9 → 10 |

Two of the three changed pages are repairs: a caption's wrapped tail rejoins on
`chart-heavy` p9, and `table-heavy` p2's split heading comes back together as
*"ABOUT THIS REPORT OUR STRATEGIC RESPONSE TO CLIMATE CHANGE"* (0.55 → 0.56).

`chart-heavy` gains a figure row (p3) and three quarter-page figures (p8, p9,
p11) that the census had been demoting; it holds 47 chart pages against a cap
of 20, so five back pages give way. `table-heavy` p21 gains two 4.2% chart
bands.

On the report itself: the prompt is now raised for something real — ten
photographs across pages 2–4 — page 1 drops out of the attachment, every issue
binds as `| Name: | Kitchen Units |` rows, the wrapped descriptions are whole,
and page 2 loses its low-confidence marker (convergence 0.65 → 0.97).

### Residuals

- **`chart-heavy` p53 gets worse.** A stray `(237.86 MCHF)` joins the wrong
  line and its convergence falls 0.39 → 0.20. The page is the CERN infographic
  that already carries the flattened-figure marker and attaches as a figure, so
  its routing is unchanged and its text was declared unreliable either way —
  but this is a degradation, not a wash, and nothing in the wrap test can see
  that a page's cell structure is already meaningless.
- **The census still fingerprints on size.** Position now qualifies the
  verdict, but two genuinely different images at identical dimensions and
  identical positions on two pages are still indistinguishable from one asset
  painted twice. Content hashing would settle it and costs a decode.
- **A one-paint-per-page photo family is still furniture.** A report that
  attaches exactly one normalized photograph to each page produces the logo's
  signature exactly, and nothing here can tell them apart. The report that
  motivated this ADR lays out three and five on a page; one that lays out one
  would not be helped.
- **`LABEL_RAIL_FRACTION` is calibrated on one document.** No corpus page holds
  a label rail at all — this is a *generated*-document idiom, and the corpus is
  authored documents. The direction of error is toward not vetoing.
- **The issue blocks emit as one continuous table per region**, not one per
  issue: the heavy rules that separate them on the page are images, and the
  `| Name: |` row restarting is the only boundary a reader gets.
- **The `Comments:` field is not bound to its comments.** Its value is several
  lines set below the label rather than beside it, so it stays loose text under
  a `Comments:` line. Nothing is lost; the binding is.
