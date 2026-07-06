# ADR 0005 — Recover charts as data, not pixels

- **Status:** Accepted
- **Date:** 2026-07-06 (records the decision shipped during M2)

## Context

Office documents embed charts the converters treat as images: mammoth drops
DOCX charts entirely, and rasterizing one costs image tokens for a picture the
model then has to read back into numbers. But an OOXML chart isn't an image —
its cached data series live as XML inside the package
(`word/charts/chartN.xml`, `ppt/charts/`, `xl/charts/`).

## Decision

Read the cached series directly and emit each chart as a **category×series
Markdown table**, appended after the body (shared parser in
`src/convert/chart.js`, used by the DOCX/XLSX/PPTX engines). A recovered chart
counts as *content*: a slide or document whose only visual is a recovered
chart converts cleanly instead of prompting.

## Consequences

The model gets the numbers exactly — often more useful than the picture — at
text-token prices, and the "ambiguous" prompt fires less. Limits: only charts
with cached OOXML data qualify (an XLSX chart usually restates sheet cells, so
the win there is small); PDF charts are vector drawings with no cached data —
they are handled by the extract-and-reference path instead (ADR 0006). This is
"Tier 1" of the chart-fidelity plan in SPEC §3.9.
