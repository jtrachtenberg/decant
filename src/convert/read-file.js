// Reads of the intercepted, page-owned File that work on Firefox.
//
// The attached File belongs to the PAGE's realm (a Firefox content script runs
// in a separate compartment). Two consequences, both handled here:
//
//   1. Realm: reading a page-owned blob hands back an ArrayBuffer from another
//      realm, so `x instanceof ArrayBuffer` FAILS in strict consumers such as
//      pdf-lib (which then reports the value's type as "NaN"). Text-extraction
//      tolerated it only because inbrowser.js re-wraps the bytes in a fresh
//      Uint8Array. sameRealm() below copies any foreign buffer into a
//      content-script-realm ArrayBuffer so every consumer sees a native one.
//      Chrome/Node reads are already same-realm, so the `instanceof` guard makes
//      it a zero-copy passthrough there.
//
//   2. Should a page-owned blob's native .arrayBuffer() ever throw (e.g.
//      a stricter Firefox build routing the read through the cross-compartment
//      byte-stream path — bug 1757836 / pdf.js#15556), we fall back to breaking
//      the wrapper chain with an object URL: URL.createObjectURL hands back a
//      plain string, and fetch()ing it yields a fresh, content-script-owned
//      Response. Native-first keeps the Chrome path a plain arrayBuffer() read.

export async function fileBytes(blob) {
  try {
    return sameRealm(await blob.arrayBuffer());
  } catch (err) {
    return readViaObjectUrl(blob, err);
  }
}

// Return a content-script-realm ArrayBuffer. Same-realm inputs (Chrome/Node)
// pass through untouched; foreign-realm buffers (Firefox page blobs) are copied.
function sameRealm(buf) {
  if (buf instanceof ArrayBuffer) return buf;
  const src = new Uint8Array(buf);
  const out = new Uint8Array(src.length);
  out.set(src);
  return out.buffer;
}

async function readViaObjectUrl(blob, cause) {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
    throw cause; // no object-URL escape hatch here — surface the original error
  }
  const url = URL.createObjectURL(blob);
  try {
    const res = await fetch(url); // read the body before revoking in finally
    return sameRealm(await res.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}
