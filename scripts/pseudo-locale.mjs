// Pseudo-localization — drive a real build in a second language without
// anyone having translated anything.
//
//   npm run build
//   node scripts/pseudo-locale.mjs fr
//   # load dist/ unpacked, then run the browser with its UI language set to
//   # French (chrome://settings/languages, or --lang=fr)
//
// The derived catalogue is written to dist/_locales/<locale>/, never to
// src/_locales/ — a pseudo-locale that reached a store upload would be a
// shipped language nobody can read, so it lives only in the built output and
// disappears on the next `npm run build`.
//
// Three properties, each catching a different class of bug:
//
//   ⟦…⟧ brackets    a string that appears without them never went through the
//                   catalogue: it is still hardcoded somewhere. This is the
//                   only check that finds a string the tests cannot see,
//                   because a hardcoded string is invisible to a scan that
//                   only knows about the keys that do exist.
//   áccéntéd vowels proves the text came from this file rather than from the
//                   English fallback — brackets alone wouldn't tell those
//                   apart if a key were missing from the pseudo catalogue.
//   ~30% padding    German and Finnish run longer than English; the padding
//                   finds the buttons and single-line pills that only fit
//                   their English. A clipped string is visible as a missing ⟧.
//
// Placeholders ($name$), the %s markup slot (i18n.js), and newlines pass
// through untouched: substituting into them is the runtime's job, and
// mangling them here would test this script instead of the extension.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

const ACCENT = { a: "á", e: "é", i: "í", o: "ó", u: "ú", A: "Á", E: "É", I: "Í", O: "Ó", U: "Ú" };
const PAD = "…ẍẍẍ";
const TOKENS = /(\$[A-Za-z0-9_@]+\$|%s|\\n|\n)/;

function pseudo(message) {
  const body = message
    .split(TOKENS)
    .map((part, i) => (i % 2 ? part : part.replace(/[aeiouAEIOU]/g, (c) => ACCENT[c])))
    .join("");
  return `⟦${body}${PAD.repeat(Math.max(1, Math.ceil(body.length / 28)))}⟧`;
}

const locale = process.argv[2];
if (!locale) {
  console.error("usage: node scripts/pseudo-locale.mjs <locale>   (e.g. fr, de, ar)");
  process.exit(2);
}
if (!existsSync("dist/_locales/en/messages.json")) {
  console.error("dist/_locales/en/messages.json not found — run `npm run build` first.");
  process.exit(2);
}

const en = JSON.parse(readFileSync("dist/_locales/en/messages.json", "utf8"));
const out = Object.fromEntries(
  Object.entries(en).map(([key, entry]) => [key, { ...entry, message: pseudo(entry.message) }])
);

mkdirSync(`dist/_locales/${locale}`, { recursive: true });
writeFileSync(`dist/_locales/${locale}/messages.json`, JSON.stringify(out, null, 2) + "\n");
console.log(
  `${Object.keys(out).length} messages → dist/_locales/${locale}/messages.json\n` +
    `Reload the extension, then set the browser UI language to "${locale}".\n` +
    `Anything still in plain English is a string that never reached the catalogue.`
);
