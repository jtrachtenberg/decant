// Decant options page — edits the config the background worker and content
// script react to. Enabling a host requests that host's permission (from the
// click gesture); saving the config triggers the background worker to
// re-register the content script.

import { loadConfig, saveConfig } from "../config/config.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

const hostsEl = document.getElementById("hosts");
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
  document.getElementById("record-hotkey").addEventListener("click", recordHotkey);
  document.getElementById("reset").addEventListener("click", reset);
}

init();
