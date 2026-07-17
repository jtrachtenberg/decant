---
name: verify
description: Drive the built Decant extension end-to-end in headless Chromium against a fake chat page served as claude.ai.
---

# Verifying Decant changes at runtime

Decant is an MV3 extension; its surfaces are the content script on an enabled
chat host and the options page. Both can be driven for real, headless, with no
account login, because the manifest's `*://claude.ai/*` host permission also
matches **http** — so a local server impersonating claude.ai gets the real
content script injected.

## Recipe

1. `npm run build` → `dist/`.
2. Point claude.ai at localhost. Linux: `echo "127.0.0.1 claude.ai" >>
   /etc/hosts` and serve on port 80. **Windows (no hosts-file edit needed):**
   launch the browser with `--host-resolver-rules=MAP claude.ai 127.0.0.1`,
   serve on any port, and navigate to `http://claude.ai:<port>/…` — match
   patterns ignore ports, so `*://claude.ai/*` still injects. The page needs
   whatever the change touches: an `<input type=file>`, a `contenteditable`
   composer, a button with `aria-label="Send message"`.
3. Drive with `playwright-core` (`chromium.launchPersistentContext`),
   `headless: false` plus args `--headless=new --no-sandbox
   --disable-extensions-except=<dist> --load-extension=<dist>
   --proxy-server=direct://`. Executable: Linux `/opt/pw-browsers/chromium`;
   **Windows: use Edge** (`C:/Program Files (x86)/Microsoft/Edge/Application/
   msedge.exe`) — branded Chrome ≥ 137 removed `--load-extension` (silently:
   the browser runs, the extension never loads, zero `[decant]` logs), and Edge
   150 still honors it. If Edge ever drops it too, Chrome for Testing is the
   fallback.
4. Extension id: `new URL(ctx.serviceWorkers()[0].url()).host`; options page is
   `chrome-extension://<id>/options/options.html`. Storage ground truth:
   `worker.evaluate(() => chrome.storage.local.get(...))`.
5. `page.setInputFiles` / `fileChooser.setFiles` fire a **trusted** change
   **only when given a real file path** — an in-memory `{name, mimeType,
   buffer}` payload is constructed in page JS and arrives `isTrusted: false`,
   which the intercept (correctly) ignores; the symptom is a silent native
   upload. Write the test file to disk and pass the path. `page.keyboard` /
   `page.click` are trusted. Generate a test PDF with `pdf-lib` (3 pages of
   drawn text converts cleanly, meta `3p`).
6. Detached-picker flows (ADR 0019) are drivable headless: `.click()` on a
   detached input still fires Playwright's `filechooser` event, and
   `chooser.setFiles(path)` lands trusted change events on the detached node.

## Gotchas

- Content-script registration happens in the background's `onInstalled` —
  in a fresh profile, wait ~1.5s (or open the options page first) before
  navigating to claude.ai, or the page loads before registration and nothing
  intercepts.
- Watch `page.on("console")` for `[decant]` lines — they narrate intercept →
  convert → inject and are the fastest signal of where a flow stopped.
- If `npm install` 403s on `cdn.sheetjs.com` (blocked by network policy),
  install deps in a scratch dir with `xlsx@latest` from the npm registry
  substituted, and copy `node_modules` in — nothing is committed.
