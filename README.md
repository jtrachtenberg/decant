<img width="128" height="128" alt="decant_icon" src="https://github.com/user-attachments/assets/414f16ed-3076-444f-bff2-ebdaa19592b4" />

# Decant

**Convert files to Markdown before they upload.**

Decant converts documents to Markdown directly within the LLM UI but on your local machine, without interrupting your workflow or risking privacy concerns by using online conversion.  

At its core is a surface-agnostic pipeline — `intercept → route → transform → substitute`.
The first surface implemented is a browser extension that catches a PDF or Word
doc as you attach it to an LLM chat and swaps in the Markdown version in place —
built from one source for **Chromium** (Chrome, Brave, Edge) and **Firefox**.
Further surfaces (a Claude Desktop MCP server, native
desktop, mobile) are mapped in [`docs/SURFACES.md`](./docs/SURFACES.md).

The name is a metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment behind. For LLMs, that sediment is the **image layer** —
many chat backends render every page of a PDF as an image and bill you for it
alongside the text. Handing the model Markdown instead drops that cost. The model spends tokens on your content,
not on re-reading pictures of pages.

> **Status: working, M2 complete, M3 core shipped.** The browser extension
> converts PDF, Word, Excel, PowerPoint, and HTML to Markdown on `claude.ai`,
> ChatGPT, and Gemini — through the file picker, drag-and-drop, and paste —
> recovering native chart data and passing scanned or image-only documents
> through untouched so it never silently degrades them. The optional
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
ships with `claude.ai`, `chatgpt.com`, `gemini.google.com`, and
`www.perplexity.ai` enabled (with other common LLM hosts pre-listed but off).
claude.ai, ChatGPT, and Perplexity get the full treatment — picker,
drag-and-drop, and paste all substitute the converted file. Gemini converts
through the file picker only; its uploader rejects synthetic drops, so on
Gemini drag-and-drop/paste intentionally send the original file unconverted
rather than lose it.
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
