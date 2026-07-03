<img width="128" height="128" alt="decant_icon" src="https://github.com/user-attachments/assets/414f16ed-3076-444f-bff2-ebdaa19592b4" />

# Decant

**Convert files to Markdown before they upload.**

Decant converts documents to Markdown directly within the LLM UI but on your local machine, without interrupting your workflow or risking privacy concerns by using online conversion.  

At its core is a surface-agnostic pipeline — `intercept → route → transform → substitute`.
The first surface implemented is a Chrome extension that catches a PDF or Word
doc as you attach it to an LLM chat and swaps in the Markdown version in place. 
Further surfaces (a Claude Desktop MCP server, native
desktop, mobile) are mapped in [`docs/SURFACES.md`](./docs/SURFACES.md).

The name is a metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment behind. For LLMs, that sediment is the **image layer** —
many chat backends render every page of a PDF as an image and bill you for it
alongside the text. Handing the model Markdown instead drops that cost. The model spends tokens on your content,
not on re-reading pictures of pages.

> **Status: working, early.** Today the browser extension converts PDFs to
> Markdown on `claude.ai` — through the file picker, drag-and-drop, and paste —
> and lets scanned or image-only PDFs pass through untouched so it never silently
> degrades them. It's not yet on the Chrome Web Store, and the higher-fidelity
> conversion and additional surfaces below are still planned. The
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
ships with `claude.ai` and `gemini.google.com` enabled (with other common LLM
hosts pre-listed but off — on Gemini the file-picker path converts, while
drag-and-drop/paste intentionally send the original file unconverted: Gemini's
uploader only accepts trusted drops, so its site adapter passes the native
event through rather than lose the upload);
manage the list from the **options page**. Enabling a host asks Chrome for
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

- **M0 — Hello, swap. ✅ Complete.** Interception proven: file picker,
  drag-and-drop, and paste uploads on `claude.ai` are intercepted and the file
  is substituted before the site sees it.
- **M1 — In-browser conversion. ✅ Complete.** Real PDF→Markdown via pdf.js
  across all three intake paths (picker, drag-and-drop, paste). A content
  classifier decides per document — **convert** (text), **passthrough** (scans /
  no usable text), or **ambiguous** (text plus image-charts). The extracted
  Markdown carries heading and table structure, and multi-column pages are
  reflowed into reading order (column-by-column) rather than left interleaved.
  Two manual overrides put you in control: ambiguous documents prompt a per-file
  **Convert to Markdown / Send original** choice, and a **passthrough hotkey**
  (`Alt+Shift+O`) arms the next upload to be sent untouched. (Making the hotkey
  binding user-configurable comes with the options page in M2.)
- **M2 — Polish & config. 🚧 In progress.** An options page now manages the
  activation whitelist (default-deny, with dynamic content-script registration
  and per-host permission prompts), the passthrough hotkey binding, and the
  **routing table** — ordered per-type rules
  (`inbrowser` / `companion` / `http` / `passthrough`) deciding each
  intercepted file's fate, with whole-config JSON import/export and a warning
  whenever a rule points at a non-localhost endpoint. The `http` / `companion`
  transport is live: matching files POST to the configured endpoint from the
  background worker (multipart or base64-JSON, per-rule response parsing and
  output naming), and any endpoint failure takes the rule's fallback —
  in-browser conversion or passthrough — so a dead endpoint can never lose an
  upload. A zero-dependency mock endpoint (`npm run mock-endpoint`) doubles as
  the executable contract for the M3 companion service. **DOCX → Markdown**
  now converts in-browser via mammoth.js: headings and emphasis survive,
  inline images are never dropped silently (documents that contain them get
  the same Convert / Send-original prompt PDFs do), and stored configs migrate
  to include the new default rule. **XLSX/XLS → Markdown tables** via SheetJS:
  one table per sheet, empty and very large workbooks pass through untouched.
  (Embedded charts/images in spreadsheets can't be detected by the community
  SheetJS build — the one format without an "ambiguous" prompt.)
  **PPTX → Markdown**: slide titles become headings, body text becomes
  leveled bullets, slide tables become Markdown tables — and since decks are
  the most visual format of all, any deck with pictures or charts gets the
  Convert / Send-original prompt.
  **HTML → Markdown** via Turndown (+ GFM tables): scripts, styles, and tag
  soup — most of a raw HTML file's token cost — are stripped away; remote
  images survive as ordinary Markdown image links, embedded data-URI images
  get omission markers and the prompt. Wherever conversion drops a visual
  (PDF pages, DOCX, PPTX, HTML), the output now says so in place:
  `[image omitted: label]`.
  Still ahead: per-site adapters so enabling other hosts actually converts there
  (including per-surface file-input selection config), the Web Store packaging
  pass — manifest icons, production name, commercial-licensing notice, and a
  manual smoke checklist (picker/drop/paste × convert/ambiguous/passthrough/hotkey)
  in `docs/` — and a token-savings estimate.
- **M3 — Companion tier & the image layer.** Local Python service for OCR /
  high-fidelity tables, plus **figure descriptions** (Docling/MarkItDown turn
  charts and images into inline text — the recognition tier the in-browser
  engines can't provide). Alongside it, **extract-and-reference**: attach the
  converted Markdown *plus* the document's actual figures as sibling files
  (free for PPTX/DOCX, whose images are just zip entries), so the model pays
  image tokens only for figures that matter — likely a third choice on the
  ambiguous prompt ("Convert + attach figures").
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
