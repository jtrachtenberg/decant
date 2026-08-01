// The message catalogue is the one place a string can go missing without
// anything throwing: chrome.i18n.getMessage returns "" for a key it doesn't
// have, so a typo ships as a blank badge rather than a crash. These tests hold
// the catalogue and the code to each other in both directions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { t } from "../src/i18n.js";

const ROOT = new URL("..", import.meta.url).pathname;
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
// markup forms, and those examples are not references to real keys.
const sources = [
  ...walk(join(ROOT, "src")).filter((p) => !p.endsWith("src/i18n.js")),
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

test("store names and descriptions fit both stores' limits", () => {
  // Chrome Web Store: 75 for the name, 132 for the description. AMO rejects a
  // name over 45, which is why extNameShort exists (see build.mjs).
  assert.ok(en.extName.message.length <= 75, "extName exceeds the Chrome Web Store limit");
  assert.ok(en.extNameShort.message.length <= 45, "extNameShort exceeds the AMO limit");
  assert.ok(en.extDescription.message.length <= 132, "extDescription is too long");
});

test("the manifest points at the catalogue and declares a fallback locale", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extName__");
  assert.equal(manifest.description, "__MSG_extDescription__");
  assert.equal(manifest.action.default_title, "__MSG_actionTitle__");
});
