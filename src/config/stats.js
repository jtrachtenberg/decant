// Lifetime token-savings counter. Separate from the config on purpose: the
// config is user-edited settings in storage.sync (synced, 8KB/item quota),
// while this is machine-written telemetry that grows with every sent upload —
// putting it in the config would churn sync quota and make every increment a
// full config write. It lives under its own key in storage.local instead:
// device-local, no quota pressure, and a malformed value just renormalizes
// to zero rather than taking the config down with it.

import { browser } from "../browser.js";

const KEY = "decantStats";

// Normalize a stored value to the current shape. Pure and exported for tests.
// The counter must come back a non-negative finite integer no matter what a
// hand-edited or corrupted store holds.
export function normalizeStats(stored) {
  const n = stored && typeof stored === "object" ? stored.totalTokensSaved : 0;
  return {
    totalTokensSaved:
      typeof n === "number" && Number.isFinite(n) && n > 0 ? Math.round(n) : 0,
  };
}

export async function loadStats() {
  const got = await browser.storage.local.get(KEY);
  return normalizeStats(got[KEY]);
}

// Increments from this context are chained so two quick sends can't interleave
// their read-modify-write and drop one. (Two *tabs* incrementing in the same
// instant can still race — storage.local has no transactions — but losing one
// estimate in that corner is acceptable for a motivational counter.)
let writeChain = Promise.resolve();

// Add to the lifetime total. Non-positive / non-numeric amounts are ignored.
// Returns a promise that settles when this increment has been persisted;
// callers may fire-and-forget (failures are logged, never thrown).
export function addTokensSaved(tokens) {
  const add = typeof tokens === "number" && Number.isFinite(tokens) ? Math.round(tokens) : 0;
  if (add <= 0) return writeChain;
  writeChain = writeChain.then(async () => {
    try {
      const stats = await loadStats();
      stats.totalTokensSaved += add;
      await browser.storage.local.set({ [KEY]: stats });
    } catch (err) {
      console.warn("[decant] savings counter update failed:", err);
    }
  });
  return writeChain;
}

export async function resetStats() {
  await browser.storage.local.set({ [KEY]: normalizeStats(null) });
}

// Subscribe to stats changes (e.g. so the options page updates live while a
// chat tab keeps saving). Returns an unsubscribe function.
export function onStatsChanged(callback) {
  const listener = (changes, area) => {
    if (area === "local" && changes[KEY]) {
      callback(normalizeStats(changes[KEY].newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
