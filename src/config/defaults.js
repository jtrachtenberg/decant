// Default Decant configuration and pure helpers over it.
//
// Config is persisted in chrome.storage.sync and edited from the options page.
// Two independent layers (SPEC §3): activation — a default-deny host
// whitelist, nothing runs on a page unless its host is explicitly enabled —
// and routing — ordered per-type rules deciding each intercepted file's fate.
//
// This module is pure (no chrome.*), so it can be unit-tested and imported by
// both the storage wrapper and the options page.

export const CONFIG_VERSION = 1;

// Routing vocabulary (SPEC §3.2): what can happen to a matched file, and what
// a rule may fall back to when its engine fails or isn't available.
export const RULE_ACTIONS = ["inbrowser", "companion", "http", "passthrough"];
export const RULE_FALLBACKS = ["inbrowser", "passthrough"];

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  activation: {
    default: "off",
    // Common LLM chat hosts are pre-listed for convenience. Only claude.ai is
    // enabled by default (default-deny); enabling another prompts Chrome for
    // that host's permission (see the options page / background worker).
    rules: [
      { type: "host", match: "claude.ai", enabled: true },
      { type: "host", match: "chatgpt.com", enabled: false },
      { type: "host", match: "gemini.google.com", enabled: false },
      { type: "host", match: "perplexity.ai", enabled: false },
      { type: "host", match: "chat.mistral.ai", enabled: false },
    ],
  },
  // Routing — ordered rules matched by MIME type and/or extension; the first
  // enabled match decides the file's fate, anything unmatched passes through
  // (SPEC §3.2–3.4). M2 ships the in-browser PDF engine only; companion/http
  // rules are accepted by the schema but fall back per `onError` until their
  // engines land (M3).
  routing: {
    default: "passthrough",
    rules: [
      {
        match: { mime: ["application/pdf"], ext: ["pdf"] },
        action: "inbrowser",
        enabled: true,
        onError: "passthrough",
        output: { ext: "md", mime: "text/markdown" },
      },
    ],
  },
  // Passthrough hotkey binding (physical `code` + modifiers).
  hotkey: { code: "KeyO", alt: true, shift: true, ctrl: false, meta: false },
};

// Enabled host patterns from a config, lower-cased and de-duplicated.
export function enabledHosts(config) {
  const hosts = (config?.activation?.rules ?? [])
    .filter((r) => r.type === "host" && r.enabled && r.match)
    .map((r) => r.match.trim().toLowerCase());
  return [...new Set(hosts)];
}

// Normalize / migrate a stored value to the current shape, filling defaults for
// anything missing or malformed. Always returns a valid config.
export function normalizeConfig(stored) {
  if (!stored || typeof stored !== "object") {
    return structuredClone(DEFAULT_CONFIG);
  }
  const rules = Array.isArray(stored.activation?.rules)
    ? stored.activation.rules.filter(
        (r) => r && r.type === "host" && typeof r.match === "string"
      )
    : [];
  return {
    version: CONFIG_VERSION,
    activation: {
      default: "off",
      rules: rules.length
        ? rules.map((r) => ({
            type: "host",
            match: r.match.trim().toLowerCase(),
            enabled: r.enabled !== false,
          }))
        : structuredClone(DEFAULT_CONFIG.activation.rules),
    },
    routing: normalizeRouting(stored.routing),
    hotkey: normalizeHotkey(stored.hotkey),
  };
}

// Routing lives in hand-editable storage, so validate hard and fail toward
// passthrough (never toward converting or POSTing something unexpectedly):
// a malformed rule is dropped; a missing/malformed rules array falls back to
// the defaults. `default` is pinned to "passthrough" — the only safe fate for
// an unmatched file (SPEC §3.2).
function normalizeRouting(stored) {
  if (!stored || typeof stored !== "object") {
    return structuredClone(DEFAULT_CONFIG.routing);
  }
  return {
    default: "passthrough",
    rules: Array.isArray(stored.rules)
      ? stored.rules.map(normalizeRule).filter(Boolean)
      : structuredClone(DEFAULT_CONFIG.routing.rules),
  };
}

// One routing rule, or null when it can't be salvaged: unknown action,
// a match that can never hit, or a companion/http rule with no usable
// endpoint to talk to.
function normalizeRule(r) {
  if (!r || typeof r !== "object") return null;
  if (!RULE_ACTIONS.includes(r.action)) return null;

  const strings = (xs) =>
    Array.isArray(xs)
      ? xs
          .filter((s) => typeof s === "string" && s.trim())
          .map((s) => s.trim().toLowerCase())
      : [];
  const mime = strings(r.match?.mime);
  const ext = strings(r.match?.ext).map((e) => e.replace(/^\./, ""));
  if (!mime.length && !ext.length) return null;

  const endpoint = typeof r.endpoint === "string" ? r.endpoint.trim() : "";
  if (
    (r.action === "companion" || r.action === "http") &&
    !/^https?:\/\//i.test(endpoint)
  ) {
    return null;
  }

  const rule = {
    match: { mime, ext },
    action: r.action,
    enabled: r.enabled !== false,
    onError: RULE_FALLBACKS.includes(r.onError) ? r.onError : "passthrough",
  };
  if (endpoint) rule.endpoint = endpoint;
  if (r.output && typeof r.output === "object") {
    const output = {};
    if (typeof r.output.ext === "string" && r.output.ext.trim()) {
      output.ext = r.output.ext.trim().replace(/^\./, "").toLowerCase();
    }
    if (typeof r.output.mime === "string" && r.output.mime.trim()) {
      output.mime = r.output.mime.trim().toLowerCase();
    }
    if (Object.keys(output).length) rule.output = output;
  }
  if (typeof r.responseField === "string" && r.responseField.trim()) {
    rule.responseField = r.responseField.trim();
  }
  if (
    r.request &&
    typeof r.request === "object" &&
    ["multipart", "base64-json"].includes(r.request.encoding)
  ) {
    rule.request = { encoding: r.request.encoding };
  }
  return rule;
}

// A stored hotkey must be a plausible binding or matching silently never
// fires: `code` a non-empty string, modifiers real booleans. Missing fields
// inherit the default; a bad `code` (e.g. a hand-edited sync value like
// { code: 42 }) discards the stored binding wholesale.
function normalizeHotkey(stored) {
  const merged = {
    ...DEFAULT_CONFIG.hotkey,
    ...(stored && typeof stored === "object" ? stored : {}),
  };
  if (typeof merged.code !== "string" || merged.code === "") {
    return structuredClone(DEFAULT_CONFIG.hotkey);
  }
  return {
    code: merged.code,
    alt: merged.alt === true,
    shift: merged.shift === true,
    ctrl: merged.ctrl === true,
    meta: merged.meta === true,
  };
}
