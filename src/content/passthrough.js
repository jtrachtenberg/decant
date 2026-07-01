// Decant — passthrough hotkey.
//
// A keyboard shortcut arms a one-shot "send the next upload untouched" state:
// the next intercepted file upload skips conversion and the original is sent
// as-is, regardless of how it would be classified. A badge shows while armed;
// the state is consumed by the next upload, or cleared on a timeout or Escape.
//
// Binding is a constant for now; it moves to the options page / config in M3.

import { showPassthroughBadge } from "./ui.js";

const TAG = "[decant]";

// Default binding: Alt+Shift+O ("O" for Original). Alt+Shift avoids Chrome
// access keys (Alt+key) and common browser combos, and won't fire while typing.
// `code` is physical-key based, so it's keyboard-layout independent.
const HOTKEY = { code: "KeyO", alt: true, shift: true, ctrl: false, meta: false };
const ARMED_TIMEOUT_MS = 20000;

let armed = false;
let timer = null;
let badge = null;

function disarm() {
  armed = false;
  clearTimeout(timer);
  timer = null;
  badge?.remove();
  badge = null;
}

function arm() {
  armed = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    console.log(TAG, "passthrough hotkey timed out");
    disarm();
  }, ARMED_TIMEOUT_MS);
  badge?.remove();
  badge = showPassthroughBadge();
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
    e.code === HOTKEY.code &&
    e.altKey === HOTKEY.alt &&
    e.shiftKey === HOTKEY.shift &&
    e.ctrlKey === HOTKEY.ctrl &&
    e.metaKey === HOTKEY.meta
  );
}

export function installPassthroughHotkey() {
  document.addEventListener(
    "keydown",
    (e) => {
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
