// Converter interface — engine-agnostic entry point the content script calls.
// The routing table decides each intercepted file's fate (SPEC §3.2); this
// module dispatches the routed action to an engine: in-browser (shape A,
// PDF), or http/companion (shapes B/C) via the background relay — the
// engine's fetch must run in the service worker, where the extension's host
// permissions apply instead of the page's CORS. Engine failures honor the
// rule's `onError` (inbrowser or passthrough); an upload is never lost to a
// dead endpoint.
//
// convertFile(file, routing) resolves to one of:
//   { action: "converted",   file, original, reason, meta }  swap in `file`
//   { action: "passthrough", file, reason, meta }            leave `file` as-is
//   { action: "ambiguous",   file, converted, reason, meta } user chooses:
//       `file` is the original (safe default), `converted` is the Markdown.
// `file` is always the safe/default thing to hand the upload; callers that
// support a choice look at `converted`.
//
// The analysis-result → contract mapping lives in result.js (pure, testable).

import { analyzePdf } from "./inbrowser.js";
import { analyzeDocx } from "./docx.js";
import { resultFromAnalysis } from "./result.js";
import { DOCX_MIME } from "../config/defaults.js";
import { routeFile } from "../router/route.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";
import {
  HTTP_CONVERT_MSG,
  MAX_RELAY_BYTES,
  fileToWire,
  wireToFile,
} from "./relay.js";

const TAG = "[decant]";

export async function convertFile(file, routing = DEFAULT_CONFIG.routing) {
  const { action, rule } = routeFile(file, routing);

  if (action === "passthrough") {
    return {
      action: "passthrough",
      file,
      reason: rule ? "routed-passthrough" : "unrouted",
    };
  }

  if (action === "companion" || action === "http") {
    try {
      const converted = await convertViaBackground(file, rule);
      return { action: "converted", file: converted, original: file, reason: action };
    } catch (err) {
      console.warn(
        TAG,
        `${action} conversion failed (${err.message}) — ${rule.onError} fallback for ${file.name}`
      );
      if (rule.onError !== "inbrowser") {
        return { action: "passthrough", file, reason: "engine-error" };
      }
      // fall through to the in-browser engine
    }
  }

  return inbrowser(file);
}

// Relay an http/companion conversion through the background service worker
// (see relay.js for why). Throws on any failure; the caller maps that to the
// rule's onError.
async function convertViaBackground(file, rule) {
  if (file.size > MAX_RELAY_BYTES) {
    throw new Error(`file exceeds relay cap (${file.size} bytes)`);
  }
  const resp = await chrome.runtime.sendMessage({
    type: HTTP_CONVERT_MSG,
    rule,
    file: await fileToWire(file),
  });
  if (!resp?.ok) {
    throw new Error(resp?.error || "no response from background worker");
  }
  return wireToFile(resp.file);
}

// Shape A: the in-browser engines, picked by type — PDF (pdf.js + the
// classifier) and DOCX (mammoth). Anything else routed here passes through
// untouched (SheetJS/PPTX arrive later in M2).
async function inbrowser(file) {
  let engine = null;
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    engine = analyzePdf;
  } else if (file.type === DOCX_MIME || /\.docx$/i.test(file.name)) {
    engine = analyzeDocx;
  }
  if (!engine) {
    return { action: "passthrough", file, reason: "no-engine" };
  }

  let res = null;
  try {
    res = await engine(file);
  } catch (err) {
    console.error(TAG, "analysis failed, passing original through:", err);
  }
  return resultFromAnalysis(file, res);
}
