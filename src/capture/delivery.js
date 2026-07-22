// Wire protocol for capture delivery — background ↔ chat-tab content script.
//
// Two messages: a PING the background retries until the target tab's content
// script answers (the cold-tab handshake — tabs.sendMessage rejects while no
// listener exists yet), and a DELIVER carrying the captured files. Both ends
// import this module so the shapes can't drift (the relay.js pattern).
//
// Runtime messaging JSON-serializes, so a delivered file crosses as
// { name, type, text } for Markdown or { name, type, data(base64) } for
// binary figures, and is rebuilt into a File on the content side.

import { base64ToBuffer } from "../convert/codec.js";
import { MAX_RELAY_BYTES } from "../convert/relay.js";

export const CAPTURE_PING_MSG = "decant:capture-ping";
export const CAPTURE_DELIVER_MSG = "decant:capture-deliver";

// One page.md plus a handful of figures — anything past this is a malformed
// or hostile message, not a capture.
export const MAX_DELIVER_FILES = 8;

// Content scripts can't take the sender's word for anything: validate the
// shape hard and rebuild real Files, or throw (the caller reports the reason
// back to the background). Size is re-checked here — the sender's cap is not
// load-bearing.
export function deliveredFiles(msg) {
  const wires = msg?.files;
  if (!Array.isArray(wires) || wires.length === 0) throw new Error("no files in delivery");
  if (wires.length > MAX_DELIVER_FILES) throw new Error("too many files in delivery");
  let total = 0;
  return wires.map((w) => {
    if (!w || typeof w.name !== "string" || !w.name || typeof w.type !== "string") {
      throw new Error("malformed delivered file");
    }
    let content;
    if (typeof w.text === "string") {
      content = w.text;
      total += w.text.length;
    } else if (typeof w.data === "string") {
      content = base64ToBuffer(w.data);
      total += content.byteLength;
    } else {
      throw new Error("delivered file has no content");
    }
    if (total > MAX_RELAY_BYTES) throw new Error("delivery exceeds size cap");
    return new File([content], w.name.slice(0, 128), { type: w.type });
  });
}
