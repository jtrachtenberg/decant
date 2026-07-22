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

**A fourth path (M5b): URL paste.** A `paste`/`drop` carrying a single `http(s)`
URL rather than a file is its own interception surface — the page is fetched and
converted, not a file swapped in. Mechanics in §3.10.

**A fifth surface, reversed (M5a): page capture.** The other four intercept
content arriving *at* the composer; capture starts on the page the user is
reading — live DOM serialized under `activeTab` — and delivers the Markdown *to*
the last-used LLM's composer. Mechanics in §3.11.

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
- **Ships with `claude.ai` and `gemini.google.com` enabled** (both required
  host permissions, granted at install). Users add others (chatgpt.com, …)
  over time.
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
- **Forward escalation (`onEmpty`).** The complement of `onError`: an `inbrowser`
  rule may name a companion/http `endpoint` to try *when the browser extracts
  nothing* — a scanned/image-only PDF (classifier `no-text`) or a type with no
  in-browser engine (`no-engine`). This keeps native PDFs fast and local while
  routing only genuine scans to the companion (Docling OCR). Opt-in and endpoint-
  gated, so a browser-only user who configures neither simply passes scans
  through; a failed/empty escalation falls back to the original, never losing the
  file. (Escalation targets: `companion`, `http`.)

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
    ],
    // Per-host overrides (profiles, M4 — see §3.8). Merged over the global
    // rules per file-type key; most specific wins.
    "profiles": [
      // {
      //   "host": "chatgpt.com",
      //   "rules": [
      //     { "match": { "mime": ["application/pdf"] }, "action": "passthrough" }
      //   ]
      // }
    ]
  }
}
```

### 3.7 Manual overrides — browser realization
Manual override of the conversion decision is a **cross-surface requirement**;
the principle and the two mandatory capabilities (override an ambiguous result,
force passthrough) live in
[`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) (Handling the image layer). This
section covers only how the **browser surface** realizes them:

- **Per-file Convert / Send-original toggle.** *(Implemented.)* When an upload is
  classified as *ambiguous*, Decant surfaces the choice in the composer instead
  of guessing — also the manual escape hatch when detection misjudges a clear
  case. Ambiguity triggers on two or more image-bearing text pages, or on even
  ONE page whose image reads as a *significant figure* (figure-sized and
  pixel-bearing — ADR 0008): whether a real chart rides along is the user's
  decision, while a lone letterhead logo still converts without a prompt.
- **Passthrough hotkey.** *(Implemented; default `Alt+Shift+O`.)* A keyboard
  shortcut that arms a one-shot "send the next upload untouched" state. Pressed
  before attaching a file, it guarantees the original is uploaded with no
  conversion, regardless of how the file would otherwise be classified. The
  armed state is transient: consumed by the next intercepted upload, or cleared
  on Escape or a second press, with a visible badge while armed so the bypass is
  never silent. (An auto-disarm timeout is implemented but currently disabled.)
  Making the binding **user-configurable** (stored with the rest of the config)
  arrives with the options page (M2).

### 3.8 Profiles — per-host routing overrides (M4) — browser realization

Config layering is a **core concept**: the resolution order and the principles
(per-key merge, fail-toward-global validation, per-rule privacy warnings) live
in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) §2.1. This section covers
only how the browser surface realizes them:

- **Scope by host**, using the same `match` shape as activation rules (§3.1) —
  one matcher concept in the codebase and in the UI. URL-pattern scoping can
  layer in later without changing the model.
- **Profile rules are routing rules** (§3.2/§3.4), merged over the global
  table per file-type key. E.g. global `application/pdf → inbrowser (md)`, but
  chatgpt.com always passes PDFs through, and an internal host forwards them
  to a configured endpoint (see the `profiles` block in §3.6).
- **Resolution per intercepted file:** passthrough hotkey (§3.7) → active
  host's profile rule → global routing rule → passthrough. The per-file
  Convert / Send-original prompt is orthogonal — it fires inside whichever
  engine ends up running (ambiguous classification), not at the routing layer.
- **Storage & validation:** profiles live with the rest of the config in
  `chrome.storage.sync`; `normalizeConfig` validates their shape and discards
  a malformed profile wholesale (same lesson as the hotkey-shape validation).
- **Options page** gets a per-host profile editor; the non-localhost warning
  (§3.5) applies to each profile rule individually.
- Profiles are also where **per-site adapter settings** land as they accumulate
  (e.g. the file-input selection heuristic in `intercept.js` is
  claude.ai-calibrated today and slated to move here).

### 3.9 Chart & visual-data fidelity (planned)

