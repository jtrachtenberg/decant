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
2. `echo "127.0.0.1 claude.ai" >> /etc/hosts`, then serve a fake composer page
   on **port 80** (`python3 -m http.server 80`). The page needs whatever the
   change touches: an `<input type=file>`, a `contenteditable` composer, a
   button with `aria-label="Send message"`.
3. Drive with `playwright-core` (`chromium.launchPersistentContext`) using
   `executablePath: "/opt/pw-browsers/chromium"`, `headless: false` plus args
   `--headless=new --no-sandbox --disable-extensions-except=<dist>
   --load-extension=<dist> --proxy-server=direct://`.
4. Extension id: `new URL(ctx.serviceWorkers()[0].url()).host`; options page is
   `chrome-extension://<id>/options/options.html`. Storage ground truth:
   `worker.evaluate(() => chrome.storage.local.get(...))`.
5. `page.setInputFiles` fires a **trusted** change event, so the intercept
   picks it up; `page.keyboard`/`page.click` are trusted too. Generate a test
   PDF with `pdf-lib` (3 pages of drawn text converts cleanly, meta `3p`).

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
