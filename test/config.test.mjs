// Unit tests for the pure config helpers (defaults / normalize / enabledHosts).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  enabledHosts,
  normalizeConfig,
} from "../src/config/defaults.js";

test("default config enables only claude.ai", () => {
  assert.deepEqual(enabledHosts(DEFAULT_CONFIG), ["claude.ai"]);
});

test("normalizeConfig fills defaults for empty / bad input", () => {
  assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig("nonsense"), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({}), DEFAULT_CONFIG);
});

test("normalizeConfig keeps and cleans host rules", () => {
  const cfg = normalizeConfig({
    activation: {
      rules: [
        { type: "host", match: " ChatGPT.com ", enabled: true },
        { type: "host", match: "claude.ai", enabled: false },
      ],
    },
  });
  assert.deepEqual(cfg.activation.rules, [
    { type: "host", match: "chatgpt.com", enabled: true },
    { type: "host", match: "claude.ai", enabled: false },
  ]);
});

test("enabledHosts excludes disabled rules and de-dupes", () => {
  const cfg = normalizeConfig({
    activation: {
      rules: [
        { type: "host", match: "claude.ai", enabled: true },
        { type: "host", match: "claude.ai", enabled: true },
        { type: "host", match: "gemini.google.com", enabled: false },
      ],
    },
  });
  assert.deepEqual(enabledHosts(cfg), ["claude.ai"]);
});

test("normalizeConfig merges hotkey over defaults", () => {
  const cfg = normalizeConfig({ hotkey: { code: "KeyP" } });
  assert.equal(cfg.hotkey.code, "KeyP");
  assert.equal(cfg.hotkey.alt, true); // default preserved
});

test("normalizeConfig falls back wholesale on a malformed hotkey code", () => {
  for (const bad of [{ code: 42 }, { code: "" }, { code: null }, "KeyP", 7]) {
    const cfg = normalizeConfig({ hotkey: bad });
    assert.deepEqual(cfg.hotkey, DEFAULT_CONFIG.hotkey);
  }
});

test("normalizeConfig coerces non-boolean hotkey modifiers", () => {
  const cfg = normalizeConfig({
    hotkey: { code: "KeyP", alt: "yes", ctrl: 1, shift: true, meta: null },
  });
  assert.deepEqual(cfg.hotkey, {
    code: "KeyP",
    alt: false,
    shift: true,
    ctrl: false,
    meta: false,
  });
});
