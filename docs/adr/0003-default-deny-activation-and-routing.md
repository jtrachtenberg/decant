# ADR 0003 — Default-deny activation and per-type routing

- **Status:** Accepted
- **Date:** 2026-06-28

## Context

The extension must not touch every site a user visits, and users need
per-file-type control over what happens.

## Decision

**Default-deny activation** — Decant is inert on any page unless its host or URL
is explicitly whitelisted (ships with `claude.ai` enabled). **Per-type routing** —
files are matched by MIME/extension to one of `inbrowser`, `companion`, `http`,
or `passthrough`, with `passthrough` the default for unmatched types. PDFs and
Word docs default to Markdown conversion.

## Consequences

Minimal permission surface and privacy-by-default. On the browser surface this
requires `optional_host_permissions` + dynamic content-script registration rather
than static manifest matches (slightly more moving parts). The
intercept→route→substitute pipeline generalizes: any type can be pointed at any
endpoint (e.g. images → local OCR), making "PDF/doc → Markdown" just the default
instantiation.

Routing to a non-localhost endpoint means documents leave the machine and must be
an explicit, warned opt-in.
