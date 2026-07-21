// Decant — MAIN-world shim: make detached file pickers interceptable.
//
// intercept.js sees an upload only when its event reaches window. A detached
// picker — `document.createElement("input")`, `type = "file"`, `.click()`,
// never appended to the DOM (kimi.com's pattern) — fires change on the
// element alone: no ancestors, no propagation, no isolated-world visibility.
// Confirmed live on www.kimi.com (change fired with isConnected === false).
//
// So this shim runs in the page's own world (registered with world: "MAIN" at
// document_start, before any page script) and hooks the inputs at their
// source: Document.prototype.createElement is patched to bind a capture
// change listener on every <input> it returns. Binding at creation makes us
// unconditionally first in the element's listener list — the page can only
// attach its own handlers after createElement returns — so
// stopImmediatePropagation() in our listener blocks every page handler
// (addEventListener and .onchange alike; a property handler joins the list at
// first assignment, after us). The prototype (not the document instance) is
// patched so `Document.prototype.createElement.call(document, …)` framework
// idioms hit it too.
//
// The pipeline stays in the isolated world (it needs chrome.runtime, workers,
// storage). This shim only relays: on a detached pick it blocks the page's
// handlers and posts the files over the bridge (bridge.js); the reply either
// substitutes converted files into the same input (INJECT) or leaves the
// originals (RELEASE); both then dispatch a synthetic change so the page's
// own handler finally runs and reads whatever the input now holds. The
// synthetic dispatch can't loop: our listener requires isTrusted, which also
// ignores the sentinel changes intercept.js dispatches on *connected* inputs
// (expando sentinels don't cross worlds; isTrusted does).
//
// Connected inputs are explicitly not this shim's business (isConnected →
// return): their change reaches window, where intercept.js either intercepts
// (stopImmediatePropagation — our listener never runs) or deliberately
// declines (passthrough armed), and declining must mean the native path
// proceeds. The shim likewise stands down entirely until the pipeline
// announces itself (READY) — if the isolated script is missing, picks must
// flow natively rather than vanish into an unanswered bridge.
//
// Known residuals, accepted: inputs minted without createElement (innerHTML,
// cloneNode, createElementNS) aren't hooked, and a page reading .files in a
// non-change callback (dialog-close polling) bypasses the block. No observed
// site does either; revisit per-site if QA finds one.

import { MSG, bridgeMsg, isBridgeMsg, bridgeFiles } from "./bridge.js";

const TAG = "[decant]";

let pipelineReady = false;
let nextId = 1;
// id → detached <input> awaiting its bridge reply. Entries never expire: a
// reply can legitimately take minutes (large PDF, or the ambiguous prompt
// waiting on the user), and the pipeline answers every pick — queueInject's
// failure path RELEASEs (see intercept.js) — so entries can't accumulate.
const pending = new Map();

const nativeCreateElement = Document.prototype.createElement;
Document.prototype.createElement = function (...args) {
  const el = nativeCreateElement.apply(this, args);
  // Bind on every input, filter at fire time: whether it's a *file* input is
  // only knowable later (type is set after creation), and a change listener
  // on a text input that instantly returns costs nothing.
  if (el instanceof HTMLInputElement) {
    el.addEventListener("change", onPickerChange, true);
  }
  return el;
};

function onPickerChange(ev) {
  const input = ev.currentTarget;
  if (!ev.isTrusted) return; // synthetic (ours or the page's) — never intercept
  if (input.type !== "file") return;
  if (input.isConnected) return; // connected inputs belong to intercept.js
  if (!pipelineReady) return; // no pipeline listening — let the pick flow natively
  if (!input.files || input.files.length === 0) return;

  const files = Array.from(input.files);
  ev.stopImmediatePropagation();
  const id = nextId++;
  pending.set(id, input);
  console.log(TAG, "detached picker pick:", files.map((f) => f.name));
  window.postMessage(bridgeMsg(MSG.PICK, { id, files }), location.origin);
}

window.addEventListener("message", (ev) => {
  if (ev.source !== window || ev.origin !== location.origin) return;
  const data = ev.data;
  if (isBridgeMsg(data, MSG.READY)) {
    pipelineReady = true;
    return;
  }
  const inject = isBridgeMsg(data, MSG.INJECT);
  if (!inject && !isBridgeMsg(data, MSG.RELEASE)) return;
  const input = pending.get(data.id);
  if (!input) return;
  pending.delete(data.id);

  if (inject) {
    const files = bridgeFiles(data);
    if (files.length) {
      const dt = new DataTransfer();
      for (const f of files) dt.items.add(f);
      input.files = dt.files;
    }
  }
  // Fire the page's own handlers — blocked at pick time — so the site attaches
  // whatever the input now holds (substituted on INJECT, original on RELEASE).
  // bubbles mirrors a real change in case the page connected the input since;
  // if it did, the isolated window listener skips this (isTrusted false).
  input.dispatchEvent(new Event("change", { bubbles: true }));
});

console.log(TAG, "picker shim installed (main world)");
