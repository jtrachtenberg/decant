# Decant — Pre-publish Smoke Checklist

A manual pass to run against a freshly built `dist/` before shipping a build
(Web Store upload, or handing a build to testers). Not a substitute for
`npm test` — this covers what unit tests can't: the real extension in a real
browser against real sites. Work top-down; stop and file an issue on any
surprise.

Setup: `npm test` (green) → `npm run build` → load `dist/` unpacked at
`chrome://extensions` (or hit **reload** on the card if already loaded).

## 1. Load & chrome

- [ ] Extension loads with no errors on the `chrome://extensions` card.
- [ ] Toolbar icon renders (not a broken/placeholder image).
- [ ] Options page opens (right-click the icon → Options, or the card's Details
      → Extension options) and shows the host list, rules, and hotkey.
- [ ] Service-worker console (card → "Inspect views: service worker") is free of
      errors on load.

## 2. Activation (default-deny)

- [ ] On a site **not** in the enabled list (e.g. `example.com`), a file drop
      does nothing — Decant is absent. No console `[decant]` logs.
- [ ] `claude.ai` and `gemini.google.com` work out of the box (enabled by
      default + bundled host permissions).
- [ ] Enabling a new host in options prompts Chrome for its permission;
      declining leaves it off; removing a host revokes it.

## 3. Core intake × outcome matrix (on claude.ai)

Use a small text PDF unless noted. After each, confirm the composer shows the
expected attachment and the service-worker/page console agrees.

- [ ] **Picker × convert** — attach via the paperclip → `.md` chip.
- [ ] **Drop × convert** — drag onto the composer → `.md` chip; drag overlay
      clears immediately.
- [ ] **Paste × convert** — copy a file, paste into the composer → `.md` chip.
- [ ] **Ambiguous prompt** — a text-with-images/charts doc prompts Convert vs.
      Send original. **Convert** → `.md` (with `[image omitted]` markers);
      **Send original** → the untouched original attaches.
- [ ] **Convert + attach figures** — an image-bearing PPTX/DOCX offers the
      figures choice; picking it attaches the `.md` **plus** `<name>-figN.png`
      siblings (junk-sized media filtered, capped at 8). A doc whose media is
      all junk degrades to the `.md` alone.
