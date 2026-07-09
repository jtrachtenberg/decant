// storage.sync wrapper over the Decant config. Thin on purpose: all the
// shape logic lives in defaults.js (pure, testable); this just persists and
// notifies. Config lives in storage.sync so it follows the user across the
// browser's synced profile.

import { browser } from "../browser.js";
import { normalizeConfig } from "./defaults.js";

const KEY = "decantConfig";

export async function loadConfig() {
  const got = await browser.storage.sync.get(KEY);
  return normalizeConfig(got[KEY]);
}

export async function saveConfig(config) {
  await browser.storage.sync.set({ [KEY]: normalizeConfig(config) });
}

// Subscribe to config changes (e.g. edits from the options page). Returns an
// unsubscribe function.
export function onConfigChanged(callback) {
  const listener = (changes, area) => {
    if (area === "sync" && changes[KEY]) {
      callback(normalizeConfig(changes[KEY].newValue));
    }
  };
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
