// Default Decant configuration and pure helpers over it.
//
// Config is persisted in chrome.storage.sync and edited from the options page.
// It mirrors the activation model in SPEC §7 — a default-deny host whitelist:
// nothing runs on a page unless its host is explicitly enabled here. Routing
// config (per-type transform rules) arrives with the companion tier (M3); for
// now conversion is fixed (PDF → in-browser classifier).
//
// This module is pure (no chrome.*), so it can be unit-tested and imported by
// both the storage wrapper and the options page.

export const CONFIG_VERSION = 1;

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
    hotkey: { ...DEFAULT_CONFIG.hotkey, ...(stored.hotkey || {}) },
  };
}
