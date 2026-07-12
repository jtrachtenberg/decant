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
import {
  HTTP_CONVERT_MSG,
  fileToWire,
  wireToFile,
  MAX_RELAY_BYTES,
} from "./convert/relay.js";

const SCRIPT_ID = "decant-intercept";
const TAG = "[decant bg]";

function pattern(host) {
  return `*://${host}/*`;
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

async function syncRegistration() {
  const hosts = await permittedHosts();
  const matches = hosts.map(pattern);

  const existing = await browser.scripting.getRegisteredContentScripts({
    ids: [SCRIPT_ID],
  });

  try {
    if (!matches.length) {
      if (existing.length) {
        await browser.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
      }
      console.log(TAG, "no enabled+permitted hosts — content script unregistered");
      return;
    }

    const spec = {
      id: SCRIPT_ID,
      js: ["content/intercept.js"],
      matches,
      runAt: "document_start",
      allFrames: false,
      persistAcrossSessions: true,
    };

    if (existing.length) {
      await browser.scripting.updateContentScripts([spec]);
    } else {
      await browser.scripting.registerContentScripts([spec]);
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
