// Capture target resolution (SPEC §3.11): which chat gets the captured page.
//
// Resolution order — forced pick → open eligible-host tab with max
// lastAccessed → stored last-injected host → first eligible site. Callers
// pass enabled ∩ GRANTED hosts (background's permittedHosts): only granted
// hosts carry the registered content script, and a target that can't answer
// the delivery ping would hang the capture for the full ping timeout. (An
// ungranted host's tab can even be query-visible via a stray activeTab grant
// — live-QA'd on kimi — so the grant filter can't be left to the query.)
// Verified in phase 0: URL-pattern tabs.query works under the host
// permissions we already hold, and lastAccessed (Chrome 121+/Firefox) is
// present ungated and tracks focus order.

import { browser } from "../browser.js";
import { hostOf, hostPattern } from "../config/defaults.js";
import { loadLastTarget } from "./last-target.js";

// Pure ranking over already-queried tabs — exported for direct unit testing.
// `tabs` is chrome Tab objects (id, url, lastAccessed) already limited to
// eligible hosts by the query; `enabled` is the config-ordered eligible list.
// Returns { host, tabId (null = must create), via (for the log line) },
// or null when no target exists at all.
export function pickTarget({ tabs = [], enabled = [], forcedHost = null, storedHost = null }) {
  const newest = (ts) =>
    ts.reduce(
      (best, t) => ((t.lastAccessed ?? 0) > (best?.lastAccessed ?? -1) ? t : best),
      null
    );
  if (forcedHost) {
    // The picker menu is built from the enabled list, so the host is trusted;
    // reuse its most recent open tab when there is one.
    const tab = newest(tabs.filter((t) => hostOf(t.url) === forcedHost));
    return { host: forcedHost, tabId: tab?.id ?? null, via: "picked" };
  }
  const tab = newest(tabs);
  if (tab) return { host: hostOf(tab.url), tabId: tab.id, via: "open tab" };
  if (storedHost && enabled.includes(storedHost)) {
    return { host: storedHost, tabId: null, via: "last injected" };
  }
  if (enabled.length) return { host: enabled[0], tabId: null, via: "first enabled" };
  return null;
}

// Query + rank. The query needs no "tabs" permission: URL-pattern matching
// runs under the enabled hosts' own host permissions (spike-verified), and a
// host enabled but never granted simply can't match an open tab.
export async function resolveTarget(enabled, forcedHost = null) {
  let tabs = [];
  if (enabled.length) {
    try {
      tabs = await browser.tabs.query({ url: enabled.map(hostPattern) });
    } catch (err) {
      // A malformed pattern (hand-edited host) must not kill the capture —
      // fall through to the stored/first-enabled tiers.
      console.warn("[decant bg] target tab query failed:", err);
    }
  }
  return pickTarget({ tabs, enabled, forcedHost, storedHost: await loadLastTarget() });
}
