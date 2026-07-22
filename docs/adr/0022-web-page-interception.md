# ADR 0022 — Web-page interception: pasted URLs converted in the composer

- **Status:** Accepted
- **Date:** 2026-07-22

## Context

Three other Chrome-store products now ship under the name "Decant": a general
page→AI extractor (clean Markdown to Claude/ChatGPT/Gemini, live since March),
an Excel-only converter, and a website-only MCP bridge. None has broken out; the
Chrome Web Store does not enforce unique display names; and our file-upload
interception predates and out-reaches all of them (a broad document set —
PDF/DOCX/XLSX/PPTX/HTML — converted *in place*, never a copy-paste). So we keep
the name and differentiate on capability rather than rename.

Differentiating means closing the one real gap the closest namesake exposes.
What it does — turn a web page into clean Markdown and hand it to the model — is
something our surface can't yet do: we convert *files* a user uploads, but a
user reading a page still copy-pastes it into the chat by hand. Their flow is
manual by construction: click Extract → copy → open a chat tab → paste. Our
`intercept → route → transform → substitute` pipeline already does the
automatic, in-composer version for files. Extending it to a pasted URL is one
new interception surface, not a new product — and it beats the manual flow by
definition: no tab, no paste step, done inside the conversation you're already
in.

Two constraints shape it:

1. **Fetching an arbitrary page means read access to arbitrary hosts** — exactly
   the `*://*/*` wildcard we deliberately dropped when narrowing host
   permissions. A blanket grant is off the table.
2. **Silently replacing a pasted URL surprises users** who paste a link
   *because* they want the model to hold (or itself fetch) the link, and clashes
   with our default-off, ask-first grammar.

## Decision

Add **URL paste** as a fourth interception path, beside the picker/drop/paste
paths that carry files. When a single `http(s)` URL is pasted or dropped into an
activated composer, Decant treats the page as an input to the existing router
and offers to substitute clean Markdown for the link.

- **Ask-first, not silent.** The composer surfaces the same ambiguous-style
  choice we already use — *Attach as Markdown* / *Convert + attach figures* /
  *Keep the link* — with a **set-as-default** opt-in (ADR 0008 grammar) for
  users who want it fully automatic. "Automatic" means no separate app / extract
  / tab step, not no consent.
- **Reuse the router, not a new engine.** A URL is dispatched by the same
  routing actions: `inbrowser` fetches the page and runs the HTML→Markdown
  engine already shipped in M2 (Turndown + parsers); `companion`/`http` POST the
  URL to an endpoint that fetches and converts (MarkItDown accepts a URL);
  `passthrough` leaves the link text in the composer. Forward escalation
  (`onEmpty`, SPEC §3.3) covers JS-rendered or empty pages: a thin in-browser
  fetch that extracts nothing escalates to the companion, which can render —
  native articles stay fast and local.
- **Permissions stay narrow.** `inbrowser` URL conversion requests the host
  permission for *that origin, just-in-time*, the first time you convert a page
  there — the same `chrome.permissions.request` + dynamic-registration pattern
  as activation hosts (ADR 0003). No manifest wildcard returns; read access is
  always a per-site, user-approved grant, and a companion-routed user grants the
  browser no extra host access at all.
- **Figures reuse extract-and-reference (ADR 0006).** A page's content images
  (junk-filtered by size, skipping icons/sprites/tracking pixels) attach as
  sibling files, overflowing to a labeled contact sheet — the PPTX/DOCX media
  path, which HTML images fit even more directly since they are already separate
  resources. `[image omitted: alt-text]` markers anchor them in the `.md`,
  matching the existing omission convention. The PDF mini-PDF path does not
  apply.
- **Classifier reused.** The three-way verdict maps onto a page: text-heavy
  article → convert; thin/gallery/app page → passthrough; text-plus-figures →
  ambiguous with the figures choice.
- **Passthrough symmetry.** On a site with no usable file input (kimi/Gemini,
  ADR 0020), or when the user chooses *Keep the link*, the URL text simply stays
  in the composer — the URL-paste analogue of "original sent unconverted," never
  a loss.

## Consequences

- Decant absorbs the namesakes' one real capability and does it automatically
  and in place, which their tab-and-paste model can't — turning the name overlap
  into "Decant does more" rather than "which Decant is this?".
- One new trigger and a small classifier mapping; the engine, router, figures,
  prompt, and permission machinery are all reused. The HTML engine already
  exists (M2), so the net new code is trigger detection, the fetch, and the
  routing plumbing for a non-file input.
- New network behavior: converting a pasted URL fetches that page — from the
  browser under a per-host grant, or from the companion. Page content stays
  local on `inbrowser`/`companion`; a remote `http` route carries the URL and
  content out and keeps the existing non-localhost warning. The options page
  states that conversion fetches the pasted URL (a site learns the page was
  accessed).
- Known limits / future tiers: JS-heavy or auth-gated pages a static fetch
  can't read fall to companion escalation or passthrough; reading an
  **already-open tab's live rendered DOM** (best fidelity for SPA/auth pages —
  the namesakes' actual mechanism — but needs a `tabs`-permission design) is a
  later tier; **batch** multi-URL conversion is deferred. Planned as SPEC M5.
