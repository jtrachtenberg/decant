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

test("default routing converts PDFs in-browser, everything else passthrough", () => {
  const { routing } = normalizeConfig(undefined);
  assert.equal(routing.default, "passthrough");
  assert.equal(routing.rules.length, 1);
  assert.equal(routing.rules[0].action, "inbrowser");
  assert.deepEqual(routing.rules[0].match, {
    mime: ["application/pdf"],
    ext: ["pdf"],
  });
});

test("normalizeConfig falls back to default routing when the section is malformed", () => {
  for (const bad of [undefined, null, "rules", 42, { rules: "nope" }]) {
    const { routing } = normalizeConfig({ routing: bad });
    assert.deepEqual(routing, DEFAULT_CONFIG.routing);
  }
});

test("normalizeConfig drops unsalvageable routing rules, keeps valid ones", () => {
  const { routing } = normalizeConfig({
    routing: {
      rules: [
        { match: { mime: ["application/pdf"] }, action: "inbrowser" },
        { match: { mime: ["image/png"] }, action: "teleport" }, // unknown action
        { match: { mime: [] }, action: "inbrowser" }, // matches nothing
        { match: { ext: ["docx"] }, action: "companion" }, // no endpoint
        "not a rule",
        null,
      ],
    },
  });
  assert.equal(routing.rules.length, 1);
  assert.equal(routing.rules[0].action, "inbrowser");
});

test("normalizeConfig fills rule defaults and cleans match values", () => {
  const { routing } = normalizeConfig({
    routing: {
      rules: [
        { match: { mime: [" Application/PDF ", 7], ext: [".PDF"] }, action: "inbrowser" },
      ],
    },
  });
  assert.deepEqual(routing.rules[0], {
    match: { mime: ["application/pdf"], ext: ["pdf"] },
    action: "inbrowser",
    enabled: true,
    onError: "passthrough",
  });
});

test("normalizeConfig keeps a well-formed http rule, pins routing default", () => {
  const { routing } = normalizeConfig({
    routing: {
      default: "http", // not allowed — unmatched files must pass through
      rules: [
        {
          match: { mime: ["image/png"] },
          action: "http",
          endpoint: "http://127.0.0.1:8765/ocr",
          request: { encoding: "multipart" },
          responseField: "text",
          output: { ext: ".MD", mime: "Text/Markdown" },
          enabled: false,
          onError: "inbrowser",
        },
      ],
    },
  });
  assert.equal(routing.default, "passthrough");
  assert.deepEqual(routing.rules[0], {
    match: { mime: ["image/png"], ext: [] },
    action: "http",
    enabled: false,
    onError: "inbrowser",
    endpoint: "http://127.0.0.1:8765/ocr",
    output: { ext: "md", mime: "text/markdown" },
    responseField: "text",
    request: { encoding: "multipart" },
  });
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
