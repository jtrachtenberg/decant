// Default Decant configuration and pure helpers over it.
//
// Config is persisted in chrome.storage.sync and edited from the options page.
// Two independent layers (SPEC §3): activation — a default-deny host
// whitelist, nothing runs on a page unless its host is explicitly enabled —
// and routing — ordered per-type rules deciding each intercepted file's fate.
//
// This module is pure (no chrome.*), so it can be unit-tested and imported by
// both the storage wrapper and the options page.

// Version history:
//   1 — activation + hotkey (+ routing added late in v1's life)
//   2 — DOCX ships: stored v1 configs get the default DOCX rule appended
//   3 — XLSX/XLS ships: same append-once migration
//   4 — PPTX ships: same
//   5 — HTML ships: same
export const CONFIG_VERSION = 5;

// Routing vocabulary (SPEC §3.2): what can happen to a matched file, and what
// a rule may fall back to when its engine fails or isn't available.
export const RULE_ACTIONS = ["inbrowser", "companion", "http", "passthrough"];
export const RULE_FALLBACKS = ["inbrowser", "passthrough"];
// Forward-escalation targets (SPEC §3.3): when the in-browser engine extracts
// nothing from a file — a scanned/image-only PDF — an `inbrowser` rule may
// escalate to a companion/http endpoint that *can* (OCR). Both need an
// endpoint, so a browser-only user who configures neither just passes the scan
// through. The complement of onError (which falls back when an endpoint fails);
// onEmpty steps forward when the browser comes up empty.
export const RULE_ONEMPTY = ["companion", "http"];

