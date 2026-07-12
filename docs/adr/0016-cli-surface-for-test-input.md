# ADR 0016 — A command-line surface for headless conversion (decantCC test input)

- **Status:** Accepted
- **Date:** 2026-07-12

## Context

[decantCC](https://github.com/jtrachtenberg/decantCC), Decant's evaluation
harness, scores whether a document's meaning survives conversion. To do that it
must first *produce* the converted output — the same Markdown a real Decant user
would get — for every document in its corpus and for every conversion variant it
wants to compare.

The only code that produces that Markdown today is the browser extension (behind
a DOM and a real upload, not scriptable) and `scripts/bench-pdf.mjs`, which is
PDF-only and **re-implements** the analysis loop rather than calling the shared
`convertFile()`. A harness built on either would be fragile or would drift from
what actually ships.

The converter core (`route → transform`) is already surface-agnostic in
principle; only two browser-isms reach into the engines — asset resolution via
`browser.runtime.getURL` (`inbrowser.js`) and the http/companion relay via
`browser.runtime.sendMessage` (`index.js`).

## Decision

Add a **command-line surface**: a headless build of the conversion core that runs
`convertFile()` under Node and exposes it as a scriptable command. It is the
**sanctioned-tool** paradigm (`SURFACES.md`), not interception — it converts a
named file, it does not swap uploads.

Key choices:

- **Forced modes over the classifier.** The primary control is a `--mode` flag
  (`auto`/`markdown`/`figures`/`companion`/`passthrough`) that overrides the
  convert/passthrough/ambiguous verdict, so decantCC can generate each variant
  deterministically ("two passes to generate each"). These modes are exactly the
  existing `AMBIGUOUS_CHOICES` plus the hard decisions — the CLI's realization of
  the `ARCHITECTURE.md §5` manual-override capability every surface owes. No new
  conversion behavior is invented.
- **One shared code path.** De-browserify the two seams behind an injectable
  asset resolver and a Node HTTP transport, so the CLI calls the *same*
  `convertFile()` the content script does. `bench-pdf.mjs` retargets onto it,
  ending the re-implementation drift.
- **Package with Node SEA, Windows first.** A single build recipe emits
  `decant.exe` on Windows and ELF/Mach-O on \*nix from the same source, so
  cross-platform is a re-run, not a rewrite. Plain user-mode executable —
  ordinary Authenticode signing, none of the kernel-driver attestation the
  minifilter path in `SURFACES.md` would demand.
- **Companion stays external.** The recognition tier remains the separate
  localhost Python process; the CLI reaches it over HTTP for `--mode companion`
  and works fully without it for the parsing tier — the boundary from
  `ARCHITECTURE.md §3` is unchanged.

The full design is in [`../CLI.md`](../CLI.md).

## Consequences

decantCC gets a stable, deterministic contract over the shipping engines: raw
Markdown or a `--json` envelope (decision, reason, savings, meta), plus exit
codes it can branch on without parsing output. The re-implementation risk in
`bench-pdf.mjs` goes away once it moves to the shared path.

The cost is the one-time de-browserifying refactor (an asset-resolver seam and a
Node transport) and a SEA packaging pipeline whose fiddliest part is embedding
the pdf.js WASM/font assets correctly — mitigated by a JPX/JBIG2 packaging smoke
test. The privacy guardrail on non-localhost endpoints is preserved as an
explicit `--allow-remote` opt-in, since there's no runtime dialog to warn a
human.

This is additive: no browser behavior changes, and the surface plugs into the
same core as every other, per the converter-interface boundary in
`ARCHITECTURE.md`.
