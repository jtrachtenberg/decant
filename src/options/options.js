// Decant options page — edits the config the background worker and content
// script react to. Enabling a host requests that host's permission (from the
// click gesture); saving the config triggers the background worker to
// re-register the content script.

import { browser } from "../browser.js";
import { loadConfig, saveConfig } from "../config/config.js";
import { loadStats, resetStats, onStatsChanged } from "../config/stats.js";
import { formatTokens } from "../convert/savings.js";
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  isHttpEndpoint,
  RULE_ONEMPTY,
} from "../config/defaults.js";

// A rule escalates when it's in-browser and onEmpty names a real escalation
// target — the same definition normalizeRule enforces, sharing RULE_ONEMPTY so
// the form and the normalizer can't drift apart.
const escalates = (action, onEmpty) =>
  action === "inbrowser" && RULE_ONEMPTY.includes(onEmpty);

const hostsEl = document.getElementById("hosts");
const rulesEl = document.getElementById("rules");
const hotkeyDisplay = document.getElementById("hotkey-display");
const showSavingsEl = document.getElementById("show-savings");
const ambiguousDefaultEl = document.getElementById("ambiguous-default");
const tokensSavedEl = document.getElementById("tokens-saved");
const statusEl = document.getElementById("status");

let config;

// Must stay identical to background.js's pattern(): both feed
// permissions.request/contains/remove, and a mismatch would ask Chrome for an
// origin the manifest never declared. HTTPS-only — see that function's note.
const pattern = (host) => `https://${host}/*`;

function status(msg) {
  statusEl.textContent = msg;
  if (msg) setTimeout(() => (statusEl.textContent = ""), 2500);
}

// Persist, re-read the normalized form, re-render. Returns true when the save
// stuck. storage.sync can reject (quota — 8KB/item — or transient
// errors); then the in-memory edit is rolled back to what storage actually
// holds, so the UI never shows state that didn't persist, and callers skip
// their success status.
async function commit() {
  try {
    await saveConfig(config);
  } catch (err) {
    console.warn("[decant] config save failed:", err);
    try {
      config = await loadConfig();
    } catch {
      // storage unreadable too — keep the in-memory config so the page stays usable
    }
    render();
    status(`Save failed — ${err.message}`);
    return false;
  }
  config = await loadConfig(); // re-read normalized form
  render();
  return true;
}

function render() {
  renderHosts();
  renderRules();
  hotkeyDisplay.textContent = formatHotkey(config.hotkey);
  showSavingsEl.checked = config.showSavings;
  ambiguousDefaultEl.value = config.ambiguousDefault;
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
    const granted = await browser.permissions.request({ origins: [pattern(host)] });
    if (!granted) {
      cb.checked = false;
      status(`Permission for ${host} was declined.`);
      return;
    }
    rule.enabled = true;
    status(`Decant enabled on ${host}.`);
  } else {
    rule.enabled = false;
    await browser.permissions.remove({ origins: [pattern(host)] }).catch(() => {});
    status(`Decant disabled on ${host}.`);
  }
  await commit();
}

