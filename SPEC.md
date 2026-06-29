# Decant — Browser Extension Spec

**Browser-extension surface — implementation spec.**

A Chrome extension that intercepts file uploads to LLM chat UIs and swaps the
original file (PDF/DOCX/etc.) for a clean Markdown version *before* it reaches
the server — so the model spends tokens on content, not on rendering page images.
The name is the metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment (the image layer) behind. PDF/doc → Markdown is the
default; under the hood it's a general intercept → transform → substitute pipeline.

> **Scope:** This spec covers the **browser-extension surface**. The
> surface-agnostic core (pipeline, converter interface, parsing-vs-recognition,
> engines) lives in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md). Other
> surfaces and the expansion strategy live in
> [`docs/SURFACES.md`](./docs/SURFACES.md). Design decisions are recorded in
> [`docs/adr/`](./docs/adr/).
>
> **Before publishing:** confirm `npm view decant` returns not-found and the
> GitHub org/repo handle is free (fragrance brands use the name, but no software
> tool does — different trademark class, no conflict expected).

---

## 1. Goals & non-goals

**Goals**
- Intercept a file the user is about to upload to an LLM web UI.
- Convert it to clean Markdown (or pass it through unchanged when conversion
  would lose meaning).
- Hand the destination site the converted file with zero extra clicks.
- Keep documents on the user's machine by default (privacy is a feature here).

**Non-goals (v1)**
- Being yet another standalone drag-in converter — that space is saturated.
- Server-side hosting of user documents.
- Perfect table/figure fidelity on day one.
- Supporting every site. Start with *one* target's real upload mechanism.

---

## 2. Interception mechanics (Manifest V3)

The hard part isn't conversion — it's grabbing the file mid-upload on a real LLM
UI. These UIs mostly **don't** use a plain `<input type="file">`; they use
drag-and-drop zones and clipboard paste. Plan to hook all three paths.

**Events to intercept (content script):**
- `change` on `input[type=file]` — the classic picker.
- `drop` on the page's drop zone — most chat UIs.
- `paste` — files pasted from clipboard.

**The swap technique (well-documented):**
1. Capture the `File` from the event, `preventDefault()` / stop propagation.
2. Run it through the converter interface → get Markdown text.
3. Build a new `File` (e.g. `document.md`, `text/markdown`).
4. Put it into a `DataTransfer`, assign `dataTransfer.files` to the input
   (or re-dispatch a synthetic `drop`/`change` with the new file).
5. Re-dispatch `change`/`input` with `bubbles: true` so the site's React
   handlers fire.

**Naming gotcha:** if the site expects a `.pdf` and you hand it `.md`, it may
reject the file. Decide per-target: rename to `.md`/`.txt`, or only activate on
sites that accept text. Site-specificity may *be* the product.

**Fallback architecture if the swap is brittle on a given site:**
*convert-and-inject* — drop the Markdown straight into the prompt textarea, or
convert-to-clipboard. Less elegant, far more robust. Keep it in your back pocket.

**Note:** `chrome.fileBrowserHandler` sounds relevant but is **ChromeOS-only** —
not your path on desktop Chrome.

---

## 3. Configuration model

Generalized, the extension is an **intercept → route-by-type → substitute**
pipeline. Two independent, **default-off** config layers drive it: **activation**
(where it runs) and **routing** (what happens to each file type). PDF/doc →
Markdown is just the default instantiation of a generic file-transform router.

### 3.1 Activation — default-deny host/URL whitelist
- **Nothing fires on any page unless its host or URL is explicitly configured.**
  No blanket injection; silence is the default.
- Two rule granularities:
  - **host** — e.g. `claude.ai`, matches all pages on that host.
  - **url** — a pattern/glob for a specific page or path.
- **Ships with `claude.ai` enabled.** Users add others (chatgpt.com,
  gemini.google.com, …) over time.
- **MV3 mechanics (implementation note):** because the host set is user-editable,
  don't hardcode `content_scripts` match patterns in the manifest. Use
  `optional_host_permissions` and request each host as the user adds it, then
  register/unregister content scripts dynamically via
  `chrome.scripting.registerContentScripts`. Keeps the install prompt minimal and
  honors default-deny.

