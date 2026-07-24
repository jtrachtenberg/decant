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
import { loadConfig, saveConfig, onConfigChanged } from "./config/config.js";
import { enabledHosts, hostOf, hostPattern, isHttpEndpoint } from "./config/defaults.js";
import { httpConvert } from "./convert/http.js";
import { capturePage, captureFileName } from "./capture/capture.js";
import { menuItems, hostFromMenuId, displayName, FIGURES_MENU_ID } from "./capture/menus.js";
import { resolveTarget } from "./capture/target.js";
import { deliverCapture, focusTab, copyToTab, showPageNotice } from "./capture/deliver.js";
import { recordLastTarget } from "./capture/last-target.js";
import {
  HTTP_CONVERT_MSG,
  fileToWire,
  wireToFile,
  MAX_RELAY_BYTES,
} from "./convert/relay.js";

const SCRIPT_ID = "decant-intercept";
const MAIN_SCRIPT_ID = "decant-picker-shim";
const TAG = "[decant bg]";

// The host match pattern (single source: defaults.js — permissions, script
// registration, and capture tab queries must agree on the string exactly).
const pattern = hostPattern;

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

// Menu ids are unique per registration, so a rebuild must remove before it
// creates; concurrent rebuilds (install + a config change) would otherwise
// race into duplicate-id errors. Serialized through one chain.
let menuSync = Promise.resolve();
function syncMenus() {
  menuSync = menuSync
    .then(async () => {
      const cfg = await loadConfig();
      await browser.contextMenus.removeAll();
      for (const item of menuItems(enabledHosts(cfg), cfg.capture)) {
        browser.contextMenus.create(item);
      }
    })
    .catch((err) => console.warn(TAG, "context-menu sync failed:", err));
  return menuSync;
}

browser.runtime.onInstalled.addListener(syncMenus);
browser.runtime.onStartup.addListener(syncMenus);
onConfigChanged(syncMenus);

// Toolbar badge — the glanceable outcome tick beside the on-page notices
// (✓ delivered, ! failed, — skipped, … working). Cleared on a timer so a
// stale tick never reads as the current state; the in-flight "…" gets a long
// leash (cold delivery can legitimately take tens of seconds) and is always
// replaced by an outcome tick.
let badgeTimer = null;
function flashBadge(text, color, ttlMs = 4000) {
  browser.action.setBadgeText({ text });
  browser.action.setBadgeBackgroundColor({ color });
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => browser.action.setBadgeText({ text: "" }), ttlMs);
}

// One capture, from any trigger. `forcedHost` is the picked target (context
// menu); null means the automatic path — the last-used chat. Every exit is
// loud: a badge tick plus, wherever a page can be scripted, an on-page notice
// (the failure may land in a tab the user isn't watching, so the source page
// — where they just clicked — is the reporting surface of last resort).
// One capture per source tab at a time: a double-click on the toolbar (or an
// impatient re-trigger while a cold delivery settles) would otherwise run two
// full captures and attach the same page twice.
const capturesInFlight = new Set();

async function runCapture(tab, forcedHost) {
  if (!tab?.id) return;
  if (capturesInFlight.has(tab.id)) {
    console.warn(TAG, "capture already running for this tab — ignoring re-trigger");
    return;
  }
  capturesInFlight.add(tab.id);
  try {
    await runCaptureInner(tab, forcedHost);
  } finally {
    capturesInFlight.delete(tab.id);
  }
}

