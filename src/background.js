// Decant — background service worker.
//
// Default-deny activation (SPEC §7.1): instead of a static content_scripts
// match, the content script is registered dynamically for exactly the hosts the
// user has enabled AND granted permission for. The manifest declares the
// shipped default hosts (claude.ai, chatgpt.com, gemini.google.com,
// www.perplexity.ai) as host_permissions so they work on install; any other
// host is added at runtime from the options page via an optional-permission
// grant, so nothing injects into a site the user hasn't opted into.
//
// Registration is kept in sync on install, browser startup, config changes, and
// permission grants/revocations.

import { browser } from "./browser.js";
import { loadConfig, onConfigChanged } from "./config/config.js";
import { enabledHosts, isHttpEndpoint } from "./config/defaults.js";
import { httpConvert } from "./convert/http.js";
import { capturePage, captureFileName } from "./capture/capture.js";
import { menuItems, hostFromMenuId } from "./capture/menus.js";
import {
  HTTP_CONVERT_MSG,
  fileToWire,
  wireToFile,
  MAX_RELAY_BYTES,
} from "./convert/relay.js";

const SCRIPT_ID = "decant-intercept";
const MAIN_SCRIPT_ID = "decant-picker-shim";
const TAG = "[decant bg]";

// A host's match pattern. HTTPS only, and deliberately: this string is what
// permissions.request() asks Chrome for, so it must sit inside the manifest's
// optional_host_permissions or the request can never be granted. That entry is
// `https://*/*` rather than `*://*/*` to keep the declared surface off plain
// HTTP — every chat host Decant supports is TLS, so the scheme costs nothing.
function pattern(host) {
  return `https://${host}/*`;
}

async function permittedHosts() {
  const hosts = enabledHosts(await loadConfig());
  const permitted = [];
  for (const host of hosts) {
    if (await browser.permissions.contains({ origins: [pattern(host)] })) {
      permitted.push(host);
    }
  }
  return permitted;
}

// Register/update one content-script spec, or unregister it when spec is null.
async function syncScript(id, spec) {
  const existing = await browser.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!spec) {
    if (existing.length) {
      await browser.scripting.unregisterContentScripts({ ids: [id] });
    }
  } else if (existing.length) {
    await browser.scripting.updateContentScripts([spec]);
  } else {
    await browser.scripting.registerContentScripts([spec]);
  }
}

async function syncRegistration() {
  const hosts = await permittedHosts();
  const matches = hosts.map(pattern);

  try {
    if (!matches.length) {
      await syncScript(SCRIPT_ID, null);
      await syncScript(MAIN_SCRIPT_ID, null);
      console.log(TAG, "no enabled+permitted hosts — content scripts unregistered");
      return;
    }

    const base = {
      matches,
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    };
    await syncScript(SCRIPT_ID, {
      id: SCRIPT_ID,
      js: ["content/intercept.js"],
      ...base,
    });
    // The MAIN-world picker shim (ADR 0019) is registered separately and its
    // failure tolerated: Firefox < 128 rejects world: "MAIN", and an
    // enhancement's registration error must never take down the primary
    // interception path. Without it, detached-picker sites (kimi.com) just
    // don't convert — the pre-shim status quo.
    try {
      await syncScript(MAIN_SCRIPT_ID, {
        id: MAIN_SCRIPT_ID,
        js: ["content/main-world.js"],
        world: "MAIN",
        ...base,
      });
    } catch (err) {
      console.warn(TAG, "picker-shim registration failed (detached pickers won't convert):", err);
      await syncScript(MAIN_SCRIPT_ID, null).catch(() => {});
    }
    console.log(TAG, "registered on:", matches.join(", "));
  } catch (err) {
    console.error(TAG, "registration sync failed:", err);
  }
}

browser.runtime.onInstalled.addListener(syncRegistration);
browser.runtime.onStartup.addListener(syncRegistration);
browser.permissions.onAdded.addListener(syncRegistration);
browser.permissions.onRemoved.addListener(syncRegistration);
onConfigChanged(syncRegistration);

// ------------------------------------------------------- page capture ---
// The reverse-direction surface (SPEC §3.11): capture the page being read and
// send it to a chat, rather than intercepting a file on its way into one.
// Read access comes from activeTab — the click/shortcut/menu-pick IS the
// grant — so no host permission is requested for the captured page.

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// Menu ids are unique per registration, so a rebuild must remove before it
// creates; concurrent rebuilds (install + a config change) would otherwise
// race into duplicate-id errors. Serialized through one chain.
let menuSync = Promise.resolve();
function syncMenus() {
  menuSync = menuSync
    .then(async () => {
      await browser.contextMenus.removeAll();
      for (const item of menuItems(enabledHosts(await loadConfig()))) {
        browser.contextMenus.create(item);
      }
    })
    .catch((err) => console.warn(TAG, "context-menu sync failed:", err));
  return menuSync;
}

