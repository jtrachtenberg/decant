// Cross-browser WebExtension API namespace.
//
// Firefox exposes the standard, promise-based `browser.*`; Chromium browsers
// (Chrome, Brave, Edge) expose `chrome.*`. Every MV3 API Decant touches —
// permissions, scripting, storage, runtime messaging — already returns a
// promise under Chrome MV3 and natively under Firefox's `browser`, so a plain
// namespace alias is enough: no callback-to-promise polyfill is required.
// Preferring `browser` keeps Firefox off its own callback-style `chrome.*`.
//
// Resolves to `undefined` under Node (neither global exists). That's safe:
// the modules importing this only reach the API from browser-only call paths,
// never at import time, so the Node unit tests still load them cleanly.
export const browser = globalThis.browser ?? globalThis.chrome;