async function removeHost(host) {
  config.activation.rules = config.activation.rules.filter((r) => r.match !== host);
  await browser.permissions.remove({ origins: [pattern(host)] }).catch(() => {});
  if (!(await commit())) return;
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
  const granted = await browser.permissions.request({ origins: [pattern(host)] });
  config.activation.rules.push({ type: "host", match: host, enabled: granted });
  input.value = "";
  if (!(await commit())) return;
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

// Can Chrome ever grant this endpoint's origin? optional_host_permissions
// declares `https://*/*` plus the loopback literals, so plain HTTP to a remote
// host is an origin the manifest cannot ask for — the request is rejected
// outright rather than declined, and no amount of retrying would change it.
// Worth catching up front: reporting it as a declined permission would promise
// a grant the user has no way to give. Sending documents unencrypted to
// somebody else's machine is the one case this costs, which is not a loss.
function isGrantableEndpoint(url) {
  try {
    return new URL(url).protocol === "https:" || !isRemoteEndpoint(url);
  } catch {
    return false;
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
    return await browser.permissions.request({ origins });
  } catch {
    return false;
  }
}

function renderRules() {
  rulesEl.replaceChildren();
  config.routing.rules.forEach((rule) => {
    const li = document.createElement("li");

    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = rule.enabled;
    cb.addEventListener("change", () => toggleRule(rule, cb.checked));
    const what = document.createElement("span");
    what.className = "rule-what";
    what.textContent = [...rule.match.ext, ...rule.match.mime].join(", ");
    const action = document.createElement("span");
    action.className = "rule-action";
    action.textContent =
      "→ " +
      (ACTION_LABELS[rule.action] || rule.action) +
      (rule.onEmpty
        ? ` ⤳ ${ACTION_LABELS[rule.onEmpty] || rule.onEmpty} on empty`
        : "") +
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
    remove.addEventListener("click", () => removeRule(rule));

    li.append(label, remove);
    rulesEl.append(li);
  });
}

// toggle/remove operate on the rule OBJECT, not a render-time index: an index
// captured at render can point at a different rule after a concurrent edit or a
// double-click during a slow save (splicing the wrong one). The object is a
// live element of config.routing.rules, so identity stays correct until the
// next render replaces the row.
async function toggleRule(rule, enabled) {
  if (!config.routing.rules.includes(rule)) return;
  rule.enabled = enabled;
  if (!(await commit())) return;
  status(enabled ? "Rule enabled." : "Rule disabled.");
}

async function removeRule(rule) {
  const i = config.routing.rules.indexOf(rule);
  if (i === -1) return; // already gone (double-click) — no-op
  config.routing.rules.splice(i, 1);
  if (!(await commit())) return;
  // Release the endpoint's host permission if no remaining rule still uses that
  // origin — otherwise a deleted rule's grant lingers forever (L5).
  const origin = rule.endpoint && originPattern(rule.endpoint);
  if (origin && !config.routing.rules.some((r) => r.endpoint && originPattern(r.endpoint) === origin)) {
    await browser.permissions.remove({ origins: [origin] }).catch(() => {});
  }
  status("Rule removed.");
}

// Show the endpoint / responseField / onEmpty inputs only when the chosen
// action (or its onEmpty escalation) actually needs them.
function syncRuleForm() {
  const action = document.getElementById("new-action").value;
  const onEmpty = document.getElementById("new-onempty").value;
  document.getElementById("onempty-row").hidden = action !== "inbrowser";
  const needsEndpoint =
    action === "companion" || action === "http" || escalates(action, onEmpty);
  document.getElementById("endpoint-row").hidden = !needsEndpoint;
  document.getElementById("responsefield-row").hidden = !needsEndpoint;
}

async function addRule() {
  const matchInput = document.getElementById("new-match");
  const action = document.getElementById("new-action").value;
  const onEmpty = document.getElementById("new-onempty").value; // "", companion, http
  const endpointInput = document.getElementById("new-endpoint");
  const responseFieldInput = document.getElementById("new-responsefield");

  const tokens = matchInput.value.trim().toLowerCase().split(/[,\s]+/).filter(Boolean);
  if (!tokens.length) {
    status("Enter at least one extension or MIME type to match.");
    return;
  }
  const mime = tokens.filter((t) => t.includes("/"));
  const ext = tokens.filter((t) => !t.includes("/")).map((t) => t.replace(/^\./, ""));

  const rule = { match: { mime, ext }, action, enabled: true, onError: "passthrough" };

  // A rule carries an endpoint when the action posts to one, or when an
  // in-browser rule escalates to one on an empty (scanned) extraction.
  const escalating = escalates(action, onEmpty);
  const carriesEndpoint = action === "companion" || action === "http" || escalating;

  if (carriesEndpoint) {
    const endpoint = endpointInput.value.trim();
    if (!isHttpEndpoint(endpoint)) {
      status("This needs an endpoint URL (http:// or https://).");
      return;
    }
    if (!isGrantableEndpoint(endpoint)) {
      status(
        "Chrome can't grant access to a plain http:// endpoint on another machine. Use https://, or run the endpoint on localhost."
      );
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
    const responseField = responseFieldInput.value.trim();
    if (responseField) rule.responseField = responseField;
  }
  if (escalating) rule.onEmpty = onEmpty;

  const granted = rule.endpoint
    ? await requestEndpointPermission([rule.endpoint])
    : true;

  // routeFile is first-enabled-match and new rules append, so an earlier enabled
  // rule matching the same type shadows this one — it would render as active but
  // never run. Warn (still add) since there's no reorder UI (L1).
  const shadow = config.routing.rules.find(
    (r) =>
      r.enabled &&
      ([...mime].some((t) => r.match.mime.includes(t)) ||
        [...ext].some((t) => r.match.ext.includes(t)))
  );

  config.routing.rules.push(rule);
  matchInput.value = "";
  endpointInput.value = "";
  responseFieldInput.value = "";
  document.getElementById("new-onempty").value = "";
  syncRuleForm();
  if (!(await commit())) return;
  if (shadow) {
    const type = [...shadow.match.ext, ...shadow.match.mime][0] || "that type";
    status(
      `Rule added, but an earlier enabled rule already handles ${type}, so this one won't run until you remove or disable the earlier one.`
    );
  } else {
    status(
      granted
        ? "Rule added."
        : "Rule added — endpoint permission declined, so matching files use the fallback until it's granted."
    );
  }
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
  if (!(await commit())) return;
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
    if (!(await commit())) return;
    status("Hotkey updated.");
  };
  document.addEventListener("keydown", onKey, true);
  cancelRecording = cancel;
}

async function reset() {
  config = structuredClone(DEFAULT_CONFIG);
  if (!(await commit())) return;
  status("Reset to defaults.");
}

// ------------------------------------------------------------- bug report ---

const ISSUES_URL = "https://github.com/jtrachtenberg/decant/issues/new";

// Build a prefilled "new issue" URL: GitHub reads title/body/labels from the
// query string, so the template lives here rather than needing a repo file.
function bugReportUrl() {
  const { version } = browser.runtime.getManifest();
  const body = [
    "**What happened?**",
    "",
    "",
    "**Steps to reproduce**",
    "1. ",
    "2. ",
    "",
    "**What did you expect instead?**",
    "",
    "",
    "**File type and site**",
    "e.g. a PDF on claude.ai",
    "",
    "---",
    `- Decant version: ${version}`,
    `- Browser: ${navigator.userAgent}`,
  ].join("\n");
  const params = new URLSearchParams({ labels: "bug", title: "[Bug] ", body });
  return `${ISSUES_URL}?${params}`;
}

function reportBug() {
  window.open(bugReportUrl(), "_blank", "noopener");
}

// -------------------------------------------------------- savings counter ---

// The lifetime total lives in storage.local (see stats.js), separate from the
// synced config, and grows from the chat tabs — onStatsChanged keeps this page
// live while one of them saves in the background.
function renderStats(stats) {
  const n = stats.totalTokensSaved;
  tokensSavedEl.textContent = n > 0 ? `~${formatTokens(n)} tokens` : "0 tokens";
}

async function resetSavingsCounter() {
  try {
    await resetStats();
  } catch (err) {
    status(`Reset failed — ${err.message}`);
    return;
  }
  renderStats({ totalTokensSaved: 0 }); // onStatsChanged also fires; harmless
  status("Savings counter reset.");
}

async function init() {
  config = await loadConfig();
  render();
  // Stats load failure shows a dash, never blocks the settings themselves.
  loadStats().then(renderStats).catch(() => (tokensSavedEl.textContent = "—"));
  onStatsChanged(renderStats);
  document.getElementById("reset-stats").addEventListener("click", resetSavingsCounter);
  document.getElementById("add-host").addEventListener("click", addHost);
  document.getElementById("new-host").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addHost();
  });
  document.getElementById("add-rule").addEventListener("click", addRule);
  document.getElementById("new-match").addEventListener("keydown", (e) => {
    if (e.key === "Enter") addRule();
  });
  document.getElementById("new-action").addEventListener("change", syncRuleForm);
  document.getElementById("new-onempty").addEventListener("change", syncRuleForm);
  syncRuleForm(); // initial visibility (default action is inbrowser)
  document.getElementById("export-json").addEventListener("click", exportJson);
  document.getElementById("import-json").addEventListener("click", importJson);
  document.getElementById("record-hotkey").addEventListener("click", recordHotkey);
  showSavingsEl.addEventListener("change", async () => {
    config.showSavings = showSavingsEl.checked;
    if (!(await commit())) return;
    status(showSavingsEl.checked ? "Savings badge on." : "Savings badge off.");
  });
  ambiguousDefaultEl.addEventListener("change", async () => {
    config.ambiguousDefault = ambiguousDefaultEl.value;
    if (!(await commit())) return;
    status(
      config.ambiguousDefault === "ask"
        ? "Ambiguous documents will prompt."
        : "Ambiguous default saved."
    );
  });
  document.getElementById("reset").addEventListener("click", reset);
  document.getElementById("report-bug").addEventListener("click", reportBug);
}

init();