- [ ] **Figure overflow → contact sheet** — on claude.ai, a doc with more than
      5 figures attaches ONE `<name>-figures.png` grid instead: every figure
      tiled with its name captioned under it, borders visible, captions
      legible. (Verify claude.ai's actual per-message image limit while here.)
- [ ] **Ambiguous default** — tick “Set as default” on the prompt and pick a
      choice → next ambiguous upload applies it without prompting; the options
      page dropdown (Behavior) shows it and setting back to “ask each time”
      restores the prompt. Dismissing with ✕/Escape while the box is ticked
      does NOT save a default.
- [ ] **PDF chart pages as figures** — an ambiguous PDF (text + chart pages,
      e.g. the WHO doc) offers the figures choice; picking it attaches the
      `.md` plus ONE `<name>-charts.pdf` (a document attachment, so it doesn't
      count against the image limit). Open the mini-PDF: pages should be
      **cropped to the figure region** (chart + surrounding labels) where the
      geometry allows, whole pages otherwise. An encrypted PDF falls back to
      `<name>-pN.png` page renders, sliced to the site's image limit.
- [ ] **Single-figure prompt** — a ONE-page PDF with text plus a real
      chart/photo image offers the ambiguous prompt (reason: a significant
      figure bypasses the 2-chart-page threshold); a one-page PDF whose only
      image is a small logo converts quietly with no prompt.
- [ ] **Decoded photo figures** — a PDF whose chart page is a single embedded
      photo/diagram (not a vector chart): the mini-PDF page for it should be
      the image at native sharpness (decoded XObject, JPEG-embedded), not a
      2× page-render crop — zoom in and compare edges against the original.
      A vector-chart doc (e.g. WHO) must be unaffected: its pages still crop.
      Console logs `decoded N raster figure(s)` when the path fires.
- [ ] **Decoded photo figures (Firefox)** — same document on Firefox: the
      decode path is render-free and is *tried* there; if the JPEG re-encode
      fails in the content-script sandbox it must degrade silently to the
      vector CropBox path (never a hang, never a lost upload).
- [ ] **Figure anchoring** — the `.md`'s omission markers carry page numbers
      (`[2 images omitted — page 17]`) and it ends with a footer mapping
      charts.pdf pages to document pages. Probe: ask the model "what does the
      figure on page 17 show?" — it should describe the right chart from the
      mini-PDF, not guess.
- [ ] **Passthrough** — a scanned / no-text PDF attaches unchanged (no prompt).
- [ ] **Passthrough hotkey** — press `Alt+Shift+O` (badge appears), then drop a
      convertible file → the **original** attaches, badge clears. Press again /
      `Esc` disarms.
- [ ] **Large PDF** — a ~100+ page PDF shows the converting badge promptly and
      finishes without the tab hanging.

## 4. Formats (each converts on claude.ai)

- [ ] **PDF** — text PDF → Markdown; headings/tables preserved; multi-column
      reflows in reading order.
- [ ] **DOCX** — headings, bold/italic, links, and tables survive; images →
      `[image omitted: ...]` inline.
- [ ] **XLSX / XLS** — one Markdown table per sheet; pipes escaped; legacy `.xls`
      also converts.
- [ ] **PPTX** — slide titles → headings, body → leveled bullets, slide tables →
      tables; a deck with pictures/charts prompts (and marks omissions); a
      text-only deck converts with **no** prompt.
- [ ] **HTML** — saved web page → clean Markdown; no `<script>`/`<style>` leakage;
      remote images stay as Markdown links.
- [ ] **Size ceilings** — a DOCX/PPTX/XLSX whose XML inflates past 16 MB, or any
      file over 100 MB, attaches the **original** within a second or two, with
      no tab freeze (page console: `passthrough … (too-large)`). A large but
      ordinary document (e.g. a 40 MB image-heavy DOCX, a 300-page PDF) still
      converts.
- [ ] **Drop elsewhere** — drag a PNG or ZIP onto a *different* upload area
      (project knowledge, a modal uploader): it lands there, not in the
      composer, and no `[decant] drop intercepted` log appears.

## 5. Per-site adapters

- [ ] **Gemini** — picker (+ → Upload files) converts to `.md`. Drag-and-drop and
      paste send the **original** natively (by design — no lost file, no error
      notice). See `docs/` / memory for why.

## 6. Options page

- [ ] Add / remove a host; toggle a host on/off.
- [ ] Toggle a routing rule off → that file type now passes through on the site;
      toggle on → converts again (no reload needed).
- [ ] Add a rule (e.g. an endpoint rule) — the endpoint-permission prompt fires;
      a non-localhost endpoint shows the ⚠ warning.
- [ ] **Show current** dumps config JSON; edit and **Apply JSON** round-trips
      (malformed rules are dropped, not fatal).
- [ ] Rebind the hotkey (must include Alt/Ctrl/Cmd); **Reset to defaults** works.

## 7. HTTP / companion transport (optional — needs the mock)

Run `npm run mock-endpoint`, add a rule routing `.txt` → `http://127.0.0.1:8765/convert`
(responseField `text`).

- [ ] Drop a `.txt` → converted `.md` from the endpoint attaches.
- [ ] Point the rule at `/error` → drop → the rule's fallback fires (original
      attaches), nothing lost.

### Companion access control and escalation (real companion)

Run the companion (`cd companion && python server.py`, `DECANT_ENGINE=docling`
for OCR, `echo` for wiring only). Add a PDF rule **Convert in browser** → *If
the browser finds no text* → **escalate to local companion**, endpoint
`http://127.0.0.1:8765/convert`, response field `text`, and **allow** the
permission prompt.

- [ ] Attach a scanned (image-only) PDF → the companion log shows one
      `POST /convert` 200 and a `.md` attaches (onEmpty escalation).
- [ ] An ambiguous doc with the same rule offers **Convert with companion**;
      picking it posts to the companion and attaches its `.md`.
- [ ] From an ordinary web page's console,
      `fetch("http://127.0.0.1:8765/health")` fails (no CORS) and a
      `fetch(…/convert, {method:"POST", body: new FormData()})` gets **403**.
- [ ] With `DECANT_TOKEN=abc` set on the server, the rule fails over to its
      fallback until the endpoint is changed to `…/convert?token=abc`; then it
      converts again, and the server log shows `token=***`.
- [ ] Remove the `http://127.0.0.1` grant (chrome://extensions → Details →
      Site access) → escalation now falls back (service worker logs
      `relay rejected: no host permission`).

## 8. Fingerprinting

- [ ] From an unrelated page's console,
      `fetch("chrome-extension://<id>/pdf.worker.mjs")` is **blocked**
      (the `use_dynamic_url` guard).
