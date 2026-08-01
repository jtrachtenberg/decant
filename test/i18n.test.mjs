// The message catalogue is the one place a string can go missing without
// anything throwing: chrome.i18n.getMessage returns "" for a key it doesn't
// have, so a typo ships as a blank badge rather than a crash. These tests hold
// the catalogue and the code to each other in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { t } from "../src/i18n.js";

// fileURLToPath, not URL.pathname: on Windows the latter is "/C:/…/decant/",
// and join() turns that leading slash into "\C:\…" — a path that reads
// nowhere. Every other test in this directory resolves the same way.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const en = JSON.parse(readFileSync(join(ROOT, "src/_locales/en/messages.json"), "utf8"));

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(js|mjs|html)$/.test(entry)) out.push(path);
  }
  return out;
}

// i18n.js is the mechanism, not a consumer: its doc comment spells out the
// markup forms, and those examples are not references to real keys. Compared
// as a built path, so the separator matches on either platform.
const I18N = join(ROOT, "src", "i18n.js");
const sources = [
  ...walk(join(ROOT, "src")).filter((p) => p !== I18N),
  join(ROOT, "manifest.json"),
  join(ROOT, "build.mjs"),
].map((path) => ({ path, text: readFileSync(path, "utf8") }));

const matchAll = (re) =>
  sources.flatMap(({ path, text }) =>
    [...text.matchAll(re)].map((m) => ({ path, key: m[1] }))
  );

// Every bare identifier in double quotes, plus the manifest's __MSG_ form. A
// superset of the keys in use — enough to prove no catalogue entry is dead.
const mentioned = new Set([
  ...matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g).map((m) => m.key),
  ...matchAll(/__MSG_([A-Za-z0-9]+)__/g).map((m) => m.key),
  // data-i18n-attr packs "attr:key" pairs into one attribute value, so its
  // keys are not bare quoted identifiers.
  ...matchAll(/data-i18n-attr="[^"]*?:\s*([A-Za-z][A-Za-z0-9]*)/g).map((m) => m.key),
]);

test("every key the code names exists in the catalogue", () => {
  const referenced = [
    // t("key", …) — the direct form. Keys chosen by a ternary inside the call
    // are caught by the reverse test below: a typo there orphans the entry it
    // was meant to name.
    ...matchAll(/\bt\(\s*"([A-Za-z][A-Za-z0-9]*)"/g),
    // The options page's static markup.
    ...matchAll(/data-i18n(?:-slot)?="([A-Za-z][A-Za-z0-9]*)"/g),
    ...matchAll(/data-i18n-attr="[^"]*?:\s*([A-Za-z][A-Za-z0-9]*)/g),
    // manifest.json and the Firefox manifest transform in build.mjs.
    ...matchAll(/__MSG_([A-Za-z0-9]+)__/g),
  ];
  assert.ok(referenced.length > 40, "the scan found suspiciously few keys");
  const missing = referenced.filter(({ key }) => !en[key]);
  assert.deepEqual(missing, [], `keys with no catalogue entry: ${JSON.stringify(missing)}`);
});

test("every catalogue entry is used", () => {
  const orphans = Object.keys(en).filter((key) => !mentioned.has(key));
  assert.deepEqual(orphans, [], `catalogue entries nothing names: ${orphans.join(", ")}`);
});

test("every entry carries a translator description", () => {
  const undescribed = Object.entries(en)
    .filter(([, entry]) => !entry.description?.trim())
    .map(([key]) => key);
  assert.deepEqual(undescribed, []);
});

test("placeholders are declared, numbered from 1, and used", () => {
  for (const [key, entry] of Object.entries(en)) {
    const declared = entry.placeholders ?? {};
    const named = new Set(
      [...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)].map((m) => m[1].toLowerCase())
    );
    for (const name of named) {
      assert.ok(declared[name], `${key}: $${name}$ is not declared`);
    }
    for (const name of Object.keys(declared)) {
      assert.ok(named.has(name.toLowerCase()), `${key}: declared ${name} is never used`);
    }
    // chrome.i18n fills placeholders from positional arguments, so the
    // contents must be exactly $1…$n with nothing skipped.
    const positions = Object.values(declared)
      .map((p) => p.content)
      .sort();
    assert.deepEqual(
      positions,
      positions.map((_, i) => `$${i + 1}`),
      `${key}: placeholder contents must be $1…$n`
    );
  }
});