// Is this a usable companion/http endpoint URL? The single source of truth for
// endpoint validation — the options form, rule normalization, and the runtime
// escalation/ambiguous-prompt checks must all agree, or a rule accepted in one
// place is silently rejected in another.
export function isHttpEndpoint(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

// What to do with an ambiguous document (text plus charts/images). "ask" shows
// the prompt (the shipped default — automation is opt-in, never a silent
// verdict); the rest apply that prompt choice automatically, set either from
// the options page or the prompt's "set as default" checkbox. A remembered
// choice that isn't available for a given batch (no companion endpoint, type
// without extractable figures) falls back to asking.
export const AMBIGUOUS_CHOICES = ["ask", "convert", "figures", "companion", "original"];

export const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const XLS_MIME = "application/vnd.ms-excel";
export const PPTX_MIME =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

// Legacy binary .doc is deliberately absent: mammoth reads OOXML only, so a
// .doc routed inbrowser would just pass through as "no-engine". (SheetJS
// does read legacy .xls, so that one IS routed.)
const DOCX_RULE = {
  match: { mime: [DOCX_MIME], ext: ["docx"] },
  action: "inbrowser",
  enabled: true,
  onError: "passthrough",
  output: { ext: "md", mime: "text/markdown" },
};
const XLSX_RULE = {
  match: { mime: [XLSX_MIME, XLS_MIME], ext: ["xlsx", "xls"] },
  action: "inbrowser",
  enabled: true,
  onError: "passthrough",
  output: { ext: "md", mime: "text/markdown" },
};
// Legacy binary .ppt is absent for the same reason as .doc.
const PPTX_RULE = {
  match: { mime: [PPTX_MIME], ext: ["pptx"] },
  action: "inbrowser",
  enabled: true,
  onError: "passthrough",
  output: { ext: "md", mime: "text/markdown" },
};
const HTML_RULE = {
  match: { mime: ["text/html"], ext: ["html", "htm"] },
  action: "inbrowser",
  enabled: true,
  onError: "passthrough",
  output: { ext: "md", mime: "text/markdown" },
};

// Engine-arrival migrations: stored configs keep their own rule list, so a
// pre-<version> config gets the new default rule appended once — unless it
// already routes that type its own way. A config at/after <version> that
// lacks the rule chose to remove it.
const RULE_MIGRATIONS = [
  { version: 2, rule: DOCX_RULE, matches: (r) => r.match.mime.includes(DOCX_MIME) || r.match.ext.includes("docx") },
  { version: 3, rule: XLSX_RULE, matches: (r) => r.match.mime.includes(XLSX_MIME) || r.match.ext.includes("xlsx") },
  { version: 4, rule: PPTX_RULE, matches: (r) => r.match.mime.includes(PPTX_MIME) || r.match.ext.includes("pptx") },
  { version: 5, rule: HTML_RULE, matches: (r) => r.match.mime.includes("text/html") || r.match.ext.includes("html") },
];

export const DEFAULT_CONFIG = {
  version: CONFIG_VERSION,
  activation: {
    default: "off",
    // Common LLM chat hosts are pre-listed for convenience. claude.ai,
    // chatgpt.com, gemini.google.com, and www.perplexity.ai are enabled by
    // default (all four are required host permissions in the manifest, granted
    // at install); enabling another prompts Chrome for that host's permission
    // (see the options page / background worker). Perplexity runs on the www.
    // subdomain — a bare "perplexity.ai" rule's `https://perplexity.ai/*` pattern
    // never matches it, so the host must be spelled with www.
    rules: [
      { type: "host", match: "claude.ai", enabled: true },
      { type: "host", match: "chatgpt.com", enabled: true },
      { type: "host", match: "gemini.google.com", enabled: true },
      { type: "host", match: "www.perplexity.ai", enabled: true },
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
      structuredClone(DOCX_RULE),
      structuredClone(XLSX_RULE),
      structuredClone(PPTX_RULE),
      structuredClone(HTML_RULE),
    ],
  },
  // Passthrough hotkey binding (physical `code` + modifiers).
  hotkey: { code: "KeyO", alt: true, shift: true, ctrl: false, meta: false },
  // Show the estimated token-savings badge after a conversion.
  showSavings: true,
  // Ambiguous documents prompt by default; see AMBIGUOUS_CHOICES.
  ambiguousDefault: "ask",
};

// A host's match pattern — what permissions.request() asks Chrome for, what
// content-script registration matches on, and what capture target-resolution
// queries tabs with. HTTPS only, and deliberately: the string must sit inside
// the manifest's optional_host_permissions (`https://*/*`, not `*://*/*`) or a
// request for it can never be granted; every chat host Decant supports is TLS,
// so the scheme costs nothing. Single source of truth — background.js,
// options.js, and capture/target.js all feed permission and query APIs whose
// strings must agree exactly.
export function hostPattern(host) {
  return `https://${host}/*`;
}

// The registrable hostname of a URL, lower-cased; "" when unparseable.
export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

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
  // An *absent* activation block falls back to the shipped defaults; an
  // explicitly-present list (even empty) is honoured verbatim. Default-deny
  // means "off unless whitelisted", so a user who removes every host must stay
  // off everywhere — resurrecting the enabled defaults here would silently turn
  // Decant back on (SPEC §3.1, ADR-0003). Mirrors normalizeRouting below.
  const hasRules = Array.isArray(stored.activation?.rules);
  const rules = hasRules
    ? stored.activation.rules
        .filter((r) => r && r.type === "host" && typeof r.match === "string")
        .map((r) => ({
          type: "host",
          match: r.match.trim().toLowerCase(),
          enabled: r.enabled !== false,
        }))
    : structuredClone(DEFAULT_CONFIG.activation.rules);
  return {
    version: CONFIG_VERSION,
    activation: {
      default: "off",
      rules,
    },
    routing: normalizeRouting(stored.routing, stored.version),
    hotkey: normalizeHotkey(stored.hotkey),
    showSavings: stored.showSavings !== false,
    ambiguousDefault: AMBIGUOUS_CHOICES.includes(stored.ambiguousDefault)
      ? stored.ambiguousDefault
      : "ask",
  };
}

// Routing lives in hand-editable storage, so validate hard and fail toward
// passthrough (never toward converting or POSTing something unexpectedly):
// a malformed rule is dropped; a missing/malformed rules array falls back to
// the defaults. `default` is pinned to "passthrough" — the only safe fate for
// an unmatched file (SPEC §3.2).
function normalizeRouting(stored, storedVersion) {
  if (!stored || typeof stored !== "object") {
    return structuredClone(DEFAULT_CONFIG.routing);
  }
  const rules = Array.isArray(stored.rules)
    ? stored.rules.map(normalizeRule).filter(Boolean)
    : structuredClone(DEFAULT_CONFIG.routing.rules);

  // Engine-arrival migrations (see RULE_MIGRATIONS).
  for (const m of RULE_MIGRATIONS) {
    if (!(storedVersion >= m.version) && !rules.some(m.matches)) {
      rules.push(structuredClone(m.rule));
    }
  }

  return { default: "passthrough", rules };
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
    !isHttpEndpoint(endpoint)
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
  // Forward escalation is an inbrowser-rule concept (SPEC §3.3), opt-in, and
  // needs a real endpoint to escalate to; a non-inbrowser action, bad target,
  // or missing endpoint drops it, leaving a rule that passes empty
  // extractions through.
  if (
    r.action === "inbrowser" &&
    RULE_ONEMPTY.includes(r.onEmpty) &&
    isHttpEndpoint(endpoint)
  ) {
    rule.onEmpty = r.onEmpty;
  }
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