### 3.2 Routing — per-MIME-type transform rules
On an activated page, an intercepted file is matched against routing rules keyed
by **MIME type and/or extension**. Each rule chooses an action:
- `inbrowser` — built-in JS engine (pdf.js / mammoth.js / SheetJS).
- `companion` — POST to a configured **local** endpoint, receive transformed content.
- `http` — POST to **any** endpoint (local or remote) and substitute the returned
  result. The generalized case.
- `passthrough` — leave the file untouched. **Default for unmatched types.**

The returned content is rebuilt as a new `File` and substituted into the
input / drag-drop / paste target, with a configurable output name, extension, and
MIME type.

### 3.3 Default routing (all editable)
- `application/pdf` → **companion** (local host), output `.md`.
- Word docs (`.doc`, `.docx`) → **companion**, output `.md`.
- Everything else → **passthrough**.
- In-browser engines stay selectable per type and act as the **fallback when the
  companion is unreachable** (`onError: inbrowser` or `passthrough`).

### 3.4 The general case (any type → any endpoint)
Any MIME type can be routed to any endpoint and have the result returned to the
upload. Example: route `image/png` / `image/jpeg` to a local OCR or captioning
service and substitute the returned text into the drop zone. Per-rule fields worth
supporting: `match` (mime[], ext[]), `action`, `endpoint`, `method`/`headers`,
`request.encoding` (multipart | base64-json), `responseField` (where text lives in
the response), `output` (ext, mime, filename template), `enabled`, `onError`.

### 3.5 Storage, UX, guardrails
- Persist config in `chrome.storage.sync` (syncs across the user's Chrome; mind its
  size quotas); keep any endpoint secrets in `chrome.storage.local`.
- Options page: manage the whitelist and the routing table; JSON import/export for
  power users.
- **Privacy guardrail:** warn whenever a rule points at a **non-localhost**
  endpoint — documents leaving the machine is the "shape C" tradeoff and should be
  a conscious choice.

### 3.6 Example config (illustrative)
```jsonc
{
  "activation": {
    "default": "off",
    "rules": [
      { "type": "host", "match": "claude.ai", "enabled": true }
      // { "type": "host", "match": "chatgpt.com", "enabled": true },
      // { "type": "url",  "match": "https://example.com/upload*", "enabled": true }
    ]
  },
  "routing": {
    "default": "passthrough",
    "rules": [
      {
        "match": { "mime": ["application/pdf"] },
        "action": "companion",
        "endpoint": "http://127.0.0.1:8765/convert",
        "output": { "ext": "md", "mime": "text/markdown" },
        "onError": "inbrowser"
      },
      {
        "match": {
          "mime": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
          "ext": ["doc", "docx"]
        },
        "action": "companion",
        "endpoint": "http://127.0.0.1:8765/convert",
        "output": { "ext": "md", "mime": "text/markdown" },
        "onError": "inbrowser"
      },
      {
        "match": { "mime": ["image/png", "image/jpeg"] },
        "action": "http",
        "endpoint": "http://127.0.0.1:8765/ocr",
        "request": { "encoding": "multipart" },
        "responseField": "text",
        "output": { "ext": "md", "mime": "text/markdown" },
        "enabled": false,
        "onError": "passthrough"
      }
    ]
  }
}
```

### 3.7 Manual overrides — browser realization (planned)
Manual override of the conversion decision is a **cross-surface requirement**;
the principle and the two mandatory capabilities (override an ambiguous result,
force passthrough) live in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (Handling the image layer). This
section covers only how the **browser surface** realizes them:

- **Per-file Convert / Send-original toggle.** When an upload is classified as
  *ambiguous*, Decant surfaces the choice in the composer instead of guessing —
  also the manual escape hatch when detection misjudges a clear case.
- **Passthrough hotkey.** A **configurable keyboard shortcut** that arms a
  one-shot "send the next upload untouched" state. Pressed before attaching a
  file, it guarantees the original is uploaded with no conversion, regardless of
  how the file would otherwise be classified. The binding is user-configurable
  and stored with the rest of the config; the armed state is transient: consumed
  by the next intercepted upload, or cleared on a timeout / Escape. A visible
  indicator should show when it is armed so the bypass is never silent.

