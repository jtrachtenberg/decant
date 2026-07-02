// File ↔ wire form for the content↔background message relay.
//
// http/companion conversions must fetch from the background service worker:
// content-script fetches run under the page's CORS rules, background fetches
// use the extension's host permissions. chrome.runtime messaging
// JSON-serializes, so a File crosses as { name, type, data(base64) } and is
// rebuilt on the other side. Both background.js and convert/index.js import
// these so the two ends can't drift.

import { bufferToBase64, base64ToBuffer } from "./codec.js";

export const HTTP_CONVERT_MSG = "decant:http-convert";

// Message-size guard: base64 inflates by ~4/3 and Chrome caps runtime
// messages around 64 MB, so cap the raw file well below that. A document
// over this size isn't a sane conversion candidate anyway.
export const MAX_RELAY_BYTES = 32 * 1024 * 1024;

export async function fileToWire(file) {
  return {
    name: file.name,
    type: file.type || "application/octet-stream",
    data: bufferToBase64(await file.arrayBuffer()),
  };
}

export function wireToFile(wire) {
  return new File([base64ToBuffer(wire.data)], wire.name, { type: wire.type });
}
