// Decant — passthrough hotkey.
//
// A keyboard shortcut arms a one-shot "send the next upload untouched" state:
// the next intercepted file upload skips conversion and the original is sent
// as-is, regardless of how it would be classified. A badge shows while armed;
// the state is consumed by the next upload, Escape, or a second press.
//
// The binding lives in config (editable from the options page).

import { showPassthroughBadge } from "./ui.js";
import { loadConfig, onConfigChanged } from "../config/config.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

const TAG = "[decant]";

// Current binding, kept in sync with the config (editable from the options
// page). Default is Alt+Shift+O ("O" for Original): Alt+Shift avoids Chrome
// access keys (Alt+key) and common browser combos, and won't fire while typing.
// `code` is physical-key based, so it's keyboard-layout independent.
//
// null until the stored binding loads: a keydown in that window can't safely
// match — the user may have rebound the key, and matching the default there
// means a custom binding is briefly inert while the default briefly works.
// Only a *failed* load falls back to the default.
let hotkey = null;

// Auto-disarm timeout — disabled for now, so the armed state persists until it
// is used or cancelled. To restore, uncomment ARMED_TIMEOUT_MS and the `timer`
// lines in arm() and disarm().
// const ARMED_TIMEOUT_MS = 20000;

let armed = false;
// let timer = null;
let badge = null;

function disarm() {
  armed = false;
  // clearTimeout(timer);
  // timer = null;
  badge?.remove();
  badge = null;
}

function arm() {
  armed = true;
  // clearTimeout(timer);
  // timer = setTimeout(() => {
  //   console.log(TAG, "passthrough hotkey timed out");
  //   disarm();
  // }, ARMED_TIMEOUT_MS);
  badge?.remove();
  badge = showPassthroughBadge(disarm);
  console.log(TAG, "passthrough armed — next upload will be sent as-is");
}

// Returns true (and clears the armed state) when the next upload should bypass
// conversion. Called by the intercept handlers before they do any work.
export function consumePassthrough() {
  if (!armed) return false;
  disarm();
  return true;
}

function matches(e) {
  return (
    !!hotkey &&
    e.code === hotkey.code &&
    e.altKey === hotkey.alt &&
    e.shiftKey === hotkey.shift &&
    e.ctrlKey === hotkey.ctrl &&
    e.metaKey === hotkey.meta
  );
}

export function installPassthroughHotkey() {
  // Load the binding from config, and follow later edits from the options page.
  loadConfig()
    .then((c) => (hotkey = c.hotkey))
    .catch(() => (hotkey = DEFAULT_CONFIG.hotkey));
  onConfigChanged((c) => (hotkey = c.hotkey));

  document.addEventListener(
    "keydown",
    (e) => {
      if (!e.isTrusted) return; // ignore page-synthesized key events
      if (matches(e)) {
        e.preventDefault();
        e.stopPropagation();
        armed ? disarm() : arm();
      } else if (e.key === "Escape" && armed) {
        disarm();
      }
    },
    true
  );
}