Today a chart-bearing document gets an omission marker plus the ambiguous
prompt (see §3.7 / ARCHITECTURE §5). Much of that "lost" data is actually
reachable with the libraries we already load — three tiers by effort, and the
omission marker stays as the honest fallback for the residue, not a thing any
of this replaces:

- **Tier 1 — OOXML cached chart data. *(Done: PPTX, DOCX, XLSX.)***
  A native Office chart is not an image: its `chartN.xml` part holds the cached
  series (`<c:ser>` → `c:tx`/`c:cat`/`c:val`), and the engines are already
  inside the zip. The shared `chart.js` (`parseChartXml`) turns one chart part
  into a category×series Markdown table — deterministic, OCR-free, often
  *better* than the source for a model. Wiring per engine:
  - **PPTX** resolves each `graphicFrame`'s `c:chart r:id` through the slide
    `.rels`, so a recovered chart lands on its slide; a chart-only slide
    **converts** instead of prompting, and only charts we *can't* parse fall
    back to `[chart omitted]`.
  - **DOCX** — mammoth drops chart parts entirely, so `chartTablesFromZip`
    enumerates `word/charts/*` and appends the recovered tables after the body.
  - **XLSX** — same, over `xl/charts/*`. Weakest of the three: an XLSX chart
    usually plots cells already in a converted sheet, so recovery is often
    *redundant* — kept for completeness, worth revisiting if it proves noisy.
  Deferred refinement: a `[chart data from embedded cache]` staleness footnote
  (skipped for now — per-chart noise). (Cell-shading annotation via
  `w:shd`/`a:solidFill` is a lower-ranked, legend-dependent cousin — noise-
  prone, treat separately.)
- **Tier 2 — PDF geometry confidence signal. *(Done.)*** `columnConvergence`
  (`classify.js`) scores how cleanly a page's text settles onto recurring
  columns: a real column — a prose margin, a table column, either side of a
  two-column page — is a start-x band many rows share, while chart-label soup
  scatters across many single-hit bands. Scoring by band *support* (not a
  top-K-bands count, which mistakes multi-column for scattered) is what lets a
  clean two-column page and a table both score ~1 while soup scores near 0.
  Below `CONVERGENCE_FLAG_THRESHOLD` (0.5, calibrated on a WHO statistics
  report — confirmed soup ≤0.49, clean prose/tables ≥0.95) `reconstructPage`
  prepends a flattened-figure marker. It fills the gap the column-split table
  marker leaves: single-region label scatter, rotated tables, and bar/dumbbell
  charts whose values were never text and never form a detectable table.
  Detection and the honest marker come from one computation.
  Two hard signals cover the silent-corruption gap convergence can't see
  (WHO p17: a corrupt chart table on a page that scored above threshold):
  **C0 control characters** in any table's cells (a font with no usable
  ToUnicode map makes pdf.js emit raw glyph codes — provable corruption)
  replace that table with `[chart table omitted — unreliable extraction; see
  attached figure, document page N]`, pointing at the figure the extract-and-
  reference flow attaches, N in the document's printed page labels; and
  **floating text boxes** outside a grid's column bands (chart legends, axis
  labels) are excluded from grid row merging so they can't shred
  fragment-by-fragment into data rows.
- **Tier 3 — PDF vector reconstruction (recorded, likely deferred to the
  companion).** `getOperatorList()` exposes filled rects + fills, so traffic-
  light tables / bar charts are *theoretically* recoverable by overlaying text
  coords on rect bounds and matching fills to legend swatches. But at that
  geometry-reconstruction complexity the M3 Python companion (Docling) does it
  more robustly — same verdict as Tesseract (§ M3): high payoff on specific
  cases, low generality, high maintenance. Raster-image charts and choropleth
  maps stay OCR/companion territory regardless.

### 3.10 Web-page interception — pasted URLs → Markdown (M5b)

The same-named page→AI extractor does manually what our pipeline does
automatically: turn a web page into clean Markdown for the model. We close that
gap as a **fourth interception surface** — a URL pasted or dropped into the
composer — routed through the machinery §3.2–§3.7 already provide. Full
rationale and competitive context in [ADR 0022](./docs/adr/0022-web-page-interception.md).

- **Trigger.** A `paste`/`drop` whose payload is a *single* `http(s)` URL (not a
  file, not prose with a link in it) on an activated host. Multiple URLs (batch)
  and URLs mid-sentence are out of v1 scope — the user is attaching a page, not
  writing.