async function runCaptureInner(tab, forcedHost) {
  const url = tab.url ?? "";
  const cfg = await loadConfig();
  const enabled = enabledHosts(cfg);

  // v1: capturing a chat *into* a chat isn't a flow that makes sense, and the
  // enabled-hosts list is exactly the set of pages where the interception
  // surface already runs.
  if (enabled.includes(hostOf(url))) {
    console.warn(TAG, "capture skipped: already on a chat host");
    flashBadge("—", "#8a8a8a");
    showPageNotice(tab.id, "Decant: capture works on content pages — this is already a chat.");
    return;
  }

  // Only granted hosts can ever answer a delivery: the content script is
  // registered on enabled ∩ granted, so an enabled-but-ungranted host would
  // hang the ping for its full timeout and then fail vaguely. (Live QA hit
  // exactly this: an ungranted kimi tab, made query-visible by an activeTab
  // grant, was picked as the target and could never respond.) Resolution
  // therefore ranks over granted hosts only, and an explicit pick of an
  // ungranted host fails fast with the actual remedy.
  const granted = await permittedHosts();
  if (forcedHost && !granted.includes(forcedHost)) {
    flashBadge("!", "#b3261e");
    showPageNotice(
      tab.id,
      `Decant: ${forcedHost} is enabled but Decant was never granted access to it — re-enable it in Decant's options, then retry.`,
      "error"
    );
    return;
  }

  // Immediate feedback on the page the user just clicked: the quiet stretch
  // between the gesture and the outcome (figure fetches, the cold-tab
  // handshake, the no-input wait) otherwise reads as a failed click. Each
  // later notice replaces this one (same element id), and the in-flight badge
  // outlives the default flash so it can't clear mid-delivery.
  flashBadge("…", "#6b5cff", 60000);
  showPageNotice(tab.id, "Decant: capturing this page…");

  const result = await capturePage(tab.id, url, { figures: cfg.capture.figures });
  if (!result.ok) {
    console.warn(TAG, "capture failed:", result.error);
    flashBadge("!", "#b3261e");
    showPageNotice(tab.id, `Decant couldn't capture this page — ${result.error}.`, "error");
    return;
  }

  const target = await resolveTarget(granted, forcedHost);
  if (!target) {
    flashBadge("!", "#b3261e");
    showPageNotice(
      tab.id,
      enabled.length
        ? "Decant: no enabled chat site has been granted access — re-enable one in Decant's options."
        : "Decant: no chat sites are enabled — enable one in Decant's options.",
      "error"
    );
    return;
  }

  const name = captureFileName(result.title, result.url);
  const figures = result.figures ?? [];
  const targetName = displayName(target.host);
  showPageNotice(tab.id, `Decant: sending "${name}" to ${targetName}…`);
  console.log(
    TAG,
    `captured ${name}: ${result.summary.chars} chars` +
      (figures.length ? ` + ${figures.length} figure(s)` : "") +
      ` → ${target.host} (${target.via})`
  );

  const outcome = await deliverCapture(target, [
    { name, type: "text/markdown", text: result.markdown },
    ...figures,
  ]);

  if (outcome.ok) {
    // The content side already recorded itself as last target on injection;
    // recording here too covers it having no storage access mid-teardown.
    recordLastTarget(target.host);
    flashBadge("✓", "#1a7f37");
    // Closure for the "sending…" notice if the user flips back to the source.
    // When images were asked for, say what became of them — an all-skipped
    // page (CORS-unreadable) otherwise looks like the toggle did nothing.
    const figNote = figures.length
      ? ` with ${figures.length} image(s)`
      : result.figuresSkipped
        ? ` — its images couldn't be read from the page, so they stay as links`
        : "";
    showPageNotice(tab.id, `Decant: delivered "${name}" to ${targetName}${figNote}.`);
    console.log(TAG, `delivered ${name} to ${target.host}`);
  } else if (outcome.noInput) {
    // The chat has no usable file input (Gemini/kimi — ADR 0020's capture
    // analogue): put the Markdown on the clipboard and say so on the now-
    // focused chat page itself.
    await focusTab(outcome.tabId);
    const copied = await copyToTab(outcome.tabId, result.markdown);
    flashBadge("!", "#9a6700");
    showPageNotice(
      outcome.tabId,
      copied
        ? "Decant: this chat takes no file attachments — the page's Markdown is on your clipboard, paste it into the composer."
        : "Decant: this chat takes no file attachments, and the clipboard copy failed — capture again once this tab is focused.",
      copied ? "info" : "error"
    );
    showPageNotice(
      tab.id,
      copied
        ? `Decant: ${targetName} takes no file attachments — the page's Markdown is on your clipboard instead.`
        : `Decant: ${targetName} takes no file attachments, and the clipboard copy failed — see that tab.`,
      copied ? "info" : "error"
    );
    console.warn(TAG, `no usable input on ${target.host} — clipboard fallback${copied ? "" : " ALSO failed"}`);
  } else {
    flashBadge("!", "#b3261e");
    showPageNotice(
      tab.id,
      `Decant: captured, but couldn't deliver to ${target.host} — ${outcome.reason}`,
      "error"
    );
    console.warn(TAG, `delivery to ${target.host} failed: ${outcome.reason}`);
  }
}

browser.action.onClicked.addListener((tab) => runCapture(tab, null));
browser.contextMenus.onClicked.addListener((info, tab) => {
  // The checkbox item is a setting, not a capture: persist the new state (the
  // config change triggers syncMenus, which re-renders the checkmark; the
  // options page toggle stays in step the same way).
  if (info.menuItemId === FIGURES_MENU_ID) {
    loadConfig()
      .then((c) => saveConfig({ ...c, capture: { ...c.capture, figures: info.checked === true } }))
      .catch((err) => console.warn(TAG, "couldn't save figures toggle:", err));
    return;
  }
  const host = hostFromMenuId(info.menuItemId);
  if (host) runCapture(tab, host);
});
browser.commands.onCommand.addListener(async (command, tab) => {
  if (command !== "capture-page") return;
  // Firefox only passes `tab` here since FF 126 and our floor is 121 — an
  // absent tab resolves to the focused one (same tab the gesture targeted).
  const target =
    tab ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0];
  runCapture(target, null);
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
