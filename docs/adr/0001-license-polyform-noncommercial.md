# ADR 0001 — License under PolyForm Noncommercial 1.0.0

- **Status:** Accepted
- **Date:** 2026-06-28

## Context

Decant should be free for non-commercial use and accept optional donations, while
not granting others the right to use the code commercially. Donations are
independent of the code license.

## Decision

License under **PolyForm Noncommercial License 1.0.0**. It is lawyer-drafted for
software, plain-language, and grants use/modify/redistribute for any
non-commercial purpose.

## Consequences

Decant is **source-available, not "open source"** — the OSI and FSF definitions
forbid non-commercial restrictions, so it can't be labelled open source, won't be
OSI-approved, and some registries / "free for OSS" service tiers won't apply.
GitHub's license picker won't list PolyForm, so `LICENSE` is added manually. As
sole copyright holder, the author retains all rights and may privately
dual-license commercially.

Considered and rejected: **CC BY-NC** (Creative Commons advises against CC for
software), **Prosperity** (only if the goal becomes paid commercial use rather
than no commercial use).
