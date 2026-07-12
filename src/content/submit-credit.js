// Credit conversions to the lifetime savings counter only when the message is
// actually SENT. Conversion happens at attach time, but an attached file can
// sit in the composer and never go anywhere — counting at injection would
// inflate the total with abandoned drafts. So an injected batch's estimate is
// held per-tab as *pending* credit, and flushed to storage only when a send
// signal fires.
//
// "The form was submitted" has no single event on these SPAs (claude.ai and
// ChatGPT send from a contenteditable composer, not a <form> submit), so three
// capture-phase, trusted-only signals cover the ways a message goes out:
//   - a real `submit` event, for sites that do use a form;
//   - Enter (no Shift, not IME composition) inside a contenteditable/textarea
//     composer;
//   - a click on a submit-type button or one labeled "send" (claude.ai "Send
//     message", ChatGPT aria-label "Send prompt" / data-testid "send-button",
//     Gemini "Send message").
// Heuristic by necessity: if the user detaches the converted file and sends a
// plain message, that send still flushes the pending credit. The counter is a
// labeled estimate, so erring on that side beats site-specific DOM watching.
//
// Listeners install lazily on the first credit, so tabs that never convert
// anything add no handlers.

import { addTokensSaved } from "../config/stats.js";

const TAG = "[decant]";

let pending = 0;
let installed = false;

// Arm `tokens` of pending credit; it lands in the lifetime counter on the next
// send signal. Called after a converted batch was successfully injected.
export function creditOnSubmit(tokens) {
  if (!(typeof tokens === "number" && tokens > 0)) return;
  pending += tokens;
  install();
}

function flush() {
  if (!pending) return;
  const tokens = pending;
  pending = 0;
  addTokensSaved(tokens); // fire-and-forget; failures logged inside
  console.log(TAG, `message sent → ~${tokens} tokens added to lifetime savings`);
}

const inComposer = (el) =>
  el instanceof Element &&
  !!el.closest('[contenteditable="true"], textarea');

function isSendButton(el) {
  if (!(el instanceof Element)) return false;
  const btn = el.closest('button, input[type="submit"]');
  if (!btn) return false;
  if (btn.type === "submit") return true;
  const label = `${btn.getAttribute("aria-label") || ""} ${btn.getAttribute("data-testid") || ""}`;
  return /send/i.test(label);
}

function install() {
  if (installed) return;
  installed = true;
  document.addEventListener(
    "submit",
    (ev) => {
      if (ev.isTrusted) flush();
    },
    true
  );
  document.addEventListener(
    "keydown",
    (ev) => {
      if (!ev.isTrusted || ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
      if (inComposer(ev.target)) flush();
    },
    true
  );
  document.addEventListener(
    "click",
    (ev) => {
      if (ev.isTrusted && isSendButton(ev.target)) flush();
    },
    true
  );
}
