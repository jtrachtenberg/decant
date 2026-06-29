# ADR 0002 — Split conversion on the parsing vs. recognition boundary

- **Status:** Accepted
- **Date:** 2026-06-28

## Context

The best image-aware converters (Docling, MarkItDown, Marker) are Python and
several need ML models/GPU; a Chrome extension is JS in a sandbox and cannot run
them in-process. Need a principled line for what runs where.

## Decision

Split on **parsing vs. recognition**. Parsing already-structured data —
digital-PDF text layers (pdf.js), Office files which are zipped XML (mammoth.js,
SheetJS) — runs **in-browser, fast and zero-install**. Recognition — OCR, neural
table extraction, figure description — runs in the **optional local companion**.

## Consequences

The majority of real uploads (clean PDFs, Word docs, spreadsheets) are handled
in-browser with nothing to install; the companion is a genuine power tier, not a
degraded fallback. The conversion core stays engine-agnostic behind one
interface, so engines can be swapped per type.

Do not attempt to port recognition models (e.g. TableFormer) to JS/WASM — that's
the trap this boundary exists to avoid.
