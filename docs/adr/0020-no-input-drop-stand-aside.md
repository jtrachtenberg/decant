# ADR 0020 — Drop/paste stand aside when no injection channel exists

- **Status:** Accepted
- **Date:** 2026-07-17

## Context

Drop and paste interception substitutes the converted file by assigning a
connected `<input type=file>`'s `.files` and dispatching change
(`injectViaInput`). On a detached-picker site (ADR 0019 — kimi.com) no such
input ever exists: the composer creates one per pick, detached, and the
bridge substitutes through *that* input — but a drop has no pick, so there is
no input at all. Live QA showed the consequence: a drop on kimi was
intercepted, converted, prompted — then `injectViaInput` found nothing to
inject through and the upload died with the attach-failure notice. Decant
blocked the site's own (working) drop handling and delivered nothing.

The Gemini adapter already encodes the principle for a site whose drops can't
be substituted: step aside (`interceptDrop: false`) and let the native upload
proceed. But that's static per-site config, and this failure class is
generic — every detached-picker site will hit it.

## Decision

Decide dynamically, at event time: the drop and paste handlers check
`findUsableFileInput()` before intercepting, and when the page has no usable
connected file input they stand aside — consume any armed passthrough state
(native upload *is* the passthrough) and let the native event proceed with
the original file. "Original sent unconverted" strictly beats "upload lost
after a convert prompt".

The check runs at drop time while injection runs seconds later; a site that
mounts its input only in reaction to some later interaction would be
misjudged. Accepted: every known full-treatment site (claude.ai, ChatGPT,
Copilot, Perplexity) keeps a hidden input mounted, and the miss degrades to a
native upload, never a lost one. The Gemini adapter stays — its reasons are
site-observed (uploader rejects synthetic events), not inferable from DOM
state, and consolidating would mean re-QA for no behavior change.

## Consequences

- kimi.com: picker converts (ADR 0019 bridge); drag-and-drop and paste send
  the original natively with a console line naming why. No more dead-end
  prompt → notice → nothing.
- Verified headless (Edge 150, CDP `Input.dispatchDragEvent` for trusted
  drops): with a connected input present the drop still intercepts and
  converts (guard ordering regression); with none, the site's own window-level
  drop handler receives the original and no failure notice fires.
- Full DnD conversion on detached-picker sites has a known future path if
  demanded: a per-site adapter naming the paperclip control, with the shim
  suppressing the dialog-opening `.click()` and substituting directly —
  deliberately not built until a real need shows up.
