// Decant — picker-bridge protocol between the MAIN-world shim and the
// isolated-world pipeline (ADR 0019).
//
// A detached file picker (createElement'd <input type=file>, .click()'ed,
// never appended — kimi.com's pattern) fires its change event on the element
// only: a disconnected node has no ancestor chain, so nothing reaches the
// window-capture listeners in intercept.js. The main-world shim
// (main-world.js) catches those picks at the element and relays them here
// over window.postMessage; the converted result rides the same channel back.
//
// This module is the protocol: message constructors and validators shared by
// both bundles (each esbuild entry inlines its own copy). Pure — no DOM, no
// chrome.* — so it unit-tests in node.
//
// Trust model: window.postMessage is page-visible and page-forgeable. That is
// acceptable by design — every payload is a file the page already holds (a
// pick the page initiated, or a conversion of one), so a forged message can
// only make Decant convert the page's own data and hand it back. Validators
// still shape-check hard so junk can't reach the pipeline, and receivers must
// additionally require ev.source === window && ev.origin === location.origin.

export const CHANNEL = "decant-picker-bridge";

export const MSG = {
  // isolated → main: pipeline listening; arms the shim. Until this arrives the
  // shim lets picks through natively — the failure mode of a missing pipeline
  // must be "no conversion", never a swallowed upload.
  READY: "ready",
  // main → isolated: user picked files into a detached input (id keys the reply).
  PICK: "pick",
  // isolated → main: substitute these files into the pending input, then
  // dispatch change so the site's own handler reads them.
  INJECT: "inject",
  // isolated → main: dispatch change with the input's original files untouched
  // (passthrough hotkey, or a pipeline failure falling back to the native path).
  RELEASE: "release",
};

export function bridgeMsg(type, fields = {}) {
  return { channel: CHANNEL, type, ...fields };
}

export function isBridgeMsg(data, type) {
  return !!data && typeof data === "object" && data.channel === CHANNEL && data.type === type;
}

// The File objects a bridge message carries, dropping anything that isn't one.
// postMessage structured-clones Files cheaply (blob backing is shared, not
// copied), and the clones arrive as the receiving realm's File instances.
export function bridgeFiles(data) {
  return Array.isArray(data?.files) ? data.files.filter((f) => f instanceof File) : [];
}
