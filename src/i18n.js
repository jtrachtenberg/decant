// Decant — user-facing strings.
//
// Every string a user reads comes from `src/_locales/<lang>/messages.json` and
// is fetched through `t(key, ...args)`. Adding a language means adding a
// directory there; no code changes, because the browser picks the catalogue
// from the UI locale and falls back to `default_locale` (en) per key.
//
// Two things are deliberately NOT routed through here:
//   - Conversion output. The markers Decant writes into the Markdown
//     (`[image omitted: …]`, the omitted-chart-table note) are read by a model,
//     not by the user, and the corpus is compared byte-for-byte across changes.
//   - The prefilled GitHub issue body. It is addressed to an English-language
//     issue tracker; translating it would make bug reports unreadable to the
//     person who has to act on them.
//
// The English catalogue is also imported directly, as the fallback for when
// `browser.i18n` isn't there: the Node unit tests exercise menus.js and ui.js
// with no extension runtime at all, and a missing API should degrade to
// readable English rather than to empty strings. It is the same file the
// browser loads, so the two can't drift.

import { browser } from "./browser.js";
import en from "./_locales/en/messages.json" with { type: "json" };

// Resolve a catalogue entry the way chrome.i18n does: named placeholders map
// to positional arguments ($1…$9) via the entry's `placeholders` block, and
// `$$` is a literal dollar sign.
function fromCatalogue(key, args) {
  const entry = en[key];
  if (!entry) return "";
  const named = entry.placeholders ?? {};
  return entry.message.replace(/\$([A-Za-z0-9_@]+)\$|\$\$/g, (whole, name) => {
    if (whole === "$$") return "$";
    const content = named[name.toLowerCase()]?.content ?? named[name]?.content;
    const i = Number(/^\$(\d)$/.exec(content ?? "")?.[1]);
    return i >= 1 ? String(args[i - 1] ?? "") : whole;
  });
}

// A localized string. Arguments fill the message's placeholders in order.
export function t(key, ...args) {
  const message = browser?.i18n?.getMessage?.(key, args.map(String));
  // getMessage returns "" for a key the catalogue doesn't have — never let
  // that reach the screen as a blank badge.
  return message || fromCatalogue(key, args);
}

// --- Options-page markup ------------------------------------------------------
//
// The options page is static HTML, so its strings are marked up rather than
// passed as arguments:
//
//   data-i18n="key"              → the element's text
//   data-i18n-attr="attr:key,…"  → an attribute (placeholder, title, aria-label)
//   data-i18n-slot               → on a CHILD of a data-i18n element: the
//                                  message's "%s" is replaced by that child,
//                                  keeping an inline <code>/<a> inside a
//                                  sentence the translator still sees whole.

function applyText(el, message) {
  const slot = el.querySelector("[data-i18n-slot]");
  if (!slot) {
    el.textContent = message;
    return;
  }
  const cut = message.indexOf("%s");
  const [before, after] =
    cut === -1 ? [message, ""] : [message.slice(0, cut), message.slice(cut + 2)];
  const slotKey = slot.getAttribute("data-i18n-slot");
  if (slotKey) slot.textContent = t(slotKey);
  const doc = el.ownerDocument;
  el.replaceChildren(doc.createTextNode(before), slot, doc.createTextNode(after));
}

export function localizeDocument(doc = document) {
  // The catalogue decides the page's language and writing direction: an RTL
  // locale needs `dir` for the layout to mirror, and `lang` for the right font
  // stack and hyphenation.
  const locale = browser?.i18n?.getUILanguage?.();
  if (locale) doc.documentElement.lang = locale;
  const dir = browser?.i18n?.getMessage?.("@@bidi_dir");
  if (dir) doc.documentElement.dir = dir;

  for (const el of doc.querySelectorAll("[data-i18n]")) {
    applyText(el, t(el.getAttribute("data-i18n")));
  }
  for (const el of doc.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.getAttribute("data-i18n-attr").split(",")) {
      const [attr, key] = pair.split(":").map((s) => s.trim());
      if (attr && key) el.setAttribute(attr, t(key));
    }
  }
}
