// ArrayBuffer ↔ base64 helpers, shared by the http engine (base64-json
// request encoding) and the content↔background message relay (Files don't
// survive chrome.runtime messaging, which JSON-serializes).
//
// Encoding is chunked: String.fromCharCode(...bytes) on a whole file blows
// the argument limit / call stack once files reach a few hundred KB.

const CHUNK = 0x8000;

export function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function base64ToBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
