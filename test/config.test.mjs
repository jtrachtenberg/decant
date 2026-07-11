// Unit tests for the pure config helpers (defaults / normalize / enabledHosts).
//
//   node --test   (npm test)

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONFIG,
  DOCX_MIME,
  XLSX_MIME,
  XLS_MIME,
  PPTX_MIME,
  enabledHosts,
  normalizeConfig,
} from "../src/config/defaults.js";

test("default config enables claude.ai, chatgpt, gemini, and perplexity", () => {
  assert.deepEqual(enabledHosts(DEFAULT_CONFIG), [
    "claude.ai",
    "chatgpt.com",
    "gemini.google.com",
    "www.perplexity.ai",
  ]);
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

test("an explicitly-empty activation list stays empty (default-deny)", () => {
  // Removing every host must keep Decant off everywhere — resurrecting the
  // enabled defaults here would silently turn it back on (SPEC §3.1, ADR-0003).
  const cfg = normalizeConfig({ activation: { rules: [] } });
  assert.deepEqual(cfg.activation.rules, []);
  assert.deepEqual(enabledHosts(cfg), []);
});

test("an absent activation block still falls back to the enabled defaults", () => {
  // Distinct from the empty case above: nothing was said, so ship the defaults.
  assert.deepEqual(
    normalizeConfig({ routing: DEFAULT_CONFIG.routing }).activation.rules,
    DEFAULT_CONFIG.activation.rules
  );
  assert.deepEqual(normalizeConfig({}).activation.rules, DEFAULT_CONFIG.activation.rules);
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

test("showSavings defaults on and only an explicit false turns it off", () => {
  assert.equal(normalizeConfig(undefined).showSavings, true);
  assert.equal(normalizeConfig({}).showSavings, true);
  assert.equal(normalizeConfig({ showSavings: "nope" }).showSavings, true);
  assert.equal(normalizeConfig({ showSavings: false }).showSavings, false);
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

test("default routing converts PDF, DOCX, XLSX, PPTX, and HTML in-browser, else passthrough", () => {
  const { routing } = normalizeConfig(undefined);
  assert.equal(routing.default, "passthrough");
  assert.equal(routing.rules.length, 5);
  assert.ok(routing.rules.every((r) => r.action === "inbrowser"));
  assert.deepEqual(routing.rules[0].match, {
    mime: ["application/pdf"],
    ext: ["pdf"],
  });
  assert.deepEqual(routing.rules[1].match, {
    mime: [DOCX_MIME],
    ext: ["docx"],
  });
  assert.deepEqual(routing.rules[2].match, {
    mime: [XLSX_MIME, XLS_MIME],
    ext: ["xlsx", "xls"],
  });
  assert.deepEqual(routing.rules[3].match, {
    mime: [PPTX_MIME],
    ext: ["pptx"],
  });
  assert.deepEqual(routing.rules[4].match, {
    mime: ["text/html"],
    ext: ["html", "htm"],
  });
});

test("v1 configs get all engine default rules appended once", () => {
  const v1 = {
    version: 1,
    routing: {
      rules: [{ match: { mime: ["application/pdf"] }, action: "inbrowser" }],
    },
  };
  const { routing } = normalizeConfig(v1);
  assert.equal(routing.rules.length, 5);
  assert.deepEqual(routing.rules[1].match.ext, ["docx"]);
  assert.deepEqual(routing.rules[2].match.ext, ["xlsx", "xls"]);
  assert.deepEqual(routing.rules[3].match.ext, ["pptx"]);
  assert.deepEqual(routing.rules[4].match.ext, ["html", "htm"]);
  // Same for unversioned stored configs.
  const { routing: unversioned } = normalizeConfig({ routing: v1.routing });
  assert.equal(unversioned.rules.length, 5);
});

test("a v2 config gets only the post-v2 migrations", () => {
  const { routing } = normalizeConfig({
    version: 2,
    routing: {
      rules: [{ match: { mime: ["application/pdf"] }, action: "inbrowser" }],
    },
  });
  // DOCX was removed at v2 by the user's choice — stays removed; the rest are new.
  assert.equal(routing.rules.length, 4);
  assert.deepEqual(routing.rules[1].match.ext, ["xlsx", "xls"]);
  assert.deepEqual(routing.rules[2].match.ext, ["pptx"]);
  assert.deepEqual(routing.rules[3].match.ext, ["html", "htm"]);
});

test("migrations respect existing per-type rules and current-version removals", () => {
  // A v1 config that already routes every engine type its own way: nothing added.
  const own = normalizeConfig({
    version: 1,
    routing: {
      rules: [
        {
          match: { ext: ["docx", "xlsx", "pptx", "html"] },
          action: "http",
          endpoint: "http://127.0.0.1:8765/convert",
        },
      ],
    },
  });
  assert.equal(own.routing.rules.length, 1);
  assert.equal(own.routing.rules[0].action, "http");

  // A current-version config without either rule chose to remove them.
  const removed = normalizeConfig({
    version: 5,
    routing: {
      rules: [{ match: { mime: ["application/pdf"] }, action: "inbrowser" }],
    },
  });
  assert.equal(removed.routing.rules.length, 1);
});

test("normalizeConfig falls back to default routing when the section is malformed", () => {
  for (const bad of [undefined, null, "rules", 42, { rules: "nope" }]) {
    const { routing } = normalizeConfig({ routing: bad });
    assert.deepEqual(routing, DEFAULT_CONFIG.routing);
  }
});

test("normalizeConfig drops unsalvageable routing rules, keeps valid ones", () => {
  const { routing } = normalizeConfig({
    version: 5, // current version — keep the engine migrations out of this test
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

test("normalizeConfig keeps onEmpty escalation only with a valid endpoint + target", () => {
  const { routing } = normalizeConfig({
    version: 5,
    routing: {
      rules: [
        {
          match: { mime: ["application/pdf"], ext: ["pdf"] },
          action: "inbrowser",
          onEmpty: "companion",
          // responseField pairs with /convert (JSON {"text": ...}); /convert-raw
          // would need it omitted — keep this fixture a copyable, working config.
          endpoint: "http://127.0.0.1:8765/convert",
          responseField: "text",
        },
      ],
    },
  });
  assert.equal(routing.rules[0].onEmpty, "companion");
  assert.equal(routing.rules[0].endpoint, "http://127.0.0.1:8765/convert");
  assert.equal(routing.rules[0].responseField, "text");
});

test("normalizeConfig drops onEmpty without an endpoint or with a bad target", () => {
  const { routing } = normalizeConfig({
    version: 5,
    routing: {
      rules: [
        // opts into escalation but has nowhere to escalate to
        { match: { ext: ["pdf"] }, action: "inbrowser", onEmpty: "companion" },
        // valid endpoint but "passthrough" isn't an escalation target
        {
          match: { ext: ["png"] },
          action: "inbrowser",
          onEmpty: "passthrough",
          endpoint: "http://127.0.0.1:8765/ocr",
        },
        // escalation is an inbrowser concept — a companion rule never comes up
        // empty in the browser, so a stray onEmpty is stripped
        {
          match: { ext: ["csv"] },
          action: "companion",
          onEmpty: "http",
          endpoint: "http://127.0.0.1:8765/convert",
        },
      ],
    },
  });
  assert.equal(routing.rules[0].onEmpty, undefined);
  assert.equal(routing.rules[1].onEmpty, undefined);
  assert.equal(routing.rules[2].onEmpty, undefined);
  assert.equal(routing.rules[2].endpoint, "http://127.0.0.1:8765/convert"); // rule itself survives
});

test("ambiguousDefault: defaults to ask, keeps valid choices, drops junk", () => {
  assert.equal(normalizeConfig(undefined).ambiguousDefault, "ask");
  assert.equal(normalizeConfig({}).ambiguousDefault, "ask");
  for (const v of ["ask", "convert", "figures", "companion", "original"]) {
    assert.equal(normalizeConfig({ ambiguousDefault: v }).ambiguousDefault, v);
  }
  // Hand-edited junk falls back to asking — never to a silent verdict.
  assert.equal(normalizeConfig({ ambiguousDefault: "yolo" }).ambiguousDefault, "ask");
  assert.equal(normalizeConfig({ ambiguousDefault: 3 }).ambiguousDefault, "ask");
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