- **Input to the router.** The URL is a new input type the router dispatches by
  the existing actions:
  - `inbrowser` — fetch the page, run the HTML→Markdown engine already shipped
    in M2 (Turndown + parsers). Default.
  - `companion` / `http` — POST the URL; the endpoint fetches and converts
    (MarkItDown accepts a URL). `onEmpty` escalation (§3.3) sends a page the thin
    in-browser fetch can't read (JS-rendered, empty extract) to the companion,
    which can render it; native articles stay fast and local.
  - `passthrough` — leave the URL text in the composer untouched. Default when
    unmatched, and the analogue of file passthrough.
- **Ask-first choice.** The composer prompt grammar of the ambiguous file case
  (§3.7): *Attach as Markdown* / *Convert + attach figures* / *Keep the link*,
  with a **set-as-default** toggle (ADR 0008) so "automatic" is a one-time
  opt-in, never a silent swap.
- **Substitution.** The converted page is rebuilt as a `page.md` `File` and
  injected via `injectViaInput` (§2). Where no usable input exists (kimi/Gemini,
  ADR 0020) or the user keeps the link, the URL text stays in the composer — no
  loss.
- **Figures as a separate document.** *Convert + attach figures* reuses
  extract-and-reference (ADR 0006): the page's content images, size-filtered to
  skip icons/sprites/tracking pixels, attach as sibling files and overflow to a
  labeled contact sheet; `[image omitted: alt-text]` markers anchor them in the
  `.md`. HTML images are already separate resources, so this is the PPTX/DOCX
  media path with no mini-PDF step.
- **Permissions — no wildcard.** `inbrowser` URL conversion requests the **host
  permission for that origin, just-in-time**, on first conversion there — the
  activation-host pattern (§3.1, ADR 0003): `chrome.permissions.request` +
  dynamic registration. The narrow manifest stays narrow; a companion-routed
  user grants no extra browser host access. Fetching a page is a network request
  to it, so the options page states that conversion fetches the pasted URL.
- **Classifier.** The three-way verdict (§3.7) maps onto a page: text-heavy →
  convert; thin/gallery → passthrough; text+figures → ambiguous with the figures
  choice.

Reading an **already-open tab's live rendered DOM** was deferred here as
"needs a `tabs`-permission design"; it turned out to need no such design and
became the M5 headline — §3.11. Batch multi-URL conversion stays deferred.

### 3.11 Page capture — live DOM → last-used LLM (M5a)

The reverse-direction surface: instead of intercepting an upload, capture the
page the user is reading and hand it to the chat they last used. Rationale,
permission analysis, and phase-0 spike results in
[ADR 0023](./docs/adr/0023-page-capture-live-dom.md).

- **Triggers.** Toolbar click = capture → last-used LLM. A context-menu entry
  with a submenu of the enabled-sites list is the override picker; one
  `commands` shortcut (`Alt+Shift+C`, rebindable at chrome://extensions/
  shortcuts) mirrors the automatic path — a second picker shortcut was
  planned, but the picker UI *is* the context menu, so a keyboard route to it
  would need a separate picker surface; deferred until someone wants it.
  Every trigger is a user gesture granting `activeTab` — temporary host
  access to the captured tab, no wildcard, no per-origin prompt, no `tabs`
  permission. The gesture is the consent, so there is no ask-first step
  (unlike a pasted URL, the intent is unambiguous).
- **Capture.** `chrome.scripting.executeScript` injects a serializer into the
  page (no resident content script off the activation list): rendered text
  state, resolved lazy images, open shadow roots; scripts/styles/site chrome
  stripped. The background runs the resulting HTML through the M2
  HTML→Markdown engine — the serializer is the only new conversion code.
- **Target resolution**, in order: forced pick → open activated-LLM tab with
  max `lastAccessed` (URL-pattern `tabs.query` works under the host
  permissions we already hold; `lastAccessed` is Chrome 121+/Firefox and not
  permission-gated — both spike-verified) → stored last-successful-injection
  host (recorded at the savings-credit moment) → first eligible site. All
  tiers rank over enabled ∩ **granted** hosts only: the content script exists
  only where the grant does, so an enabled-but-ungranted host can never answer
  a delivery and must not be a candidate (its tab can even be query-visible
  through a stray `activeTab` grant — live-QA'd). Explicitly picking an
  ungranted host fails fast, naming the re-enable remedy. Capture is disabled
  when the active tab is itself an activated LLM host (v1).
- **Delivery.** Focus or create the target tab; on cold tabs wait for the
  content-script ready ping plus composer mount; ship `page.md` over
  `tabs.sendMessage` (spike: 32 MB fits one message, 64 MB does not — chunk or
  cap figure batches); inject via `injectViaInput` (§2). The source page
  narrates progress from the gesture on ("capturing…" → "sending to X…" →
  outcome) — the handshake and input waits are seconds long, and a silent
  gap reads as a failed click. Failures notify on the **source** page —
  never-silent applies doubly when the failure happens in a tab the user
  isn't watching. Hosts with no usable input (kimi/Gemini,
  ADR 0020) get clipboard-copy + notification as the passthrough analogue.