browser.runtime.onInstalled.addListener(syncMenus);
browser.runtime.onStartup.addListener(syncMenus);
onConfigChanged(syncMenus);

// Toolbar badge — the only user-visible signal capture has until delivery
// lands (phase 2 owns the on-page notice). Cleared on a timer so a stale tick
// never reads as the current state.
let badgeTimer = null;
function flashBadge(text, color) {
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => browser.action.setBadgeText({ text: "" }), 4000);
}

// One capture, from any trigger. `forcedHost` is the picked target (context
// menu); null means the automatic path — the last-used chat, resolved in
// phase 2.
async function runCapture(tab, forcedHost) {
  if (!tab?.id) return;
  const url = tab.url ?? "";
  // v1: capturing a chat *into* a chat isn't a flow that makes sense, and the
  // enabled-hosts list is exactly the set of pages where the interception
  // surface already runs.
  if (enabledHosts(await loadConfig()).includes(hostOf(url))) {
    console.warn(TAG, "capture skipped: already on a chat host");
    flashBadge("—", "#8a8a8a");
    return;
  }

  const result = await capturePage(tab.id, url);
  if (!result.ok) {
    console.warn(TAG, "capture failed:", result.error);
    flashBadge("!", "#b3261e");
    return;
  }
  const name = captureFileName(result.title, result.url);
  console.log(
    TAG,
    `captured ${name}: ${result.summary.chars} chars` +
      (result.summary.images ? `, ${result.summary.images} images omitted` : "") +
      ` → ${forcedHost ?? "last-used chat"}`
  );
  flashBadge("✓", "#1a7f37");
  // PHASE 2 SEAM (SPEC §3.11 "Delivery"): resolve the target tab by
  // lastAccessed / stored last-injection host, hand off the Markdown, and
  // replace the badge with a real on-page outcome notice.
}

browser.action.onClicked.addListener((tab) => runCapture(tab, null));
browser.contextMenus.onClicked.addListener((info, tab) =>
  runCapture(tab, hostFromMenuId(info.menuItemId))
);
browser.commands.onCommand.addListener((command, tab) => {
  if (command === "capture-page") runCapture(tab, null);
});

// The set of endpoints the stored, already-validated routing rules point at.
// The relay only fetches one of these — never an arbitrary URL that arrived in
// a message (see the relay listener below).
async function trustedEndpoints() {
  const cfg = await loadConfig();
  const set = new Set();
  for (const r of cfg.routing?.rules ?? []) {
    if ((r.action === "http" || r.action === "companion") && isHttpEndpoint(r.endpoint)) {
      set.add(r.endpoint);
    }
  }
  return set;
}

// ------------------------------------------------- http-convert relay ---
// The content script can't fetch a rule's endpoint itself (page CORS), so it
// relays the file here; this worker runs the engine with the extension's
// host permissions and ships the converted file back. Errors return as
// { ok: false } — the content side turns them into the rule's onError
// fallback, so a dead endpoint can never lose an upload.
browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== HTTP_CONVERT_MSG) return;
  (async () => {
    // Defense in depth: this worker holds the extension's host permissions, so
    // it must not POST a document to any URL merely because a message named it.
    // Only endpoints present in the stored routing config are honoured, and the
    // relay size cap is re-checked here (the sender's cap is not load-bearing).
    const endpoint = msg.rule?.endpoint;
    if (!isHttpEndpoint(endpoint) || !(await trustedEndpoints()).has(endpoint)) {
      console.warn(TAG, "relay rejected: endpoint not in routing config:", endpoint);
      sendResponse({ ok: false, error: "endpoint not permitted by routing config" });
      return;
    }
    const file = wireToFile(msg.file);
    if (file.size > MAX_RELAY_BYTES) {
      sendResponse({ ok: false, error: "file exceeds relay size cap" });
      return;
    }
    const out = await httpConvert(file, msg.rule);
    sendResponse({ ok: true, file: await fileToWire(out) });
  })().catch((err) => {
    console.warn(TAG, "http convert failed:", err.message);
    sendResponse({ ok: false, error: String(err.message || err) });
  });
  return true; // sendResponse is async
});
