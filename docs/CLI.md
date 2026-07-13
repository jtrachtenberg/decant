# Decant — Command-Line Surface Spec

**CLI surface — implementation spec.**

A headless command-line build of Decant's conversion core: point it at a file,
get the Markdown Decant would have produced in the browser. Its first consumer
is [decantCC](https://github.com/jtrachtenberg/decantCC), Decant's evaluation
harness, which needs to generate converted test inputs at scale, deterministically,
without a browser in the loop. It ships first as a standalone **Windows `.exe`**
so decantCC can invoke it with no Node/npm install, with **\*nix** (Linux/macOS)
binaries following from the same source.

> **Scope:** This spec covers the **CLI surface** only. The surface-agnostic core
> (pipeline, converter interface, parsing-vs-recognition, engines) lives in
> [`ARCHITECTURE.md`](./ARCHITECTURE.md); the browser surface in
> [`../SPEC.md`](../SPEC.md); the surface map in [`SURFACES.md`](./SURFACES.md);
> decisions in [`adr/`](./adr/). The decision to add this surface — and why it's a
> sanctioned tool rather than an interceptor — is
> [ADR 0016](./adr/0016-cli-surface-for-test-input.md).

---

## 1. Goals & non-goals

**Goals**
- Run Decant's exact in-browser conversion pipeline (`route → transform`) from a
  terminal, no browser and no DOM.
- Let the caller **force a mode** — bypass the convert/passthrough/ambiguous
  classifier and deterministically demand a specific variant of the output. This
  is the CLI's realization of the manual-override capability every surface owes
  (`ARCHITECTURE.md §5`).
- Reuse the shared converter core unchanged; the CLI is intake, nothing more.
- Ship as a single self-contained executable per OS, Windows first.
- Be scriptable: predictable stdout, meaningful exit codes, no interactive
  prompts.

**Non-goals (v1)**
- Interception. The CLI is the **sanctioned-tool** paradigm
  (`SURFACES.md`) — it converts a file you name, it does not swap uploads
  mid-flight. Transparent interception on desktop is WinFsp/FUSE territory and
  stays out of scope.
- Being a general-purpose Markdown converter for end users. The audience is
  decantCC and automation; a friendly end-user CLI can grow on top later, but v1
  is the machine-facing contract.
- Bundling the Python companion. The recognition tier stays a separate localhost
  process exactly as it is for the browser (`ARCHITECTURE.md §3`); the CLI talks
  to it over HTTP when a companion mode is requested, and works fully without it
  for the parsing tier.

---

## 2. Why a CLI surface

decantCC scores whether a document's *meaning* survives conversion: it asks an
LLM questions whose gold answers come from the source, then re-asks them against
the converted output. To do that it must first **produce** the converted output —
the same Markdown a real Decant user would get — for every document in the
corpus, for every conversion variant worth scoring.

Today the only code that produces that Markdown is the browser extension (locked
behind a DOM and a real upload) and `scripts/bench-pdf.mjs` (PDF-only, and it
*re-implements* the analysis loop instead of calling the shared
`convertFile()` — so it can drift from what ships). Neither is a stable contract
an external harness can depend on.

The CLI closes that gap: one headless entry point over the *same* engines the
extension runs, with a frozen I/O contract decantCC can script. Because it's the
sanctioned-tool paradigm, it's also robust and portable in a way interception
never is — no per-app fragility, no signing drama beyond ordinary executable
distribution.

---

## 3. The intake shim — de-browserifying the core

The middle of the pipeline (`src/router/route.js`, `src/convert/*`) is already
surface-agnostic in principle. In practice two browser-isms reach into the
otherwise-portable engines and must be lifted behind a seam before Node can drive
them. **This is the whole engineering cost of the surface** — everything else is
CLI plumbing.

### 3.1 Asset resolution (`browser.runtime.getURL`)

`src/convert/inbrowser.js` resolves the pdf.js worker, standard fonts, and the
JPX/JBIG2/ICC WASM modules through `browser.runtime.getURL(...)` at module load
(`inbrowser.js:46`, `:54`, `:63-64`). Under Node, `src/browser.js` resolves
`browser` to `undefined`, so importing `inbrowser.js` throws before the CLI can
call anything. (`bench-pdf.mjs` dodges this by importing the `legacy/` pdf.js
build and never importing `inbrowser.js` at all — which is exactly the drift we
want to end.)

**Fix — a single asset-resolver seam.** Introduce one indirection, e.g.
`src/convert/assets.js` exporting `getAssetUrl(relPath)`:

- **Browser build** wires it to `browser.runtime.getURL(relPath)` (unchanged
  behavior).
- **CLI build** wires it to a local filesystem resolver — `pathToFileURL()`
  against the directory where the packaged binary unpacks its bundled assets
  (`pdf.worker.mjs`, `standard_fonts/`, `wasm/`, `iccs/`).

`inbrowser.js` and `pdf-figures.js` call `getAssetUrl(...)` instead of
`browser.runtime.getURL(...)`. The seam is injected at build time (esbuild
alias / define) or via a tiny runtime check, so neither engine imports a
browser global. Net change is mechanical and leaves in-browser behavior
byte-identical.

### 3.2 The companion/http relay (`browser.runtime.sendMessage`)

`convertViaBackground()` in `src/convert/index.js` relays http/companion
conversions through the MV3 background service worker, because in the extension
the network fetch must run where host permissions apply, not in the page
(`index.js:106-119`, `relay.js`). There is no background worker in a CLI.

**Fix — same seam, second method.** The CLI provides its own transport that
`fetch()`es the endpoint directly (Node has global `fetch`), honoring the same
rule shape (`endpoint`, `onError`, `onEmpty`) and the `MAX_RELAY_BYTES` cap. The
core already isolates this behind `convertViaBackground` / `convertViaCompanion`;
the CLI injects a Node transport in place of the `sendMessage` one. No relay
wire-format (`fileToWire`/`wireToFile`) is needed when there's no worker boundary
to cross — the CLI calls the endpoint straight.

### 3.3 What already works under Node, untouched

- `new File([...])` / `Blob` — global in Node ≥ 20 (the repo already targets
  modern Node; `web-streams-polyfill` is a dependency). `result.js`'s
  `markdownFile()` and `dedupeFileNames()` run as-is.
- `read-file.js` — its `instanceof ArrayBuffer` fast path makes Node reads a
  zero-copy passthrough (the Firefox realm-copy branch is inert).
- `route.js`, `classify.js`, `result.js`, `config/defaults.js` — pure, no
  browser globals. They import and run directly.
- DOCX/XLSX/PPTX/HTML engines (mammoth, SheetJS, jszip, Turndown) — pure JS, no
  DOM. They already run headless (see `test/*.test.mjs`).

The result: after the §3.1/§3.2 seams land, the CLI calls `convertFile(file,
routing)` — **the same function the content script calls** — and gets the same
contract back (`{ action, file, converted?, reason, meta }`). One source of
truth for what "the Decant conversion" is.

---

## 4. Command shape & forced modes

```
decant convert <input> [--mode <mode>] [options]
```

`<input>` is a path to a single document. (Batch/glob is a v2 nicety —
decantCC can loop; keeping v1 one-file-per-process keeps the contract trivial
and failures isolated.)

### 4.1 `--mode` — the forced-mode flag (the core feature)

By default the CLI runs the classifier and does what the browser would
(`--mode auto`). But decantCC's whole method is to generate each *variant*
deterministically and score them against each other, so the primary control is a
flag that **overrides the classifier verdict** and forces a specific output. Each
mode maps onto an existing decision-vocabulary outcome — no new conversion
behavior is invented, the CLI just pins the choice:

| `--mode` | Forces | Maps to | Output | Status |
|---|---|---|---|---|
| `auto` (default) | nothing — run the classifier | `classifyDocument()` verdict | whatever the browser would emit | ✅ |
| `markdown` | text-only conversion, ignore the image layer | `decision: convert` (a.k.a. the `convert` ambiguous choice) | stripped Markdown, figures dropped/marked in place | ✅ |
| `figures` | convert **and** keep the figures | the `figures` ambiguous choice (extract-and-reference) | Markdown + extracted figure files / mini-PDF, per `ADR 0006` | ✅ render-free tier |
| `companion` | high-fidelity conversion via the localhost companion | the `companion` ambiguous choice | companion's Markdown (OCR/Docling), per `ARCHITECTURE.md §3` | deferred |

These are the text-producing `AMBIGUOUS_CHOICES`
(`config/defaults.js`: `["ask","convert","figures","companion","original"]`)
surfaced as a flag. Forcing a mode is the CLI's `ARCHITECTURE.md §5` manual
override — the same capability the browser realizes as the ambiguous prompt and
the passthrough hotkey. Two of the browser's choices have no CLI mode:
**`passthrough`/`original`** is redundant on a command line — "send the original"
just means don't run `decant` on the file — and **`ask`** needs an interactive
prompt; its non-interactive equivalent is simply choosing
`auto` and reading the reported decision.

### 4.2 The decantCC two-pass recipe

decantCC generates each scored variant with one invocation per mode — "two
passes to generate each":

```sh
# Pass 1 — stripped text: how much meaning survives text-only conversion?
decant convert corpus/doc.pdf --mode markdown > out/doc.md

# Pass 2 — text + figures: does keeping the figures recover the lost meaning?
decant convert corpus/doc.pdf --mode figures  --out-dir out/doc.figures/
```

Two files (or file sets) from one source, both produced by the shipping engines,
ready to score. A third `--mode companion` pass adds the recognition-tier variant
when the harness has a companion running. Because the mode is forced, the corpus
generation is deterministic and independent of whatever the classifier would have
decided — decantCC controls the axis it's measuring.

`figures` mode uses the **render-free** extraction tier — zip media entries for
PPTX/DOCX, and for PDF a mini-PDF cropped to each figure's box (pdf.js geometry
+ pdf-lib, no canvas), i.e. the same artifact Firefox produces in-browser. The
canvas-only tiers (full page renders, raster-XObject re-encode) need a Node
canvas and are a later pass; a document that would use them still gets its text
plus the cropped mini-PDF.

