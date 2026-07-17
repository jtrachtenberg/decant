<img width="128" height="128" alt="decant_icon" src="https://github.com/user-attachments/assets/414f16ed-3076-444f-bff2-ebdaa19592b4" />

# Decant

**Convert files to Markdown before they upload.**

Decant converts documents to Markdown directly within the LLM UI but on your local machine, without interrupting your workflow or risking privacy concerns by using online conversion.  

At its core is a surface-agnostic pipeline — `intercept → route → transform → substitute`.
The first surface implemented is a browser extension that catches an upload in a
supported file format as you attach it to an LLM chat and swaps in the Markdown
version in place —
built from one source for **Chromium** (Chrome, Brave, Edge) and **Firefox**.
Further surfaces (a command-line converter, a Claude Desktop MCP server, native
desktop, mobile) are mapped in [`docs/SURFACES.md`](./docs/SURFACES.md).

The name is a metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment behind. For LLMs, that sediment is the **image layer** —
many chat backends render every page of a PDF as an image and bill you for it
alongside the text. Handing the model Markdown instead drops that cost. The model spends tokens on your content,
not on re-reading pictures of pages.

> **Status: working, M3 complete.** The browser extension
> converts PDF, Word, Excel, PowerPoint, and HTML to Markdown on `claude.ai`
> and ChatGPT — through the file picker, drag-and-drop, and paste — and on
> Gemini through the file picker — recovering native chart data and passing
> scanned or image-only documents through untouched so it never silently
> degrades them. The optional
> **local companion service** adds the higher-fidelity tier: scans escalate to
> OCR, and ambiguous documents can convert without dropping their visuals.
> It builds for both **Chromium** (Chrome, Brave, Edge) and **Firefox** from a
> single codebase. It's not yet on any extension store, and additional surfaces
> below are still planned. The
> [Project docs](#project-docs) cover the design; the [Roadmap](#roadmap) tracks
> status.

---

## Why

Uploading a raw PDF to an LLM is often the most expensive way to share it. A
document whose actual text is modest can balloon in token cost once each page is
rendered as an image. Converting to Markdown up front:

- **Cuts token cost** — biggest wins on text-heavy PDFs.
- **Keeps structure** — headings, lists, and tables survive better as Markdown
  than as a flattened page image.
- **Stays on your machine** — conversion is local by default; your documents
  don't go to a third party.

The catch Decant respects: the image layer isn't pure waste. It's what lets a
model read charts, scans, and complex tables. So Decant **never converts
blindly** — visually-heavy documents can pass through untouched, and you stay in
control of what gets transformed.

---

## Benchmarks

Six real PDFs from the [decantCC](https://github.com/jtrachtenberg/decantCC)
evaluation corpus, converted by Decant's in-browser pipeline (the same code the
extension runs). File sizes are measured. Token figures use the same
conservative model as the extension's savings badge: text at ~4 characters per
token, plus **500 tokens per page** for the image layer chat backends render
alongside a raw PDF — the low end of the observed 400–700/page range. Actual
billing varies by model and backend, so treat the token columns as estimates;
the size columns are exact.

| Document | Pages | PDF → Markdown | Est. tokens as PDF | As Markdown | Saved |
|---|---:|---:|---:|---:|---:|
| CERN annual report (charts on most pages) | 56 | 15.6 MB → 140 KB | ~64k | ~36k | ~44% |
| Guide to reading financial statements (clean prose) | 47 | 265 KB → 106 KB | ~51k | ~27k | ~46% |
| Housing tax-credit FAQ (prose, a few figures) | 42 | 839 KB → 62 KB | ~37k | ~16k | ~57% |
| Municipal program report (dense multi-column) | 98 | 4.5 MB → 172 KB | ~93k | ~44k | ~53% |
| Asset-manager climate report (photo-heavy) | 29 | 14.9 MB → 95 KB | ~39k | ~24k | ~37% |
| Corporate sustainability data supplement (dense tables) | 36 | 15.0 MB → 152 KB | ~57k | ~39k | ~32% |

What the numbers say:

- **Estimated token cost drops ~32–57%**, with the biggest wins where prose
  dominates and the smallest where figures carry more of the meaning — exactly
  the trade-off Decant is built around.
- **Size on disk drops 60–99%.** The three print-production PDFs (~15 MB each)
  convert to under 160 KB of Markdown — the upload stops being a large-file
  problem entirely.
- **Conversion is fast**: every document above converted in under ~3 seconds
  (0.2 s for the smallest, 3.1 s for the 627-image data supplement) — no
  noticeable pause between attaching a file and the swap.
- **Five of the six carry real figures**, so Decant classified them *ambiguous*
  and would prompt instead of converting silently. Choosing **Convert + attach
  figures** keeps the charts as a cropped mini-PDF and honestly nets each
  attached page back out of the claimed savings.

Whether the *meaning* survives conversion is the question being answered by the
[decantCC](https://github.com/jtrachtenberg/decantCC) project, which scores
conversions by asking an LLM questions whose gold answers come from the source
document.

To benchmark your own documents:

```bash
node scripts/bench-pdf.mjs "<file.pdf>"
```

---

## How it works

Under the hood, Decant is a small, general pipeline:

```
intercept  →  route by file type  →  transform  →  substitute back into the upload
```

Conversion is split along the line that actually matters — **parsing vs.
recognition**:

- **Parsing** (fast, in-browser, zero install): reading data that's already
  structured. Digital PDFs carry a real text layer; Office files (DOCX/XLSX) are
  just zipped XML. This is handled in the browser with mature JS libraries.
- **Recognition** (optional local companion): turning pixels into structure —
  OCR on scanned pages, neural table extraction, figure description. This needs
  real models, so it runs in an optional local helper process you can install
  if and when you want that quality tier.

For most everyday uploads — clean PDFs, Word docs, spreadsheets — the in-browser
path is the right tool, and nothing extra needs to run.

---

## Configuration

Two independent layers, both **default-off**:

### Activation — where Decant runs
Decant does nothing on any page unless its host is explicitly whitelisted. It
ships with [claude.ai](https://claude.ai), [chatgpt.com](https://chatgpt.com),
[gemini.google.com](https://gemini.google.com), and
[www.perplexity.ai](https://www.perplexity.ai) enabled (with other common LLM
hosts pre-listed but off).
claude.ai, ChatGPT, and Perplexity get the full treatment — picker,
drag-and-drop, and paste all substitute the converted file. Gemini converts
through the file picker only; its uploader rejects synthetic drops, so on
Gemini drag-and-drop/paste intentionally send the original file unconverted
rather than lose it.
[copilot.microsoft.com](https://copilot.microsoft.com) isn't pre-listed, but
gets the full treatment too once you add it yourself in options. So does
[www.kimi.com](https://www.kimi.com) — its paperclip picks through a detached
file input that never touches the DOM, invisible to normal event interception,
so Decant hooks input creation itself with a small page-world shim and relays
the pick to the converter
([ADR 0019](./docs/adr/0019-main-world-detached-picker-bridge.md)).
Manage the list from the **options page**. Enabling a host asks Chrome for
permission to run there and registers the content script dynamically, so the
install prompt stays minimal and nothing injects into sites you haven't opted in.

### Routing — what happens to each file type
Rules keyed by MIME type / extension decide each file's fate:

- `inbrowser` — convert with the built-in JS engines
- `companion` — send to the local helper for high-fidelity / OCR
- `http` — send to any endpoint you configure and substitute the result
- `passthrough` — leave the file untouched (the default for anything unmatched)

Defaults route PDFs and Word docs to Markdown; everything else passes through
until you say otherwise. Because routing is generic, you can point any file type
at any endpoint — e.g. route images to a local OCR service and have the extracted
text dropped into the upload.

> **Privacy note:** routing to a non-`localhost` endpoint means a document leaves
> your machine. Decant warns you before that happens; it's always an opt-in.

---

## Install (development)

Decant isn't packaged for any extension store yet. To run the work-in-progress
locally:

```bash
git clone https://github.com/jtrachtenberg/decant.git
cd decant
npm install
npm run build            # Chromium (Chrome/Brave/Edge) → dist/
npm run build:firefox    # Firefox                       → dist-firefox/
```

Both builds come from one source; the Firefox build is derived at build time
(event-page background, gecko id) and a few Firefox-only content-script quirks
are handled at runtime.

**Chrome / Brave / Edge** (all load the `dist/` build unmodified):

1. Go to `chrome://extensions` (`brave://extensions`, `edge://extensions`)
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder

**Firefox** (temporary add-ons are cleared when Firefox restarts):

1. Go to `about:debugging` → **This Firefox**
2. Click **Load Temporary Add-on** and select `dist-firefox/manifest.json`

### Optional: the local companion (recognition tier)

For OCR and high-fidelity conversion of image-heavy documents:

```bash
cd companion
pip install -r requirements.txt
python server.py   # serves on http://127.0.0.1:8765 by default
```

Decant talks to it over `localhost` only. If it isn't running, routes that depend
on it fall back gracefully (in-browser conversion or passthrough).

---

## Roadmap

- **M0 — Hello, swap. ✅ Complete.** Interception proven: file picker,
  drag-and-drop, and paste uploads on `claude.ai` are intercepted and the file
  is substituted before the site sees it.
- **M1 — In-browser conversion. ✅ Complete.**
  - PDF → Markdown via pdf.js across picker, drag-and-drop, and paste, with
    heading/table structure and multi-column reflow in reading order.
  - Per-document classifier: **convert** (text) / **passthrough** (scans, no
    usable text) / **ambiguous** (text plus charts — prompts a per-file choice).
  - Manual overrides: the ambiguous prompt and a **passthrough hotkey**
    (`Alt+Shift+O`) that sends the next upload untouched.
- **M2 — Polish & config. ✅ Complete.**
  - Options page: default-deny activation whitelist (dynamic permissions),
    routing table, hotkey binding, JSON import/export, non-localhost warnings.
  - `http`/`companion` transport with per-rule fallbacks — a dead endpoint can
    never lose an upload; `npm run mock-endpoint` is the executable contract.
  - **DOCX / XLSX / PPTX / HTML engines** (mammoth, SheetJS, Turndown + native
    parsers); dropped visuals are marked in place (`[image omitted: label]`).
  - **Charts recovered as data** — cached OOXML series become Markdown tables
    instead of lost pictures
    ([ADR 0005](./docs/adr/0005-charts-recovered-as-data.md)).
  - Flattened-chart "label soup" caught by a column-convergence check;
    packaging pass, per-site adapters (claude.ai/ChatGPT full, Gemini
    picker-only), and the estimated **token-savings badge**.
- **M3 — Companion tier & the image layer. ✅ Complete.**
  - Local **companion service** (`companion/`): Flask, MarkItDown default,
    **Docling** opt-in for OCR/quality, `echo` for contract tests.
  - **Forward escalation** (`onEmpty`): scans the browser can't read escalate
    to companion OCR; native PDFs stay fast and local. Plus a **"Convert with
    companion"** choice on the ambiguous prompt. Both opt-in, always
    fall back without losing the upload.
  - **Extract-and-reference**: a **"Convert + attach figures"** choice —
    PPTX/DOCX images attach as sibling files (contact sheet on overflow);
    PDF chart pages ship as a **cropped, page-stamped mini-PDF** the model can
    cross-reference by the document's own printed page numbers, with savings
    netted honestly
    ([ADR 0006](./docs/adr/0006-extract-and-reference-figures.md)). Pages
    whose figure is a single embedded photo/diagram get the **raster XObject
    decoded at native resolution** instead of a page-render crop (gated
    conservatively — ambiguity always falls back to the crop). Handles
    JPEG2000/JBIG2 images and pure vector charts, and keeps the most
    figure-valuable pages when a document exceeds the attachment cap.
  - A **"set as default"** choice on the ambiguous prompt + matching options
    setting (`ask` by default — automation is opt-in). Even a single-page PDF
    prompts when its image is a **real figure** (size/pixel significance, not
    page count — [ADR 0008](./docs/adr/0008-figure-significance-ambiguity.md));
    lone logos still convert quietly.
  - **Corrupt chart tables gated**: a table cell holding control characters
    (a font with no text mapping — provably garbage) makes the whole table
    emit as `[chart table omitted — unreliable extraction; see attached
    figure, document page N]` instead of plausible-looking wrong data, and
    floating legend/axis text boxes beside a chart's grid are kept out of its
    rows instead of shredding into them.
  - **Decoration out, symbol charts in**
    ([ADR 0009](./docs/adr/0009-background-demotion-vector-symbol-charts.md)):
    full-bleed cover/divider art and images the page's text is printed over
    no longer count as figures, while charts that encode values as colored
    vector symbols (risk matrices, heatmap grids — invisible to both the
    raster and convergence signals) are detected from their multi-hue fill
    pattern, attached as flattened chart pages **cropped to the chart's own
    band** (whole page whenever the band isn't confident), and flagged in
    the Markdown so the model knows the rows are missing their values.
  - **Designed/interactive PDFs read clean** (testing-period hardening):
    full-bleed background art that design tools slice into abutting raster
    tiles is reassembled and judged as one component, so decorated text pages
    stop attaching as figures and crops frame the real photo/infographic
    ([ADR 0010](./docs/adr/0010-tiled-art-reassembly.md)); nav rails and
    running headers repeated at the same position across pages are stripped
    as furniture before reconstruction, ending the column interleave they
    caused ([ADR 0011](./docs/adr/0011-repeated-text-furniture.md)); and
    column detection generalizes past a single gutter — 3–4-column pages
    reflow stream-by-stream via recursive splits that must each earn
    acceptance (convergence, interleave, and glue evidence; symbol rails like
    R/S commitment letters stay row-paired with their entries), with aligned
    prose columns no longer formalized into fake pipe tables
    ([ADR 0012](./docs/adr/0012-n-column-guarded-recursion.md)); and line
    reconstruction assembles cells in x order with word spacing, span
    regions, and headings judged at each glyph run's own size - fixing
    spliced subscripts (tCO2e, Nb3Sn), display headings interleaved into
    side legends, symbol letters emitting as fake headings, and hanging
    panel headers gluing two streams into one line
    ([ADR 0013](./docs/adr/0013-display-band-reconstruction.md)); and
    letter-chip tag rails (G/RM/S/MT pillar tags beside disclosure items)
    bind to their items as one table row per item, validated end-to-end by
    an LLM Q&A that previously failed on the converted output
    ([ADR 0014](./docs/adr/0014-tag-rail-row-binding.md)); and decoration
    stops attaching as figures — images reused across pages (background-art
    sets, gradient strips) demote via a document-level census extending the
    decode gate's repetition rule to classification, panel textures the
    page's text is printed over demote by text density,
    transparency-flattener debris demotes by paint overlap, the Tier 2
    convergence flag attaches only with visual evidence, and vector-chart
    bands crop to their own panel on landscape slide layouts — cutting one
    corpus doc's attachments 18 → 10, exactly its real photos/charts, with
    crops framing the figure instead of the page
    ([ADR 0015](./docs/adr/0015-repeated-image-and-text-density-demotion.md));
    and icon-key pages decode to text — a page whose repeated textless icons
    (status badges, legend symbols) are defined in its own KEY legend gets
    each icon's label written into its row as a table cell, recovering the
    one column no text layer carries (24/24 status values correct on the
    calibration doc) and releasing the page from the charts-PDF attachment
    when the accounting closes exactly
    ([ADR 0017](./docs/adr/0017-icon-key-symbol-references.md)); and
    side-by-side panel tables emit separately, each headed by its own
    rebound panel heading (PHASE 1/2/3), fixing a measured LLM
    phase-attribution miss
    ([ADR 0018](./docs/adr/0018-panel-heading-rebinding.md)).
  - Deferred as nice-to-haves (post-M3): **figure descriptions** as inline
    text (describe-in-text via the companion's VLM — the mini-PDF already
    gives the model the figures themselves); companion quality-gate polish
    ("companion dropped N figures" badge + Docling chart-extraction enrich);
    in-place rule editing on the options page; quick-add `responseField`.
- **M4 — Profiles.** Per-host overrides on the global config: convert PDFs to
  Markdown everywhere, but always pass through on one site, or forward a file
  type to a specific endpoint on another. Same rule shape as global routing,
  merged per file type and resolved most-specific-wins (one-shot hotkey → site
  profile → global). Design in `SPEC.md` §3.8 and `docs/ARCHITECTURE.md` §2.1.

---

## Project docs

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — the surface-agnostic core
  design: the `intercept → route → transform → substitute` pipeline, the
  swappable converter interface, the parsing-vs-recognition boundary, and the
  engine landscape.
- [`docs/SURFACES.md`](./docs/SURFACES.md) — the surfaces Decant can ship on
  (browser, Claude Desktop MCP, native desktop, mobile) and the expansion
  strategy.
- [`SPEC.md`](./SPEC.md) — the **browser-extension surface**: Manifest V3
  interception mechanics, the config model, and the M0–M3 milestones.
- [`docs/CLI.md`](./docs/CLI.md) — the **command-line surface**: the headless
  reuse of the conversion core that generates decantCC's test input, its forced
  `--mode` flags, and the Windows-`.exe`-first packaging path.
- [`docs/adr/`](./docs/adr/) — the decision log (architecture decision records).
- [`docs/QA-fidelity-check.md`](./docs/QA-fidelity-check.md) — how to check a
  conversion for information loss and file a triageable bug report.
- [`docs/smoke-checklist.md`](./docs/smoke-checklist.md) — the manual pre-publish
  pass: the real extension in a real browser, format by format and site by site.
- [`docs/privacy.md`](./docs/privacy.md) — privacy policy: what Decant accesses,
  how files are processed, and what never leaves your device.

---

## Contributing

Early-stage and moving fast — [issues](https://github.com/jtrachtenberg/decant/issues) and [discussion](https://github.com/jtrachtenberg/decant/discussions) are welcome. If you're
opening a PR, please read [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for the
intended architecture (especially the parsing-vs-recognition boundary and the
default-deny config model), and [`SPEC.md`](./SPEC.md) for the browser-surface
specifics your change touches.

---

## License

Decant is released under the **PolyForm Noncommercial License 1.0.0** — see
[`LICENSE`](./LICENSE). You're free to use, modify, and share it for any
**non-commercial** purpose; commercial use by others isn't granted. The rationale
is recorded in
[`docs/adr/0001-license-polyform-noncommercial.md`](./docs/adr/0001-license-polyform-noncommercial.md).

A note on terms: this makes Decant **source-available**, not "open source" in the
OSI sense (the OSI and FSF definitions don't permit non-commercial restrictions).
That's a deliberate choice, not an oversight.

**Commercial use** — noncommercial covers individuals, hobby projects, and
nonprofits/education/government (see the license for the full list). A for-profit
company using Decant internally (e.g. rolling it out across a team or bundling it
into a deployment image) is *not* covered and needs a separate commercial license.
If that's you, reach out at **j.trachtenberg@gmail.com** — happy to sort it out.

Third-party dependencies keep their own permissive licenses (see
[`THIRD-PARTY-NOTICES`](./THIRD-PARTY-NOTICES)). Any GPL-licensed conversion tools
are used only at arm's length via the separate companion process, never bundled
into the extension.

---

## Early testers wanted

If you'd like to help test Decant with your own documents, visit our GitHub Discussions:

👉 https://github.com/jtrachtenberg/decant/discussions

Please remove any personally identifiable or confidential information before sharing files or screenshots.

---
## Support

Decant is free. If it saves you money on tokens and you'd like to give something
back, donations are welcome and entirely optional — they don't affect the license
or anyone's ability to use the project.

https://buymeacoffee.com/jtrachtenberg
