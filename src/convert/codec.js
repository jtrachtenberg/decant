// ArrayBuffer ↔ base64 helpers, shared by the http engine (base64-json
// request encoding) and the content↔background message relay (Files don't
// survive chrome.runtime messaging, which JSON-serializes).
//
// Where the engine has the native Uint8Array base64 methods (Chrome 140+,
// Firefox 133+) they do the whole conversion in one pass (O5/O7): no binary
// "rope" string, no per-byte loop. Otherwise the fallback is chunked:
// String.fromCharCode(...bytes) on a whole file blows the argument limit /
// call stack once files reach a few hundred KB.

const CHUNK = 0x8000;

const nativeToBase64 = typeof Uint8Array.prototype.toBase64 === "function";
const nativeFromBase64 = typeof Uint8Array.fromBase64 === "function";

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  if (nativeToBase64) return bytes.toBase64();
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(b64) {
  if (nativeFromBase64) {
    const bytes = Uint8Array.fromBase64(b64);
    // fromBase64 may hand back a view; callers want exactly these bytes.
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes.buffer
      : bytes.slice().buffer;
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