### 4.3 Other options

- `--out <file>` / `--out-dir <dir>` — write output instead of stdout;
  `--out-dir` is required for `figures` mode (it emits sibling figure files).
- `--config <file>` — a routing/profile config JSON (same shape as the options
  page export, `config/defaults.js`). Absent → `DEFAULT_CONFIG.routing`.
- `--companion <url>` / `--allow-remote` *(deferred with `--mode companion`)* —
  companion endpoint (default `http://127.0.0.1:8765`, the browser's default).
  Non-localhost will trigger the same privacy guardrail the extension enforces
  (`ARCHITECTURE.md §2.1`): the CLI refuses unless `--allow-remote` is passed, so
  a document never silently leaves the machine.
- `--json` — emit the JSON envelope (§5.2) instead of raw Markdown.
- `--quiet` / `--verbose` — control the human-readable diagnostics on stderr
  (stdout stays clean for piping).

---

## 5. Output contract

### 5.1 Default (raw)

- **`markdown` / `auto`-convert**: the Markdown goes to stdout (or `--out`).
- **`figures`**: the Markdown (`<input>.md`) and one file per extracted figure
  land in `--out-dir`, the figures referenced by name from the Markdown's
  association note exactly as the browser attaches them. With `--json`, the
  envelope goes to stdout and names the written paths.
- **No usable conversion** (`auto` when the classifier passes through, or
  `markdown`/`figures` on a no-text document): nothing is written to stdout; the
  decision is reported on stderr and via exit code `10`. On the CLI "send the
  original" is not a conversion — the caller just uses the input file itself.

### 5.2 `--json` envelope

For callers that want the verdict and token math alongside the text, `--json`
emits one object:

```json
{
  "action": "converted",
  "decision": "convert",
  "reason": "text",
  "mode": "markdown",
  "markdown": "…",
  "figures": ["fig-p3.png", "…"],
  "savings": { "tokensAsSource": 64000, "tokensAsMarkdown": 36000, "pct": 44 },
  "meta": { "contentPages": 47, "chartPages": 0, "totalChars": 91234 }
}
```

`decision`/`reason`/`meta` come straight from `classifyDocument()`'s summary;
`savings` from `savings.js` (`estimateTokens`, `IMAGE_TOKENS_PER_PAGE`) — the same
numbers behind the extension's savings badge and the README benchmark table.

### 5.3 Exit codes

Scriptable status without parsing stdout:

| Code | Meaning |
|---|---|
| `0` | converted (Markdown produced) |
| `10` | passthrough (no usable conversion; original is the right answer) |
| `11` | ambiguous — only in `auto`; the classifier wants a human. The forced modes never return this. |
| `1` | usage error (bad flag, missing input) |
| `2` | conversion error (corrupt/encrypted file, engine threw) |

decantCC can therefore branch on exit status alone — e.g. treat `10` as "this
document isn't a conversion candidate, score the original" without reading a byte
of output.

---

## 6. Config, routing & profiles

The CLI honors the same config model as the browser (`config/defaults.js`,
`ARCHITECTURE.md §2.1`):

- With no `--config`, it uses `DEFAULT_CONFIG.routing` — PDF/DOCX/XLSX/PPTX/HTML
  route `inbrowser`, everything else passes through.
- `--config` accepts an options-page export verbatim, so a routing table or M4
  **profile** authored for the extension drives the CLI identically. Malformed
  config fails toward the global table exactly as the browser does (validate on
  load, never brick).
- **`--mode` overrides routing**, mirroring the browser's most-specific-wins
  order (one-shot override → profile → global → default). A forced mode is the
  CLI's one-shot override and sits at the top of that precedence.

The privacy guardrail on non-localhost endpoints (§4.3) is not optional and is
not weakened by the CLI's non-interactivity — it becomes an explicit
`--allow-remote` opt-in rather than a warning dialog, because there's no human to
warn at runtime.

---

## 7. Packaging — Windows first, \*nix next

The distribution requirement is "decantCC invokes a binary; no toolchain
required." That points at **Node's built-in Single Executable Applications
(SEA)**: bundle the CLI's JS, embed the assets, and inject the SEA blob into a
copy of the `node` binary. SEA is the right pick because a *single build recipe*
emits a `decant.exe` on Windows and native ELF/Mach-O binaries on Linux/macOS.

`scripts/build-cli.mjs` (`npm run build:cli`) implements it:

```sh
npm run build:cli                                   # → build/cli/decant  (this OS)
# cross-build a Windows .exe from any host: download the matching node.exe first
node scripts/build-cli.mjs --node ./node-win.exe --platform win --out decant.exe
```

1. **Bundle** the CLI + engines into one CJS file with esbuild, `platform:node`
   — which resolves `#pdfjs` to the legacy build (the `node` condition) and keeps
   `node:` builtins (incl. `node:sea`) external.
2. **Embed the assets** the pdf.js path needs — `pdf.worker.mjs`,
   `standard_fonts/`, `wasm/` (JPX/JBIG2/qcms), `iccs/` — as one `assets.zip` SEA
   asset. At startup `sea-assets.js` unpacks it to a per-version temp dir and
   points the §3.1 resolver there with **plain filesystem paths** (Node's `fetch`
   has no `file://` scheme, so pdf.js reads fonts/WASM via `fs`).
3. **Canvas globals.** pdf.js polyfills `DOMMatrix`/`Path2D` from
   `@napi-rs/canvas` via a `createRequire` that a SEA bundle breaks. The CLI
   never rasterizes (text + the render-free figures tier), so `sea-assets.js`
   supplies a 2D-affine `DOMMatrix` and inert `Path2D`/`OffscreenCanvas` before
   pdf.js loads — enough for module load and text/geometry, and a canvas-only
   path (which the CLI never takes) fails loudly rather than mis-rendering.
4. **Inject** the blob with `postject`. The fuse sentinel is **auto-detected**
   from the target binary, so injecting a downloaded `win-x64` node.exe works
   from a Linux host. Windows distribution then wants ordinary Authenticode
   signing (postject invalidates node.exe's existing signature) — no
   kernel-driver attestation, because this is a plain user-mode executable (a key
   advantage of the sanctioned-tool paradigm over the minifilter path in
   `SURFACES.md`).

**Cross-building note:** the `.exe` is produced by cross-injection, but running
and signing it happen on Windows. Functional verification of the bundle + asset
unpack is via the identical-pipeline Linux binary; the packaging smoke test that
converts a JPX/JBIG2-bearing PDF should run on each target OS.

Alternatives considered: `pkg` (Vercel, now archived — avoid for new work) and
`nexe` (community, less current than SEA). SEA is chosen for being first-party,
maintained, and uniformly cross-platform. Recorded in
[ADR 0016](./adr/0016-cli-surface-for-test-input.md).

A lighter option for hosts that already have Node: run the CLI directly
(`node src/cli/decant.mjs …`, or the `decant` bin), skipping the binary
entirely. decantCC's own environment decides which it needs.

---

## 8. Milestones

- **C0 — Headless parity. ✅ Done.** The §3 asset seam (`getAssetUrl` + `#pdfjs`
  build split) lets `convertFile()` run under Node over all five engines;
  `bench-pdf.mjs` is retargeted onto the shared path (proves parity, kills the
  drift risk). `--mode auto`, Markdown to stdout, `--json`, `--config`, exit codes.
- **C1 — Forced modes. ✅ `markdown` + `figures`.** `--mode markdown` forces
  text-only; `--mode figures` writes the Markdown plus render-free figure files
  to `--out-dir` (zip media / cropped mini-PDF). `passthrough` is intentionally
  not a CLI mode (redundant). `companion` is deferred — it needs the direct-fetch
  transport (§3.2) and the non-localhost `--allow-remote` guardrail.
- **C2 — SEA packaging. ✅ Done (`npm run build:cli`).** One-file bundle +
  embedded `assets.zip` (unpacked at startup) + canvas globals + postject
  injection with auto-detected fuse. Verified end-to-end on the Linux binary;
  the `win-x64` `decant.exe` is produced by cross-injection (§7). Remaining for a
  release: Authenticode signing and the per-OS JPX/JBIG2 smoke test.
- **C3 — CI binaries. ✅ Done.** `.github/workflows/release-cli.yml` builds the
  binary natively on Linux/macOS/Windows (each runner builds and smoke-tests its
  own OS's binary — real per-platform coverage), uploads artifacts every run, and
  on a `v*` tag attaches them to the GitHub Release. `ci.yml` runs the test suite
  + browser build on push/PR. Remaining for a signed release: Authenticode
  (Windows) and Developer-ID/notarization (macOS) secrets, which need real
  certs — the workflow ad-hoc-signs macOS so CI can run the binary.
- **Deferred:** batch/glob input, an end-user-friendly command surface, a
  long-lived server mode (avoid per-file process spawn on huge corpora) if
  decantCC's throughput ever needs it.
