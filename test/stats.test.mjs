// Unit tests for the lifetime savings counter (src/config/stats.js).
//
//   node --test   (npm test)
//
// stats.js reaches storage through src/browser.js, which resolves the
// `browser`/`chrome` namespace at import time — so the fake chrome.storage
// must exist BEFORE the dynamic import below.

import { test } from "node:test";
import assert from "node:assert/strict";

const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        return { [key]: store[key] };
      },
      async set(obj) {
        Object.assign(store, obj);
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

const { normalizeStats, loadStats, addTokensSaved, resetStats } = await import(
  "../src/config/stats.js"
);

test("normalizeStats renormalizes any garbage to a non-negative integer", () => {
  assert.deepEqual(normalizeStats(undefined), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats("nonsense"), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({}), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: "12" }), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: -5 }), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: NaN }), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: Infinity }), { totalTokensSaved: 0 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: 1234.6 }), { totalTokensSaved: 1235 });
  assert.deepEqual(normalizeStats({ totalTokensSaved: 42 }), { totalTokensSaved: 42 });
});

test("addTokensSaved accumulates and persists; junk amounts are ignored", async () => {
  await resetStats();
  await addTokensSaved(500);
  await addTokensSaved(1500);
  await addTokensSaved(0);
  await addTokensSaved(-100);
  await addTokensSaved(NaN);
  await addTokensSaved("50");
  assert.deepEqual(await loadStats(), { totalTokensSaved: 2000 });
});

test("unawaited increments serialize — none is lost to a stale read", async () => {
  await resetStats();
  addTokensSaved(100);
  addTokensSaved(200);
  await addTokensSaved(300);
  assert.deepEqual(await loadStats(), { totalTokensSaved: 600 });
});

test("resetStats zeroes the counter", async () => {
  await addTokensSaved(999);
  await resetStats();
  assert.deepEqual(await loadStats(), { totalTokensSaved: 0 });
});
