// chrome.storage wrapper over the Decant config. Thin on purpose: all the
// shape logic lives in defaults.js (pure, testable); this just persists and
// notifies. Config lives in storage.sync so it follows the user across Chrome.

import { normalizeConfig } from "./defaults.js";

const KEY = "decantConfig";

export async function loadConfig() {
  const got = await chrome.storage.sync.get(KEY);
  return normalizeConfig(got[KEY]);
}

export async function saveConfig(config) {
  await chrome.storage.sync.set({ [KEY]: normalizeConfig(config) });
}

// Subscribe to config changes (e.g. edits from the options page). Returns an
// unsubscribe function.
export function onConfigChanged(callback) {
  const listener = (changes, area) => {
    if (area === "sync" && changes[KEY]) {
      callback(normalizeConfig(changes[KEY].newValue));
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
