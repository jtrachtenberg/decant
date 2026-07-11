# ADR 0011 — Strip positionally-repeated text as page furniture

- **Status:** Accepted
- **Date:** 2026-07-10

## Context

The same interactive report (ADR 0010) carries a navigation rail on 34 of its
36 pages: twelve section labels, at pixel-identical positions, on every page.
Reconstructed as content, the rail becomes a phantom fourth column that
column detection can't isolate, so its labels interleave into the body of
every page — often gluing onto body words with no space
("LeadershipDiscovery is committed…"), depressing convergence scores,
triggering false corrupt-chart-table omissions, and re-stating the full
section list ~34 times per conversion. Running headers do the same at
smaller scale, and the `messy-scan` corpus doc's court-stamp header makes
32 pure-scan pages masquerade as text-bearing pages.

No per-page heuristic can see this: on any single page the rail is ordinary
positioned text. The signal is **exact repetition across pages** — the same
string at the same position — which content never exhibits (even a page
number changes text page-to-page; even a repeated heading lands at a new y).

## Decision

**Detect and strip repeated text furniture document-wide before
reconstruction** (`createFurnitureDetector` / `stripFurniture`, classify.js).

- Key = normalized string + position quantized to 2 pt (absorbs sub-point
  placement jitter; body leading is ~12 pt so distinct lines never collide).
- Furniture = a key present on **≥ max(3, 30 % of pages)**, counted once per
  page. The floor keeps 1–2-page docs out entirely; the fraction keeps a
  coincidental repeat in a long document from qualifying.
- Two passes in `analyzePdf`: pass 1 streams every page's text items through
  the counter (items cached for docs ≤ MAX_ANALYZE_PAGES; only counts are
  kept above it — memory stays flat, text is re-extracted). Pass 2 strips
  before `reconstructPage`, so char counts, convergence, column detection,
  background-demotion text points and the emitted Markdown all see the
  furniture-free page. `scripts/inspect-pdf.mjs` mirrors both passes.

## Consequences

- The interactive report's nav rail and running header vanish from all 34
  pages; convergence scores rise document-wide (0.85→0.98 on typical body
  pages), the interleave glue disappears, and a false
  "[chart table omitted]" marker on the About page resolves — the assurance
  bullets now pair correctly. Two symbol-chart pages (badge matrix, risk-dot
  panels) are newly convergence-flagged as flattened: true positives the nav
  noise had been masking.
- `messy-scan`: the repeated stamp header is stripped, so 17 stamp-only scan
  pages fall below the 50-char text floor and stop attaching as fake chart
  pages (20 → 7 attached, all real).
- Repeated *content* is the accepted loss: a table header re-printed at the
  identical position on ≥ 30 % of pages would be stripped once per page. No
  corpus doc exhibits this; a document that does loses redundant text only.
- Position-keying means scanned/OCR docs (jittery baselines) rarely qualify —
  the safe direction: furniture survives rather than content vanishing.