- **Figures, default-on.** One toggle (`capture.figures` — an options-page
  checkbox and one at the end of the capture menu, kept in step through the
  config-change event; on by default since a captured page's images are
  usually part of its meaning, and unreadable ones degrade to URL references
  harmlessly) reuses extract-and-reference (ADR 0006): `<img>`s
  filtered by *rendered* significance (≥120×90 on screen, outside site
  furniture, visible), deduped, largest-first, capped at 5 figures / 8 MB
  total, attached after `page.md` with an association footer naming them.
  Collection runs inside the captured page — that's where rendered sizes and
  session cookies live. A cross-origin image whose host sends no CORS headers
  renders but can't be *read*; it's skipped, the footer says so, and its
  absolute URL stays in the Markdown (best-effort v1). An image that never
  loaded is a broken placeholder, not a figure.

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

**Milestone 2 — Polish & config**
- Full config UX: options page for the activation whitelist + routing table,
  dynamic host-permission requests, JSON import/export, non-localhost warnings.
- DOCX/PPTX/XLSX support (mammoth.js / SheetJS), figure handling settings,
  multi-site support, token-savings estimate display.

**Milestone 3 — Quality tier (shape B) & the image layer**
- `localhost` Python service (MarkItDown or Docling) behind the same interface.
  (Describe-in-text figure descriptions — ARCHITECTURE §5 strategy 2 — were
  descoped to a post-M3 nice-to-have: extract-and-reference ships the figures
  themselves to the destination model, which describes them better than a
  local VLM would, so inline captions only pay off for vision-less backends
  or hard token budgets.)
- Setting to choose engine; graceful fallback to A if the service is down.
- **Extract-and-reference for chat surfaces** (ARCHITECTURE §5 strategy 1):
  injection already delivers a FileList, so attach the converted `.md` plus
  the document's actual figures as sibling files. PPTX/DOCX first (images are
  zip entries, extraction is free via jszip); PDF via the chart-pages
  mini-PDF, upgraded per page: a page whose figure IS a single embedded
  raster gets its XObject decoded at native resolution (`raster-gate.js`
  decides, biased hard toward the render-crop path — a false positive would
  silently drop vector chart content, §6). Needs junk filtering (logos,
  backgrounds), per-site attachment-count limits, and probably lands as a
  third ambiguous-prompt choice: Convert + attach figures.
- **Evaluated and shelved: Tesseract.js (in-browser WASM OCR).** Feasible,
  but each job it could take is done better by something else: scanned PDFs
  pass through to the destination model, whose vision beats classical OCR on
  exactly the fragile documents (converting them locally would trade fidelity
  for tokens — the §6 "quietly make answers worse" risk); and dropped
  charts/figures need *description* (a vision model, i.e. this milestone's
  companion), not character extraction — OCR'ing a bar chart yields label
  soup. Add only if demand appears for an explicit opt-in `inbrowser-ocr`
  routing action (tokens-over-fidelity users, or vision-less chat backends);
  costs ~10–15 MB of WASM/language data and seconds per page.

**Milestone 4 — Profiles (per-host overrides)**
- Per-host overlay on the routing table (§3.8): global policy stays, individual
  hosts diverge — always passthrough on one site, forward a type to a specific
  endpoint on another.
- Options-page profile editor; `normalizeConfig` validation with wholesale
  fallback to global routing on malformed profiles.

**Milestone 5 — Web-page capture and interception**
- **M5a — page capture (§3.11, ADR 0023), the headline.** Capture the live DOM
  of the page being read under `activeTab` and deliver it as `page.md` to the
  last-used LLM tab — toolbar click / context-menu picker / shortcuts, target
  resolved by open-tab `lastAccessed` with a stored fallback, existing
  HTML engine and `injectViaInput` reused. Figures optional via
  extract-and-reference (ADR 0006).
- **M5b — pasted URLs (§3.10, ADR 0022), follow-on tier.** A single `http(s)`
  URL pasted/dropped into the composer converts via the router, ask-first with
  a set-as-default opt-in; just-in-time per-origin host permission; companion
  `onEmpty` escalation for JS-rendered pages. Main non-redundant case once M5a
  ships: a page the user hasn't opened.
- Deferred: batch (multi-URL / multi-tab) capture, chat-to-chat capture.

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
