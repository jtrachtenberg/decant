# ADR 0019 — MAIN-world shim for detached file pickers

- **Status:** Accepted
- **Date:** 2026-07-17

## Context

All interception rode three isolated-world listeners bound to `window` in the
capture phase (change/drop/paste). That model requires the upload event to
*reach* window. On www.kimi.com the picker never does: the site's paperclip
runs `document.createElement("input")`, sets `type = "file"`, binds
`onchange`, calls `.click()`, and never appends the input to the DOM. A
disconnected node has no ancestor chain, so its change event fires on the
element alone — the extension logs "intercept installed" and then sees
nothing while the original PDF uploads unconverted. Confirmed live with a
main-world probe: the pick's change fired with `isConnected === false`, and
`showOpenFilePicker` was never called.

No isolated-world listener placement can fix this — the event has no
propagation path. The hook has to exist where the input is *created*, in the
page's own JavaScript world.

## Decision

A second registered content script, `content/main-world.js`, with
`world: "MAIN"` at `document_start` (same matches as the primary — the shim
is generic, not a kimi adapter). It patches `Document.prototype.createElement`
to bind a capture change listener on every `<input>` it returns. Binding at
creation makes the shim unconditionally first in the element's listener list
— the page can only attach handlers after createElement returns — so
`stopImmediatePropagation()` blocks every page handler, `.onchange` included.
The prototype (not the instance) is patched so
`Document.prototype.createElement.call(document, …)` idioms hit it too.

The pipeline stays in the isolated world; the shim only relays, over a
`window.postMessage` bridge with a shared protocol module (`bridge.js`):

- **PICK** (main → isolated): a trusted change fired on a *detached* file
  input; the shim blocked the page's handlers and holds the input under an id.
- **INJECT** (isolated → main): the converted files; the shim substitutes them
  into that same input and re-dispatches change, so the site's own handler
  finally runs and reads Markdown.
- **RELEASE** (isolated → main): re-dispatch with the originals untouched —
  the passthrough hotkey's path, and the failure fallback (`queueInject`'s
  catch now RELEASEs, so a pipeline bug degrades to a native upload, never a
  swallowed one).
- **READY** (isolated → main): posted at pipeline startup; until it arrives
  the shim lets picks flow natively. A missing pipeline must mean "no
  conversion", not lost uploads.

Division of responsibility is strict: the shim intercepts **only** trusted
changes on **detached** inputs. Connected inputs stay entirely with the
window-capture path — when it intercepts, `stopImmediatePropagation` means
the shim's element listener never runs; when it deliberately declines
(passthrough armed), the shim's `isConnected` guard stands aside too.
`isTrusted` doubles as the cross-world sentinel: expando properties on events
don't cross worlds, but our synthetic re-dispatches are untrusted by
construction, so neither world can re-intercept the other's injections.

`resolveAndInject`/`queueInject` were generalized to take an injector
callback — `injectViaInput` for the DOM paths, a bridge post for this one —
so the conversion pipeline is shared unchanged, prompts and savings badge
included.

The shim's registration is guarded separately in the background worker:
Firefox < 128 rejects `world: "MAIN"`, and an enhancement's registration
failure must never take down primary interception (it degrades to the
pre-shim status quo).

## Trust model

The bridge is page-visible and page-forgeable by design. Every payload is a
file the page already holds — a pick the page initiated, or a conversion of
one — so a forged message can only make Decant convert the page's own data
and hand it back. Receivers still require `source === window` and
`origin === location.origin` and hard-validate shape (`bridgeFiles` keeps
only real `File` instances). The isolated world grants bridge messages no
authority beyond running the ordinary conversion pipeline.

## Consequences

- kimi.com's picker path converts. Verified headless end-to-end (Edge 150 +
  fake detached-picker page): pick → shim → bridge → convert → the site's own
  `onchange` reads `test.md`; connected-input regression clean; passthrough
  hotkey delivers the original through the bridge.
- The shim is inert on sites using connected inputs (guard order:
  trusted → file → detached → ready), so shipping it on all enabled hosts
  adds one no-op listener per created input and nothing else.
- `Document.prototype.createElement` is detectably patched on enabled hosts
  (`toString` no longer native). Password managers do the same; accepted, and
  QA should watch anti-bot-heavy sites for breakage.
- Residuals, accepted until QA meets one: inputs minted without
  createElement (innerHTML, cloneNode, createElementNS) aren't hooked; a page
  reading `.files` outside a change handler (dialog-close polling) bypasses
  the block; `showOpenFilePicker()` pickers remain invisible — that's a
  different, harder hook (promise-wrapped file handles), deliberately out of
  scope until a real site needs it. No per-site opt-out flag yet
  (`interceptDetached: false` would be a three-line adapter addition when a
  site needs it).
- Firefox: registration is attempted and tolerated on failure; FF ≥ 128
  supports MAIN-world registration but its document_start timing for
  main-world scripts needs its own QA pass before the port claims the
  feature.
