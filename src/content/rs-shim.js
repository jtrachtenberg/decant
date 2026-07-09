// Firefox content-script sandbox detection + ReadableStream shim.
// MUST be imported first (before the pdf.js chain) — see intercept.js.
//
// Firefox content scripts run in a sandboxed compartment with restricted native
// APIs. Two consequences bite Decant:
//
//   1. `new ReadableStream(source)` coerces `source` to the WebIDL
//      UnderlyingSource dictionary, reading its members (start, pull, cancel,
//      autoAllocateChunkSize) off the sandbox object — which the platform is
//      denied, throwing "Permission denied to access property
//      autoAllocateChunkSize" (bug 1757836). pdf.js's worker streaming
//      (MessageHandler.sendWithStream) builds one on every getTextContent /
//      getOperatorList, so text extraction died there (pdf.js#15556). We fix it
//      by swapping in web-streams-polyfill's pure-JS ReadableStream, which reads
//      the source's members as ordinary in-sandbox property access.
//
//   2. pdf.js CANVAS RENDERING (page.render → OffscreenCanvas) hits the same
//      class of denial ("Permission denied to access property constructor") deep
//      in its drawing code, repeatedly, and the render promise never settles —
//      a hang, not a catchable throw. No polyfill covers this, so the figure
//      paths that render (crop detection, page-to-PNG) are skipped in the
//      sandbox; the pdf-lib chart-pages subset (no pdf.js) still runs. See
//      intercept.js's figures branch.
//
// The same signal (native ReadableStream construction fails) marks both, so we
// detect it once and export it. Chrome — and any Firefox that fixes the sandbox
// — construct fine, keep the native stream, and run rendering normally.

import { ReadableStream as JsReadableStream } from "web-streams-polyfill";

function nativeReadableStreamBroken() {
  try {
    new ReadableStream({ start() {} });
    return false;
  } catch {
    return true;
  }
}

// True in the Firefox content-script sandbox; false on Chrome/fixed-FF.
export const restrictedSandbox = nativeReadableStreamBroken();

if (restrictedSandbox) {
  globalThis.ReadableStream = JsReadableStream;
  console.info(
    "[decant] restricted sandbox (Firefox): JS ReadableStream installed; pdf.js rendering disabled"
  );
}