---

## 4. MVP scope (prove the risky part first)

The risk is interception, not conversion. So the first milestone deliberately uses
a dumb converter and a single site:

**Milestone 0 — "Hello, swap"**
- Pick ONE target site (`claude.ai`). Inspect its actual upload mechanism in DevTools.
- Stand up the default-deny activation check with `claude.ai` whitelisted, so the
  content script only runs there.
- Intercept the upload, replace the file with a hardcoded `.md` ("it worked").
- Confirm the site accepts and displays it. *This validates the whole premise.*

**Milestone 1 — Real conversion, in-browser (shape A)**
- pdf.js text extraction → basic Markdown.
- Text-layer detection → pass-through for image-only PDFs.
- Per-file Convert / Send-original toggle.

**Milestone 2 — Quality tier (shape B)**
- `localhost` Python service (MarkItDown or Docling) behind the same interface.
- Setting to choose engine; graceful fallback to A if the service is down.

**Milestone 3 — Polish**
- DOCX/PPTX/XLSX support (mammoth.js / SheetJS), figure handling settings,
  multi-site support, token-savings estimate display.
- Full config UX: options page for the activation whitelist + routing table,
  dynamic host-permission requests, JSON import/export, non-localhost warnings.

---

## 5. Suggested repo structure

```
decant/
├── SPEC.md                  ← this file (browser surface)
├── docs/
│   ├── ARCHITECTURE.md      ← surface-agnostic core
│   ├── SURFACES.md          ← surfaces & expansion strategy
│   └── adr/                 ← architecture decision records
├── manifest.json            ← MV3
├── src/
│   ├── content/
│   │   ├── intercept.js     ← change/drop/paste hooks + DataTransfer swap
│   │   └── site-adapters/   ← per-site quirks (selectors, accepted types)
│   ├── config/
│   │   ├── defaults.json    ← default activation whitelist + routing table
│   │   └── schema.js        ← config validation / migration
│   ├── router/
│   │   └── route.js         ← match file → action (inbrowser|companion|http|passthrough)
│   ├── convert/
│   │   ├── index.js         ← converter interface (engine-agnostic)
│   │   ├── inbrowser.js     ← shape A (pdf.js)
│   │   └── companion.js     ← shape B (fetch localhost)
│   ├── background.js        ← service worker
│   └── options/             ← settings UI
├── companion/               ← optional Python service (MarkItDown/Docling)
│   ├── server.py
│   └── requirements.txt
└── README.md
```

---

## 6. Open questions / risks

- **Per-site fragility.** Chat UIs change their DOM often; site-adapters will need
  maintenance. Convert-and-inject fallback hedges this.
- **Accepted file types.** Some uploaders validate extension/MIME and reject `.md`.
  Test the target before assuming the swap lands.
- **Async timing.** Conversion is async; the UI may try to upload before it
  finishes. You may need to block/queue the original event and resume after.
- **Scanned/visual docs.** Get the pass-through detection right or you'll quietly
  make answers worse. This is the reputational risk.
- **Marker licensing** if commercial. MarkItDown/Docling (MIT) are safer defaults.
- **Dynamic host permissions** (new-to-extensions curve). Default-deny plus
  user-added hosts means runtime permission requests + dynamic content-script
  registration, not static manifest matches. Slightly more moving parts, but it's
  what keeps the install prompt honest.
- **Token-savings claim.** True for PDFs; modest for other formats. Don't oversell
  in the store listing.

---

## 7. Sources to revisit

- Anthropic PDF support docs (token model: text + per-page image).
- MarkItDown (Microsoft, MIT), Docling (IBM), PyMuPDF4LLM, Marker, MinerU repos.
- MDN: `DataTransfer`, `File`, drag-and-drop and paste event handling.
- Chrome Manifest V3 content-script + service-worker docs.

---

*First action when you open Claude Code: do Milestone 0 against one real site.
Everything else is downstream of proving the file swap actually lands.*
