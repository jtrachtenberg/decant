# ADR 0004 — Prefer an MCP surface over OS-level interception

- **Status:** Accepted
- **Date:** 2026-06-28

## Context

Expanding Decant beyond the browser. OS-level filesystem interception (Windows
minifilter drivers, dialog hooking) is heavy — kernel development, driver
signing, AV/EDR conflicts — and must be rebuilt per OS. Claude Desktop natively
supports installable MCP servers (`.mcpb` bundles) across Windows/macOS/Linux.

## Decision

For the Claude use case, ship an **MCP server exposing a conversion tool**,
packaged as a `.mcpb` bundle, as the primary non-browser surface. Treat OS-level
interception (WinFsp/macFUSE/FUSE) as later/optional. Implement the MCP server in
**Node** (ships with Claude Desktop) and have it **shell out to the existing
Python companion over localhost**, sidestepping the `.mcpb` limitation on
bundling compiled Python deps.

## Consequences

One server covers all desktop OSes for Claude with no DOM/filesystem fragility
and full reuse of the converter core. The UX differs from the browser extension —
tool-invoked rather than transparent-on-upload — which is an accepted trade for
robustness and portability.

Native OS interception remains available later for non-Claude apps but is
explicitly deprioritized.
