// Decant options page — edits the config the background worker and content
// script react to. Enabling a host requests that host's permission (from the
// click gesture); saving the config triggers the background worker to
// re-register the content script.

import { loadConfig, saveConfig } from "../config/config.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../config/defaults.js";

const hostsEl = document.getElementById("hosts");
const rulesEl = document.getElementById("rules");
const hotkeyDisplay = document.getElementById("hotkey-display");
const statusEl = document.getElementById("status");

let config;

const pattern = (host) => `*://${host}/*`;

function status(msg) {
  statusEl.textContent = msg;
  if (msg) setTimeout(() => (statusEl.textContent = ""), 2500);
}

async function commit() {
  await saveConfig(config);
  config = await loadConfig(); // re-read normalized form
  render();
}

function render() {
  renderHosts();
  renderRules();
  hotkeyDisplay.textContent = formatHotkey(config.hotkey);
}

function renderHosts() {
  hostsEl.replaceChildren();
  for (const rule of config.activation.rules) {
    const li = document.createElement("li");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.enabled;
    cb.addEventListener("change", () => toggleHost(rule.match, cb));
    const name = document.createElement("span");
    name.className = "host";
    name.textContent = rule.match;
    label.append(cb, name);

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.title = "Remove host";
    remove.addEventListener("click", () => removeHost(rule.match));

    li.append(label, remove);
    hostsEl.append(li);
  }
}

async function toggleHost(host, cb) {
  const rule = config.activation.rules.find((r) => r.match === host);
  if (!rule) return;

  if (cb.checked) {
    const granted = await chrome.permissions.request({ origins: [pattern(host)] });
    if (!granted) {
      cb.checked = false;
      status(`Permission for ${host} was declined.`);
      return;
    }
    rule.enabled = true;
    status(`Decant enabled on ${host}.`);
  } else {
    rule.enabled = false;
    await chrome.permissions.remove({ origins: [pattern(host)] }).catch(() => {});
    status(`Decant disabled on ${host}.`);
  }
  await commit();
}

async function removeHost(host) {
  config.activation.rules = config.activation.rules.filter((r) => r.match !== host);
  await chrome.permissions.remove({ origins: [pattern(host)] }).catch(() => {});
  await commit();
  status(`Removed ${host}.`);
}

async function addHost() {
  const input = document.getElementById("new-host");
  const host = normalizeHost(input.value);
  if (!host) {
    status("Enter a valid host, e.g. example.com");
    return;
  }
  if (config.activation.rules.some((r) => r.match === host)) {
    input.value = "";
    status(`${host} is already listed.`);
    return;
  }
  // Default to enabled: request permission right away (from this click gesture).
  const granted = await chrome.permissions.request({ origins: [pattern(host)] });
  config.activation.rules.push({ type: "host", match: host, enabled: granted });
  input.value = "";
  await commit();
  status(
    granted
      ? `Added and enabled ${host}.`
      : `Added ${host} (permission declined — toggle it on to grant).`
  );
}

// ---------------------------------------------------------------- routing ---

const ACTION_LABELS = {
  inbrowser: "Convert in browser",
  passthrough: "Pass through",
  companion: "Local companion",
  http: "Send to endpoint",
};

// SPEC §3.5 privacy guardrail: anything that isn't loopback means documents
// leave the machine. Unparseable URLs count as remote — fail toward warning.
function isRemoteEndpoint(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return !["localhost", "127.0.0.1", "::1"].includes(host);
  } catch {
    return true;
  }
}

// The background worker's fetch needs host permission for the endpoint's
// origin. Match patterns ignore ports, so one grant covers the whole host.
function originPattern(endpoint) {
  try {
    const u = new URL(endpoint);
    return `${u.protocol}//${u.hostname}/*`;
  } catch {
    return null;
  }
}

// Request permission for endpoint origins (deduped). Must be called from a
// click handler — that's the gesture Chrome requires. Returns false when
// declined; the rules still save, their fetches just fail into onError until
// permission is granted.
async function requestEndpointPermission(endpoints) {
  const origins = [...new Set(endpoints.map(originPattern).filter(Boolean))];
  if (!origins.length) return true;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

function renderRules() {
  rulesEl.replaceChildren();
  config.routing.rules.forEach((rule, i) => {
    const li = document.createElement("li");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.enabled;
    cb.addEventListener("change", () => toggleRule(i, cb.checked));
    const what = document.createElement("span");
    what.className = "rule-what";
    what.textContent = [...rule.match.ext, ...rule.match.mime].join(", ");
    const action = document.createElement("span");
    action.className = "rule-action";
    action.textContent =
      "→ " +
      (ACTION_LABELS[rule.action] || rule.action) +
      (rule.endpoint ? ` · ${rule.endpoint}` : "");
    label.append(cb, what, action);
    if (rule.endpoint && isRemoteEndpoint(rule.endpoint)) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = "⚠";
      warn.title =
        "This endpoint is not localhost — matching files leave your machine.";
      label.append(warn);
    }

    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "✕";
    remove.title = "Remove rule";
    remove.addEventListener("click", () => removeRule(i));

    li.append(label, remove);
    rulesEl.append(li);
  });
}

async function toggleRule(index, enabled) {
  const rule = config.routing.rules[index];
  if (!rule) return;
  rule.enabled = enabled;
  await commit();
  status(enabled ? "Rule enabled." : "Rule disabled.");
}

async function removeRule(index) {
  config.routing.rules.splice(index, 1);
  await commit();
  status("Rule removed.");
}

