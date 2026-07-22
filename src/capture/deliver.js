// Background-side capture delivery (SPEC §3.11): get the converted page into
// the target chat tab's composer, loudly reporting anything that goes wrong —
// the failure surface here is off-screen, in a tab the user isn't watching.
//
// Sequence: ensure a target tab exists (focused create for cold targets — a
// backgrounded SPA may throttle its composer mount) → retry a PING until the
// tab's content script answers (cold tabs have no listener for a while;
// sendMessage rejects until one exists) → send the files → the content side
// waits for a usable input and injects. Warm tabs are deliberately NOT
// focused until delivery succeeds: if the site turns out to have no usable
// input, the user's context hasn't been yanked for nothing.

import { browser } from "../browser.js";
import { CAPTURE_PING_MSG, CAPTURE_DELIVER_MSG } from "./delivery.js";

const PING_INTERVAL_MS = 250;
const PING_TIMEOUT_MS = 30000;
// How long the content side polls for a usable file input before giving up.
// Cold tabs cover a slow SPA composer mount (claude.ai measured ~3s+ after
// load); warm tabs answer almost immediately when an input exists at all, so
// a short window keeps the no-input fallback (Gemini/kimi) snappy.
const COLD_INPUT_WAIT_MS = 20000;
const WARM_INPUT_WAIT_MS = 4000;

async function ping(tabId) {
  try {
    const res = await browser.tabs.sendMessage(tabId, { type: CAPTURE_PING_MSG });
    return res?.ok === true;
  } catch {
    return false; // no listener yet — the normal cold-tab state
  }
}

async function waitForContentScript(tabId) {
  const t0 = Date.now();
  while (Date.now() - t0 < PING_TIMEOUT_MS) {
    if (await ping(tabId)) return true;
    await new Promise((r) => setTimeout(r, PING_INTERVAL_MS));
  }
  return false;
}

export async function focusTab(tabId) {
  try {
    const tab = await browser.tabs.update(tabId, { active: true });
    if (tab?.windowId != null) await browser.windows.update(tab.windowId, { focused: true });
  } catch (err) {
    console.warn("[decant bg] couldn't focus target tab:", err);
  }
}

// Deliver wire-form files to a resolved target. Returns
//   { ok: true,  tabId }                     — injected; tab has been focused
//   { ok: false, tabId?, reason, noInput? }  — every failure mode, named
export async function deliverCapture(target, wireFiles) {
  let tabId = target.tabId;
  let cold = false;
  if (tabId == null) {
    try {
      const tab = await browser.tabs.create({ url: `https://${target.host}/`, active: true });
      tabId = tab.id;
      cold = true;
    } catch (err) {
      return { ok: false, reason: `couldn't open ${target.host}: ${err.message}` };
    }
  }

  if (!(await waitForContentScript(tabId))) {
    // Registered content scripts need the host's permission grant — an
    // enabled-but-never-granted host times out exactly here.
    return {
      ok: false,
      tabId,
      reason: `${target.host} never answered — is Decant enabled (and granted) for it?`,
    };
  }

  let res;
  try {
    res = await browser.tabs.sendMessage(tabId, {
      type: CAPTURE_DELIVER_MSG,
      files: wireFiles,
      waitMs: cold ? COLD_INPUT_WAIT_MS : WARM_INPUT_WAIT_MS,
      // Cold tabs additionally settle after the input appears: a file input
      // present in pre-hydration HTML (copilot) is deaf until the app binds
      // its handlers — injecting into it "succeeds" and loses the files.
      cold,
    });
  } catch (err) {
    return { ok: false, tabId, reason: String(err?.message || err) };
  }

  if (res?.ok) {
    if (!cold) await focusTab(tabId); // cold tabs were created focused
    return { ok: true, tabId };
  }
  const reason = res?.reason || "delivery failed";
  return { ok: false, tabId, reason, noInput: reason === "no-input" };
}

// Copy text to the clipboard of a (focused) tab. navigator.clipboard needs a
// focused document, and the service worker hasn't got a document at all — so
// the write runs inside the tab. Returns whether it succeeded.
export async function copyToTab(tabId, text) {
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      func: (t) => navigator.clipboard.writeText(t).then(() => true, () => false),
      args: [text],
    });
    return res?.result === true;
  } catch {
    return false;
  }
}

// On-page notice pill, injected wherever we can script — the target chat tab
// (host permission) or the capture source (activeTab). Self-contained by
// necessity: executeScript serializes the function, so it can't close over
// anything. Styling matches the ui.js badges; `tone` picks the accent.
export function showPageNotice(tabId, text, tone = "info") {
  return browser.scripting
    .executeScript({
      target: { tabId },
      func: (msg, accent) => {
        const ID = "decant-capture-notice";
        document.getElementById(ID)?.remove();
        const host = document.createElement("div");
        host.id = ID;
        const root = host.attachShadow({ mode: "closed" });
        root.innerHTML = `
          <style>
            .badge {
              position: fixed; top: 16px; right: 16px; z-index: 2147483647;
              display: flex; align-items: center; gap: 8px;
              padding: 8px 12px; border-radius: 8px;
              font: 13px/1.4 system-ui, sans-serif;
              background: #1f1f23; color: #f3f3f3; border: 1px solid ${accent};
              box-shadow: 0 4px 16px rgba(0,0,0,.35);
            }
            .dot { width: 8px; height: 8px; border-radius: 50%; background: ${accent}; flex: none; }
            .msg { max-width: 60vw; }
            .x { background: none; border: none; padding: 0 0 0 4px; font: inherit;
                 color: #9aa0aa; cursor: pointer; }
            .x:hover { color: #fff; }
          </style>
          <div class="badge" role="status">
            <span class="dot"></span><span class="msg"></span>
            <button class="x" type="button" aria-label="Dismiss">✕</button>
          </div>`;
        root.querySelector(".msg").textContent = msg;
        const timer = setTimeout(() => host.remove(), 10000);
        root.querySelector(".x").addEventListener("click", () => {
          clearTimeout(timer);
          host.remove();
        });
        document.body.appendChild(host);
      },
      args: [text, tone === "error" ? "#e05d5d" : "#6b5cff"],
    })
    .catch((err) => console.warn("[decant bg] couldn't show page notice:", err));
}
