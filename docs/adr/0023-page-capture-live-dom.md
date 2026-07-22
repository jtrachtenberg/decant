# ADR 0023 — Page capture: live DOM → last-used LLM (M5a)

- **Status:** Accepted
- **Date:** 2026-07-21

## Context

ADR 0022 planned M5 as **pasted-URL interception**: a URL pasted into an
activated composer is fetched and converted. It deferred the higher-fidelity
tier — reading an **already-open tab's live rendered DOM** — because it seemed
to "need a `tabs`-permission design," and a broad `tabs` grant sat badly with
our narrow-permission posture.

That blocker dissolves on inspection, and the tiers invert:

1. **`activeTab` is the permission design.** When the user invokes the
   extension on a page — toolbar click, context-menu item, or keyboard
   shortcut — Chrome grants temporary host access to that tab. No wildcard, no
   per-origin `permissions.request` prompt, no `tabs` permission. The gesture
   *is* the consent, which is a strictly better story than the pasted-URL
   tier's just-in-time grant dance — and it makes the flow genuinely
   automatic: ADR 0022 needed an ask-first prompt because a pasted URL is
   ambiguous (maybe the user wants the model to hold the link); "Decant this
   page" is not.
2. **Finding the destination needs no new permission either.** URL-pattern
   `tabs.query` works under host permissions, and we already hold them for
   every activated LLM host (manifest + ADR 0003 dynamic grants). Verified
   empirically (below): open LLM tabs enumerate with `url` populated, and
   `Tab.lastAccessed` (Chrome 121+, Firefox long since) gives "most recently
   focused" directly.
3. **The live DOM is the better input.** A static re-fetch loses exactly the
   pages worth capturing — SPAs, auth-gated docs, anything rendered
   client-side. Reading the rendered DOM is what the namesake competitor
   actually does, manually; we do it with the destination handoff attached.

So M5 leads with capture (M5a); pasted-URL interception demotes to the
follow-on tier (M5b — ADR 0022 stands, mechanics unchanged, its main
non-redundant case being a page the user *hasn't* opened).

## Decision

Add **page capture** as a fifth interception surface running in the reverse
direction: it starts on an arbitrary page (where no content script lives — one
is injected on demand under `activeTab`) and ends in an activated LLM tab
(where our content script already runs).

- **Triggers.** Toolbar click = capture → last-used LLM (the automatic path).
  A context-menu entry with a submenu built from the enabled-sites list is the
  override picker — native UI, no custom overlay. Two `commands` shortcuts
  mirror both. All three grant `activeTab`. `action.onClicked` does not expose
  modifier keys, so the override is a distinct surface, not Alt+click.
- **Capture.** `chrome.scripting.executeScript` serializes the live DOM —
  rendered text state, resolved lazy images, open shadow roots; scripts,
  styles, and site chrome stripped — and hands HTML to the background, which
  runs the existing M2 HTML→Markdown engine (Turndown + parsers). The engine
  is reused; the serializer is new and owns output fidelity.
- **Target resolution**, in order: forced pick → open activated-LLM tab with
  max `lastAccessed` → stored last-successful-injection host (recorded at the
  savings-credit moment, which already means "files reached the composer") →
  first enabled site. Capture is disabled while the active tab *is* an
  activated LLM host (v1: no chat-to-chat sends).
- **Delivery.** Focus the target tab, or `tabs.create` it and wait for the
  content script's ready ping (plus composer-mount settling on SPA hosts);
  ship `page.md` over `tabs.sendMessage`; inject via the existing
  `injectViaInput`. Failure must be **loud** — the intercept code's
  never-silent rule applies doubly here, because the user isn't looking at the
  destination tab. On hosts with no usable file input (kimi/Gemini, ADR 0020)
  the fallback is clipboard-copy + notification — the capture analogue of
  native passthrough.
- **Figures, optional and default-off.** "Capture with figures" (second
  context-menu item + settings toggle) reuses extract-and-reference
  (ADR 0006): `<img>` elements junk-filtered by rendered size attach as
  sibling files / contact sheet, `[image omitted: alt]` markers in the `.md`.
  Cross-origin images whose bytes are unreadable (CORS-opaque) skip with the
  marker — best-effort by design in v1.

## Spike results (phase 0, empirical)

Probe extension (no `tabs` permission; host permissions for two fake LLM
hosts) in headless Edge 150, three TLS-served hosts mapped via
`--host-resolver-rules`:

- `tabs.query({url: [...]})` under host permissions only: matching tabs return
  with `url`/`title` populated; tabs on ungranted hosts appear in a blank
  query with `url`/`title` **absent** but `lastAccessed` **present** —
  `lastAccessed` is not a permission-gated field.
- `lastAccessed` ordering tracks focus changes exactly (refocusing a tab
  reordered it to the top).
- `executeScript` on a granted host reads **post-load** DOM state (a marker
  inserted by page JS after load is visible); on an ungranted host it throws
  `Cannot access contents of the page` — the permission model holds.
- Cold-tab handshake: `tabs.create` → content-script ready ping in ~20–30 ms
  on a local page (real SPA hosts will be slower; composer-mount wait is
  phase-2 work).
- `tabs.sendMessage` payload ceiling: a 32 MB string round-trips (~190 ms);
  64 MB throws `Message exceeds maximum allowed length`. Single-message
  budget is comfortable for `page.md`; figure batches must chunk or cap.
- **Not headlessly drivable:** the `activeTab` grant itself — no automation
  path clicks the toolbar or fires a global shortcut. The grant path is a
  manual-QA item; everything downstream of the grant is testable headless.

## Consequences

- Manifest gains `activeTab`, `contextMenus`, and a `commands` section — all
  low-scrutiny, but the next store submission re-enters permission review;
  batch this after 0.3.0's approval rather than racing it.
- A direction-reversed pipeline: new machinery is the serializer, target
  resolution, and the cross-tab handshake; engine, figures path, injection,
  and config are all reused.
- The failure surface moves off-screen: every delivery failure needs a
  user-visible notification on the *source* page, not a console line in a
  background tab.
- Firefox port is clean on paper (`activeTab`, `contextMenus`, `commands`,
  `lastAccessed` all supported); needs its own QA pass.
- Deferred: chat-to-chat capture, batch capture of multiple tabs, and M5b
  (pasted URLs, ADR 0022) as the follow-on tier.
