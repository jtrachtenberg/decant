# ADR 0033 — A message catalogue for every string a user reads

- **Status:** Accepted
- **Date:** 2026-08-01

## Context

Decant's user-visible text was written where it was shown: template literals
in `options.js`, `ui.js`, and `background.js`, and inline text in
`options.html`. That is fine until someone wants the extension in a language
other than English, and then none of it can move — there is no list of what
the strings *are*, and several of them are not strings at all but sentences
assembled at the call site:

    showConvertingBadge(name, "extracting figures from")
      → `Decant: ${verb} “${fileName}”…`
    showUnconvertedNotice("drag-and-drop")
      → `Decant: … — ${via} can't be substituted here.`
    figNote = ` with ${n} image(s)`
      → `Decant: delivered "${name}" to ${target}${figNote}.`
    count = `${n} visual element${n === 1 ? "" : "s"}`
      → `Converting to Markdown saves tokens but drops ${count}.`

Each of these hands a translator half a sentence and asks them to make it fit
around a fragment whose position, case, and agreement English chose. A
language that inflects the noun after a numeral, or puts the verb last, or
does not pluralize with `s`, cannot be served by translating the pieces.

The extension already reaches an audience these strings do not: the M3 work on
CJK word spacing and RTL reading order exists precisely because people convert
documents that are not in English.

## Decision

Every string a user reads comes from `src/_locales/<lang>/messages.json` and is
fetched through `t(key, ...args)` (`src/i18n.js`). Adding a language is adding
a directory; the browser picks the catalogue from the UI locale and falls back
to `default_locale` (en) key by key, so a partial translation is a supported
state rather than a broken one. The manifest's own strings — name, description,
toolbar tooltip, shortcut description — go through `__MSG_` for the same
reason, which also makes the AMO 45-character name limit a property of every
translation rather than of the English one only (`extNameShort`, build.mjs).

Three things follow from the fragment problem above, and they are the point of
the change rather than incidental to it:

- **A message is a whole sentence.** The four call sites above became
  `badgeConverting`/`badgeExtractingFigures`, `noticeUnconvertedDrop`/
  `noticeUnconvertedPaste`, three `noticeDelivered*` variants, and
  `promptVisualsOne`/`promptVisualsMany`/`promptVisualsUnknown` feeding three
  whole `promptDetail*` bodies. Callers now name *what happened* — `"paste"`,
  `"badgeExtractingFigures"` — and the catalogue owns the grammar. Chrome's
  i18n has no plural rules, so a count that changes the sentence gets one
  message per case; where a language needs more cases than English, it gets
  them by translating the case it has and the fallback covers the rest.
- **Every entry carries a `description`.** A translator seeing
  `"est."` or `"needs access — grant"` out of context cannot know that the
  first is an abbreviation on a badge and the second a button in a list row
  that must stay short. The descriptions say so, including which messages are
  quoted inside other messages and must be kept in step.
- **The options page is marked up, not rewritten.** `data-i18n`,
  `data-i18n-attr` for placeholders and titles, and `data-i18n-slot` for the
  one hint whose sentence wraps an inline `<code>` shortcut — the message keeps
  its `%s` and the translator places it where their grammar wants it, instead
  of the sentence being cut into a before-piece and an after-piece. The
  English text stays in the HTML as authored, so the page reads correctly for
  the moment before the script runs.

`localizeDocument()` also sets `lang` from `getUILanguage()` and `dir` from
`@@bidi_dir`, so an RTL locale mirrors the options page rather than shipping a
left-to-right layout full of right-to-left text.

**`t()` falls back to the bundled English catalogue** when `browser.i18n` is
absent. `getMessage` returns `""` for a key it doesn't have — a missing string
ships as a blank badge, not a crash — and the Node unit tests exercise
`menus.js` and `ui.js` with no extension runtime at all. The fallback imports
the same `messages.json` the browser loads, so the two cannot drift.

### What is deliberately not localized

- **Conversion output.** The markers Decant writes into the Markdown
  (`[image omitted: …]`, the omitted-chart-table note, the figures footer) are
  read by a model, not by the user. They are also the thing the corpus is
  compared on byte-for-byte across every change in this log; making them
  locale-dependent would make that comparison locale-dependent too.
- **The prefilled GitHub issue body.** It is addressed to an English-language
  issue tracker. A bug report the maintainer cannot read helps nobody.
- **Chat product names** (Claude, ChatGPT, Gemini, …) and the Decant brand.
  The same word in every locale; only the sentences around them are messages.
- **The `no-input` delivery sentinel**, which is protocol between the content
  and background sides and is matched before any prose is substituted for it.

## Consequences

- One place to read to know everything the extension says, which is also the
  first time that list has existed.
- `test/i18n.test.mjs` holds the catalogue and the code to each other in both
  directions: every key the code names exists, every entry is named by
  something, placeholders are declared and numbered `$1…$n`, every entry has a
  translator description, and the store name/description length limits hold.
  The reverse direction is what catches a typo in a key chosen by a ternary
  inside a `t(...)` call, which the forward scan cannot see: the typo orphans
  the entry it was meant to name.
- Contributors adding UI must add a catalogue entry — the test fails on a key
  with no entry, and on an entry nothing uses.
- Translations are now a contribution anyone can make without touching code.
  None ship yet; English is the only catalogue, which is exactly the state the
  fallback is designed for.
- Verified against the built extension in headless Chromium: the options page
  renders from `chrome.i18n` (headings, placeholders, select options, the
  `<code>` slot inside its sentence, a substituted status message, `lang` set
  to the UI locale), the converting and savings badges render their
  substituted forms, and every variant of the ambiguous prompt — singular and
  plural visual counts, one and many documents, all three detail bodies, all
  four buttons — renders with its choice wiring intact.