test("t() substitutes positionally, and survives a missing runtime", () => {
  // No browser.i18n exists under Node — this is the bundled-catalogue path.
  assert.equal(t("statusHostEnabled", "claude.ai"), "Decant enabled on claude.ai.");
  assert.equal(
    t("badgeSavingsPercent", "12.4k", 44),
    "Decant saved ~12.4k tokens (~44%)"
  );
  assert.equal(t("promptChoiceOriginal"), "Send original");
});

test("t() of an unknown key is empty rather than a thrown error", () => {
  assert.equal(t("noSuchKeyAnywhere"), "");
});

test("the sentence-with-inline-markup slot marker is present where used", () => {
  const html = readFileSync(join(ROOT, "src/options/options.html"), "utf8");
  for (const [, key] of html.matchAll(/data-i18n="([A-Za-z0-9]+)"(?=[^>]*>[^<]*<[^>]*data-i18n-slot)/g)) {
    assert.ok(en[key].message.includes("%s"), `${key} has a slot child but no %s`);
  }
});

// --- every locale, not just the reference one -------------------------------
//
// A translation is data, and these are the ways it can be wrong without
// anything throwing. Missing keys are deliberately NOT an error: the browser
// falls back per key, so a partial translation is a supported state and
// treating it as a failure would make starting one impossible.

const LIMITS = { extName: 75, extNameShort: 45, extDescription: 132 };

// The placeholders a message actually substitutes, as positions rather than
// names — a translator may rename $host$, but it must still be argument 1.
const positionsOf = (entry) =>
  [...entry.message.matchAll(/\$([A-Za-z0-9_@]+)\$/g)]
    .map((m) => entry.placeholders?.[m[1].toLowerCase()]?.content)
    .filter(Boolean)
    .sort();

const locales = readdirSync(join(ROOT, "src/_locales")).map((locale) => ({
  locale,
  messages: JSON.parse(
    readFileSync(join(ROOT, "src/_locales", locale, "messages.json"), "utf8")
  ),
}));

test("every locale is a directory the browser will look in", () => {
  for (const { locale } of locales) {
    // Chrome matches _locales dirs case-sensitively against BCP-47 with an
    // underscore before the region: "pt_BR", never "pt-BR" or "PT".
    assert.match(locale, /^[a-z]{2,3}(_[A-Z]{2})?$/, `unusable locale dir: ${locale}`);
  }
  assert.ok(locales.some((l) => l.locale === "en"), "the default_locale must exist");
});

test("no locale carries a key the catalogue has retired", () => {
  for (const { locale, messages } of locales) {
    const stale = Object.keys(messages).filter((key) => !en[key]);
    assert.deepEqual(stale, [], `${locale} has keys English no longer defines: ${stale.join(", ")}`);
  }
});

test("every translated message substitutes what its English original does", () => {
  // Collected rather than asserted one at a time: a translator wants the whole
  // list of what to fix, not the first line of it on each re-run.
  const problems = [];
  for (const { locale, messages } of locales) {
    for (const [key, entry] of Object.entries(messages)) {
      if (!en[key]) continue; // reported by the retired-key test
      const [got, want] = [positionsOf(entry), positionsOf(en[key])];
      if (got.join() !== want.join()) {
        problems.push(
          `${locale}/${key} substitutes ${got.join(",") || "nothing"} where English ` +
            `substitutes ${want.join(",") || "nothing"} — a dropped placeholder ` +
            `silently loses the host, file name or count it carried`
        );
      }
      // The %s slot is how a message keeps an inline element inside its own
      // sentence (i18n.js). Lose it and the element lands at the end.
      if (entry.message.includes("%s") !== en[key].message.includes("%s")) {
        problems.push(`${locale}/${key} must keep its %s slot`);
      }
    }
  }
  assert.deepEqual(problems, [], "\n" + problems.join("\n"));
});

test("store names and descriptions fit both stores' limits, in every locale", () => {
  // Chrome Web Store: 75 for the name, 132 for the description. AMO rejects a
  // name over 45, which is why extNameShort exists (see build.mjs). The stores
  // measure the localized string, so this is a per-translation constraint —
  // German and Finnish are where it will bite.
  for (const { locale, messages } of locales) {
    for (const [key, limit] of Object.entries(LIMITS)) {
      const message = messages[key]?.message;
      if (message === undefined) continue; // falls back to English, already checked
      assert.ok(
        message.length <= limit,
        `${locale}/${key} is ${message.length} characters; the store limit is ${limit}`
      );
    }
  }
});

test("the manifest points at the catalogue and declares a fallback locale", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extName__");
  assert.equal(manifest.description, "__MSG_extDescription__");
  assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
});