async function addRule() {
  const matchInput = document.getElementById("new-match");
  const action = document.getElementById("new-action").value;
  const endpointInput = document.getElementById("new-endpoint");

  const tokens = matchInput.value.trim().toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) {
    status("Enter at least one extension or MIME type to match.");
    return;
  }
  const mime = tokens.filter((t) => t.includes("/"));
  const ext = tokens.filter((t) => !t.includes("/")).map((t) => t.replace(/^\./, ""));

  const rule = { match: { mime, ext }, action, enabled: true, onError: "passthrough" };

  if (action === "companion" || action === "http") {
    const endpoint = endpointInput.value.trim();
    if (!/^https?:\/\//i.test(endpoint)) {
      status("This action needs an endpoint URL (http:// or https://).");
      return;
    }
    if (
      isRemoteEndpoint(endpoint) &&
      !confirm(
        `${endpoint} is not localhost — files matching this rule will leave your machine.\n\nAdd the rule anyway?`
      )
    ) {
      return;
    }
    rule.endpoint = endpoint;
  }

  const granted = rule.endpoint
    ? await requestEndpointPermission([rule.endpoint])
    : true;

  config.routing.rules.push(rule);
  matchInput.value = "";
  endpointInput.value = "";
  await commit();
  status(
    granted
      ? "Rule added."
      : "Rule added — endpoint permission declined, so matching files use the fallback until it's granted."
  );
}

// ------------------------------------------------------------ JSON config ---

function exportJson() {
  document.getElementById("config-json").value = JSON.stringify(config, null, 2);
  status("Current config loaded below — edit and “Apply JSON”.");
}

async function importJson() {
  const textarea = document.getElementById("config-json");
  let parsed;
  try {
    parsed = JSON.parse(textarea.value);
  } catch (err) {
    status(`Invalid JSON: ${err.message}`);
    return;
  }
  const next = normalizeConfig(parsed);

  const remote = next.routing.rules
    .filter((r) => r.endpoint && isRemoteEndpoint(r.endpoint))
    .map((r) => r.endpoint);
  if (remote.length) {
    const ok = confirm(
      `This config sends matching files to non-localhost endpoints:\n\n` +
        `${[...new Set(remote)].join("\n")}\n\nDocuments matching those rules ` +
        `will leave your machine. Apply anyway?`
    );
    if (!ok) return;
  }

  const granted = await requestEndpointPermission(
    next.routing.rules.filter((r) => r.endpoint).map((r) => r.endpoint)
  );

  config = next;
  await commit();
  textarea.value = JSON.stringify(config, null, 2); // show the normalized form
  status(
    "Config applied. Newly enabled hosts still need permission — toggle them to grant." +
      (granted ? "" : " Endpoint permission declined — those rules use their fallback.")
  );
}

function normalizeHost(value) {
  let host = (value || "").trim().toLowerCase();
  host = host.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

function formatHotkey(hk) {
  const parts = [];
  if (hk.ctrl) parts.push("Ctrl");
  if (hk.alt) parts.push("Alt");
  if (hk.shift) parts.push("Shift");
  if (hk.meta) parts.push("Meta");
  parts.push(hk.code.replace(/^Key/, "").replace(/^Digit/, ""));
  return parts.join(" + ");
}

// Non-null while a recording is in progress; calling it cancels. Guards
// against a second "Change…" click stacking a second keydown listener (both
// would fire and each remove only itself → double commit).
let cancelRecording = null;

function recordHotkey() {
  const btn = document.getElementById("record-hotkey");
  if (cancelRecording) {
    cancelRecording();
    return;
  }
  btn.textContent = "Press keys…";
  const cancel = () => {
    document.removeEventListener("keydown", onKey, true);
    btn.textContent = "Change…";
    cancelRecording = null;
  };
  const onKey = async (e) => {
    e.preventDefault();
    if (e.key === "Escape") {
      cancel();
      return;
    }
    // Wait for a non-modifier key so the binding has a real trigger.
    if (["Alt", "Shift", "Control", "Meta"].includes(e.key)) return;
    // Require a real modifier (Shift alone doesn't count): the content-script
    // listener is capture-phase on document, so an unmodified binding like
    // bare KeyE would hijack typing on every enabled site.
    if (!e.altKey && !e.ctrlKey && !e.metaKey) {
      status("Include Alt, Ctrl, or Cmd in the shortcut.");
      return;
    }
    config.hotkey = {
      code: e.code,
      alt: e.altKey,
      shift: e.shiftKey,
      ctrl: e.ctrlKey,
      meta: e.metaKey,
    };
    cancel();
    await commit();
    status("Hotkey updated.");
  };
  document.addEventListener("keydown", onKey, true);
  cancelRecording = cancel;
}

async function reset() {
  config = structuredClone(DEFAULT_CONFIG);
  await commit();
  status("Reset to defaults.");
}

async function init() {
  config = await loadConfig();
  render();
  document.getElementById("add-host").addEventListener("click", addHost);
  document.getElementById("new-host").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHost();
  });
  document.getElementById("add-rule").addEventListener("click", addRule);
  document.getElementById("new-match").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addRule();
  });
  document.getElementById("new-action").addEventListener("change", (e) => {
    document.getElementById("endpoint-row").hidden = !["companion", "http"].includes(
      e.target.value
    );
  });
  document.getElementById("export-json").addEventListener("click", exportJson);
  document.getElementById("import-json").addEventListener("click", importJson);
  document.getElementById("record-hotkey").addEventListener("click", recordHotkey);
  document.getElementById("reset").addEventListener("click", reset);
}

init();
