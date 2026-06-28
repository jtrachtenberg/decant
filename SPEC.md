# Decant — Project Spec

**Decant — convert files to Markdown before they upload.**

A Chrome extension that intercepts file uploads to LLM chat UIs and swaps the
original file (PDF/DOCX/etc.) for a clean Markdown version *before* it reaches
the server — so the model spends tokens on content, not on rendering page images.
The name is the metaphor: pour the document into a lighter, cleaner vessel and
leave the heavy sediment (the image layer) behind. PDF/doc → Markdown is the
default; under the hood it's a general intercept → transform → substitute pipeline.

> Drop this file into the repo root as `SPEC.md`. It's written to brief Claude
> Code (or any collaborator) on the *why* and the *shape* before any code exists.
>
> **Before publishing:** confirm `npm view decant` returns not-found and the
> GitHub org/repo handle is free (fragrance brands use the name, but no software
> tool does — different trademark class, no conflict expected).

---

## 1. The problem this solves

When you upload a PDF to an LLM, you don't just pay for the text. The system
renders **every page as an image** and sends that alongside the extracted text,
so you're billed twice per page. Per Anthropic's own PDF-support docs, text alone
runs ~1,500–3,000 tokens/page, *plus* image tokens because each page is converted
to an image. A 100-page PDF whose actual text is ~30k tokens can land at
70k–100k tokens once image tokens are counted.

The fix is not "stop the model from converting" — it's **strip the expensive
image-rendering layer up front** by handing the model Markdown/text. Reported
savings range from "more than half" to 90%+, concentrated on PDFs (DOCX/PPTX/XLSX
have overhead too, but far less dramatic).

**The non-obvious tradeoff:** the image layer isn't pure waste. It's what lets the
model read charts, scanned pages, complex tables, handwriting. Blind conversion
silently degrades visually-heavy documents. So conversion must be *smart or
optional*, never unconditional. This single constraint drives most of the design.

---

## 2. Goals & non-goals

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

## 3. The architecture fork (decide this first)

The good image-aware converters are **Python** and several need ML models/GPU.
A Chrome extension is **JS in a sandbox** — it cannot run Docling/MarkItDown
in-process. So pick a shape:

| Shape | Quality | Privacy | User setup | Verdict |
|---|---|---|---|---|
| **A. Pure in-browser** (pdf.js + JS converter) | Text-only, weak tables/figures | Full | None | **MVP** |
| **B. Local companion** (extension → `localhost` Python service) | High (Docling/MarkItDown) | Full | Run a helper | **Quality tier** |
| **C. Hosted API** (LlamaParse / Mistral OCR) | Highest | Docs leave machine | API key | Optional, undercuts the "save money" motive |

**Recommendation:** Ship **A** to prove interception works end-to-end, but design
the conversion call as a swappable interface so **B** drops in as a "high-fidelity"
toggle without touching the interception layer. Treat C as a later opt-in.

```
[content script: intercept] → [converter interface] → [swap file back in]
                                      │
                        ┌─────────────┼──────────────┐
                     A: in-browser  B: localhost   C: hosted API
```

---

## 4. Handling the image layer

Two strategies, exposed as a user setting:

1. **Extract-and-reference** — pull real figures out as image files, embed them
   in the Markdown (`![](fig1.png)`). Model sees pixels only for figures that
   matter, not full-page renders. Moderate token cost.
