// Decant — background service worker.
//
// Default-deny activation (SPEC §7.1): instead of a static content_scripts
// match, the content script is registered dynamically for exactly the hosts the
// user has enabled AND granted permission for. This keeps the install prompt
// minimal (only claude.ai is a required host permission) and lets users add
// other hosts at runtime via the options page.
//
// Registration is kept in sync on install, browser startup, config changes, and
// permission grants/revocations.

import { loadConfig, onConfigChanged } from "./config/config.js";
import { enabledHosts } from "./config/defaults.js";
import { httpConvert } from "./convert/http.js";
import {
  HTTP_CONVERT_MSG,
  fileToWire,
  wireToFile,
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
    if (await chrome.permissions.contains({ origins: [pattern(host)] })) {
      permitted.push(host);
    }
  }
  return permitted;
}

async function syncRegistration() {
  const hosts = await permittedHosts();
  const matches = hosts.map(pattern);

  const existing = await chrome.scripting.getRegisteredContentScripts({
    ids: [SCRIPT_ID],
  });

  try {
    if (!matches.length) {
      if (existing.length) {
        await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
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
      await chrome.scripting.updateContentScripts([spec]);
    } else {
      await chrome.scripting.registerContentScripts([spec]);
    }
    console.log(TAG, "registered on:", matches.join(", "));
  } catch (err) {
    console.error(TAG, "registration sync failed:", err);
  }
}

chrome.runtime.onInstalled.addListener(syncRegistration);
chrome.runtime.onStartup.addListener(syncRegistration);
chrome.permissions.onAdded.addListener(syncRegistration);
chrome.permissions.onRemoved.addListener(syncRegistration);
onConfigChanged(syncRegistration);

// ------------------------------------------------- http-convert relay ---
// The content script can't fetch a rule's endpoint itself (page CORS), so it
// relays the file here; this worker runs the engine with the extension's
// host permissions and ships the converted file back. Errors return as
// { ok: false } — the content side turns them into the rule's onError
// fallback, so a dead endpoint can never lose an upload.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== HTTP_CONVERT_MSG) return;
  (async () => {
    const out = await httpConvert(wireToFile(msg.file), msg.rule);
    sendResponse({ ok: true, file: await fileToWire(out) });
  })().catch((err) => {
    console.warn(TAG, "http convert failed:", err.message);
    sendResponse({ ok: false, error: String(err.message || err) });
  });
  return true; // sendResponse is async
});
