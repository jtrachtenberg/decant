# Decant

**Convert files to Markdown before they upload.**

Decant is a Chrome extension that intercepts a file on its way *out* — when you
attach a PDF or Word doc to an LLM chat — and quietly swaps it for a clean
Markdown version before it ever reaches the server.

The name is the metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment behind. For LLMs, that sediment is the **image layer** —
many chat backends render every page of a PDF as an image and bill you for it
alongside the text. Handing the model Markdown instead drops that cost, often
dramatically, on text-based documents. The model spends tokens on your content,
not on re-reading pictures of pages.

> **Status: early development.** This repo is being built in the open from a
> written spec ([`SPEC.md`](./SPEC.md)). It is not yet on the Chrome Web Store,
> and not everything described below is implemented. The spec is the source of
> truth for what's planned; this README describes the project's intent and how to
> run what exists.
>
> **Progress:** Milestone 0 (interception + file swap on `claude.ai`) is
> complete. Milestone 1 (in-browser PDF→Markdown via pdf.js, with scanned-PDF
> passthrough) is in progress and working for text PDFs. See the
> [Roadmap](#roadmap) for what's next.

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
Decant does nothing on any page unless its host or URL is explicitly whitelisted.
It ships with `claude.ai` enabled; add other hosts (or specific URLs) yourself.
No blanket injection into every site you visit.

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

Decant isn't packaged for the Web Store yet. To run the work-in-progress locally:

```bash
git clone https://github.com/jtrachtenberg/decant.git
cd decant
npm install
npm run build      # emits the unpacked extension to dist/
```

Then load it in Chrome:

1. Go to `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `dist/` folder

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

- **M0 — Hello, swap. ✅ Complete.** Interception proven: file picker and
  drag-and-drop uploads on `claude.ai` are intercepted and the file is
  substituted before the site sees it.
- **M1 — In-browser conversion. 🚧 In progress.** Real PDF→Markdown via pdf.js,
  with text-layer detection so scanned PDFs pass through instead of degrading.
  Working for text PDFs today; clipboard paste and table/heading structure are
  still to come.
- **M2 — Companion tier.** Local Python service for OCR / high-fidelity tables.
- **M3 — Polish.** Office formats, full config UI, multi-site support,
  token-savings estimates.

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

---

## Contributing

Early-stage and moving fast — issues and discussion are welcome. If you're
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

Third-party dependencies keep their own permissive licenses (see
[`THIRD-PARTY-NOTICES`](./THIRD-PARTY-NOTICES)). Any GPL-licensed conversion tools
are used only at arm's length via the separate companion process, never bundled
into the extension.

---

## Support

Decant is free. If it saves you money on tokens and you'd like to give something
back, donations are welcome and entirely optional — they don't affect the license
or anyone's ability to use the project.

https://buymeacoffee.com/jtrachtenberg