2. **Describe-in-text (figure annotation)** — a vision model writes a textual
   caption per figure, inlined as plain text. Zero downstream image tokens.
   Lossy (you trust the converter's VLM), maximally cheap.

**Smart default:** detect whether a PDF has a real text layer.
- Clean digital PDF → convert freely (extract-and-reference for figures).
- Image-only / scanned / chart-heavy → either run OCR, or **pass through
  unchanged** and let the original images reach the model. Never silently drop
  visual content.

A per-file toggle in the UI ("Convert" vs "Send original") is the honest fallback
for anything ambiguous.

---

## 5. Converter library landscape (public, mostly open-source)

| Library | Lang | Images | Tables | OCR | License | Notes |
|---|---|---|---|---|---|---|
| **PyMuPDF4LLM** | Py | Extract | Good | Auto | (PyMuPDF) | Fast, light, great MVP for shape B |
| **MarkItDown** (MS) | Py | Describe (LLM Vision) | Good | Optional | MIT | 15+ formats, MCP server, no GPU |
| **Docling** (IBM) | Py | Classify + LLM-annotate | Excellent | Yes | MIT-ish | Best structure; "describe-in-text" out of the box |
| **Marker** | Py | Extract (+`--use_llm`) | Excellent | Yes | GPL/commercial caveat | Swiss-army; check license for any commercial use |
| **MinerU** | Py | Partial | Very good | Yes | Open | CJK/academic specialist |
| **LlamaParse / Mistral OCR** | Hosted | Strong | Strong | Yes | Commercial | Shape C only |
| **pdf.js** (Mozilla) | **JS** | Manual | Weak | No | Apache | The realistic in-browser engine for shape A |

**For B's first cut:** MarkItDown (MIT, no GPU, dead-simple `pip install`) or
PyMuPDF4LLM. **For best fidelity:** Docling. **Mind Marker's license** if this
ever goes commercial.

---

## 6. Interception mechanics (Manifest V3)

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

## 7. Configuration model

Generalized, the extension is an **intercept → route-by-type → substitute**
pipeline. Two independent, **default-off** config layers drive it: **activation**
(where it runs) and **routing** (what happens to each file type). PDF/doc →
Markdown is just the default instantiation of a generic file-transform router.

### 7.1 Activation — default-deny host/URL whitelist
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

### 7.2 Routing — per-MIME-type transform rules
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

### 7.3 Default routing (all editable)
- `application/pdf` → **companion** (local host), output `.md`.
- Word docs (`.doc`, `.docx`) → **companion**, output `.md`.
- Everything else → **passthrough**.
- In-browser engines stay selectable per type and act as the **fallback when the
  companion is unreachable** (`onError: inbrowser` or `passthrough`).

### 7.4 The general case (any type → any endpoint)
Any MIME type can be routed to any endpoint and have the result returned to the
upload. Example: route `image/png` / `image/jpeg` to a local OCR or captioning
service and substitute the returned text into the drop zone. Per-rule fields worth
supporting: `match` (mime[], ext[]), `action`, `endpoint`, `method`/`headers`,
`request.encoding` (multipart | base64-json), `responseField` (where text lives in
the response), `output` (ext, mime, filename template), `enabled`, `onError`.

### 7.5 Storage, UX, guardrails
- Persist config in `chrome.storage.sync` (syncs across the user's Chrome; mind its
  size quotas); keep any endpoint secrets in `chrome.storage.local`.
- Options page: manage the whitelist and the routing table; JSON import/export for
  power users.
- **Privacy guardrail:** warn whenever a rule points at a **non-localhost**
  endpoint — documents leaving the machine is the "shape C" tradeoff and should be
  a conscious choice.

### 7.6 Example config (illustrative)
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

---

## 8. MVP scope (prove the risky part first)

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

## 9. Suggested repo structure

```
decant/
├── SPEC.md                  ← this file
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

## 10. Licensing & dependency boundaries

> Not legal advice — a map of the decision, to be sanity-checked before release.

**Chosen license: PolyForm Noncommercial 1.0.0** (`LICENSE` file in repo root).
Anyone may use, modify, and redistribute for any **non-commercial** purpose;
commercial use by others is not granted. Lawyer-drafted specifically for software,
plain-language, and the current go-to for "free for non-commercial."

**Know what this means:** the project is **source-available, not "open source."**
Both the OSI definition and the FSF forbid non-commercial restrictions, so this
can't be called open source, won't be OSI-approved, and some registries / corporate
users / "free for OSS" service tiers won't apply. That's a fine, deliberate
tradeoff — just don't mislabel it.

**Donations are unaffected.** GitHub Sponsors / Ko-fi / Buy Me a Coffee are
independent of the code license; accepting them is not "selling the software."

**Sole-author rights:** if you own all the copyright, the public license restricts
*others*, not you. You can publish under PolyForm Noncommercial and still privately
sell a commercial license to any business that asks.

**Alternatives considered:**
- *CC BY-NC 4.0* — recognizable "NC," but Creative Commons advises against CC for
  software (no source/binary, linking, or patent handling). Skip for code.
- *Prosperity Public License* — use only if the goal shifts to "free for
  non-commercial, **paid** for commercial" (30-day commercial trial, then license).

**Dependency license boundary (important):**
- Permissive deps bundle fine — pdf.js (Apache-2.0), mammoth.js (BSD),
  SheetJS community (Apache-2.0). Preserve their notices.
- **Marker is GPL-ish.** You **cannot** add a "no commercial use" restriction on
  top of GPL code you bundle or link — GPL forbids extra restrictions and requires
  the combined work to permit commercial use. Keep Marker **behind the local-server
  process boundary** and call it over HTTP only; arm's-length IPC with a separate
  GPL process is generally aggregation, not a derivative work, so it doesn't reach
  back into the extension.
- **MarkItDown and Docling are MIT** — no such issue. Prefer them as the default
  companion engine; treat Marker as an optional, isolated extra.

---

## 11. Open questions / risks

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

## 12. Sources to revisit

- Anthropic PDF support docs (token model: text + per-page image).
- MarkItDown (Microsoft, MIT), Docling (IBM), PyMuPDF4LLM, Marker, MinerU repos.
- MDN: `DataTransfer`, `File`, drag-and-drop and paste event handling.
- Chrome Manifest V3 content-script + service-worker docs.

---

*First action when you open Claude Code: do Milestone 0 against one real site.
Everything else is downstream of proving the file swap actually lands.*
