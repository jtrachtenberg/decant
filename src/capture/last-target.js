// Last-successful-injection host — the cold-start fallback for capture target
// resolution (SPEC §3.11). Open tabs answer "which chat did you use last?"
// via lastAccessed; this answers it when no chat tab is open at all.
//
// Recorded at the injection-success moment (the same signal the savings
// credit keys off): the content script writes its own hostname whenever a
// batch — intercepted or capture-delivered — actually reaches an input.
// storage.local, not sync: it's machine-written state like the stats counter,
// and a stale value on another device would misdirect a capture there.

import { browser } from "../browser.js";

const KEY = "decantLastTarget";

// Fire-and-forget by design: failing to record must never break an injection.
export function recordLastTarget(host) {
  if (typeof host !== "string" || !host) return;
  browser.storage.local
    .set({ [KEY]: { host: host.toLowerCase(), at: Date.now() } })
    .catch((err) => console.warn("[decant] couldn't record last target:", err));
}

// The stored host, or null. Malformed values read as absent.
export async function loadLastTarget() {
  try {
    const got = await browser.storage.local.get(KEY);
    const host = got[KEY]?.host;
    return typeof host === "string" && host ? host : null;
  } catch {
    return null;
  }
}
