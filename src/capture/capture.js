// Background-side capture orchestration (SPEC §3.11, ADR 0023).
//
// Injection is two steps by necessity: a `files:` injection returns nothing
// (verified — esbuild's IIFE completion value is discarded), so the bundle is
// injected to define its global and a tiny `func:` then calls it and returns
// the payload. Injected results are JSON-ish, not structured-cloned — typed
// arrays and Maps arrive as `{}` — so everything that crosses is a plain
// string/number/object.

import { browser } from "../browser.js";

export const CAPTURE_SCRIPT = "capture/inject.js";

// Pages the injector can never run on: browser-internal schemes and the
// extension gallery, where scripting is blocked regardless of activeTab.
// Reported as a friendly reason rather than an opaque injection failure.
const BLOCKED_SCHEMES = /^(chrome|edge|about|moz-extension|chrome-extension|view-source|devtools):/i;
const BLOCKED_HOSTS = /^https:\/\/(chromewebstore\.google\.com|chrome\.google\.com\/webstore|addons\.mozilla\.org)/i;

export function captureBlockedReason(url = "") {
  if (BLOCKED_SCHEMES.test(url)) return "browser-internal pages can't be captured";
  if (BLOCKED_HOSTS.test(url)) return "the extension gallery can't be captured";
  return null;
}

// Filename for the captured page. The title is what a user recognises in an
// attachment list; characters no filesystem or uploader accepts are replaced,
// and a titleless page falls back to its hostname. Pure — unit-tested.
export function captureFileName(title, url) {
  const cleaned = (title || "")
    .replace(/[\\/:*?"<>|]+/g, "-") // illegal on Windows, awkward everywhere
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 60)
    .trim();
  if (cleaned) return `${cleaned}.md`;
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    host = "";
  }
  return `${host || "page"}.md`;
}

// Capture one tab. Resolves to the injected payload — { ok: true, title, url,
// decision, reason, summary, markdown, figures? } — or { ok: false, error }
// for anything that went wrong, including a refused injection. Never throws:
// every caller is a user gesture that must end in a reportable outcome.
// `opts.figures` asks the page side to also collect content images.
export async function capturePage(tabId, url = "", opts = {}) {
  const blocked = captureBlockedReason(url);
  if (blocked) return { ok: false, error: blocked };
  try {
    await browser.scripting.executeScript({
      target: { tabId },
      files: [CAPTURE_SCRIPT],
    });
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      // The capture global is async (figure fetches) — executeScript resolves
      // a returned Promise before reporting the result.
      func: (o) =>
        globalThis.__decantCapture?.(o) ?? {
          ok: false,
          error: "capture script did not load",
        },
      args: [{ figures: opts.figures === true }],
    });
    const payload = res?.result;
    if (!payload) return { ok: false, error: "capture returned no result" };
    if (payload.ok && !payload.markdown) {
      // The engine's own passthrough verdict — a gallery/app page with no
      // prose. Surfaced as a reason, not an error.
      return { ...payload, ok: false, error: `nothing to convert (${payload.reason})` };
    }
    return payload;
  } catch (err) {
    return { ok: false, error: String(err?.message || err) };
  }
}
