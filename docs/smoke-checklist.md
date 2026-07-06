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
      `.md` plus ONE `<name>-charts.pdf` containing just the chart pages
      (native fidelity; a document attachment, so it doesn't count against the
      image limit). Open the mini-PDF and confirm the right pages made it.
      An encrypted PDF falls back to `<name>-pN.png` page renders, sliced to
      the site's image limit.
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

## 8. Fingerprinting

- [ ] From an unrelated page's console,
      `fetch("chrome-extension://<id>/pdf.worker.mjs")` is **blocked**
      (the `use_dynamic_url` guard).
