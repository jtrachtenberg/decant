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

import { browser } from "../browser.js";
import { analyzePdf } from "./inbrowser.js";
import { analyzeDocx } from "./docx.js";
import { analyzeXlsx } from "./xlsx.js";
import { analyzePptx } from "./pptx.js";
import { analyzeHtml } from "./html.js";
import { resultFromAnalysis, shouldEscalate } from "./result.js";
import { sizeVerdict } from "./limits.js";
import { DOCX_MIME, XLSX_MIME, XLS_MIME, PPTX_MIME } from "../config/defaults.js";
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

  // In-browser (shape A). If it comes up empty on a file a companion could
  // still crack — a scanned/image-only PDF — and the rule opts into forward
  // escalation, retry against the endpoint (SPEC §3.3). Escalation failing
  // (unconfigured, unreachable, empty) keeps the original passthrough: the file
  // is never lost, and a browser-only user never configures onEmpty so this is
  // inert for them.
  const res = await inbrowser(file);
  // Carry the matched rule on an ambiguous result so the prompt can offer the
  // "convert with companion" choice (and run it) when one is configured.
  if (res.action === "ambiguous") res.rule = rule;
  if (shouldEscalate(res, rule)) {
    try {
      const converted = await convertViaBackground(file, rule);
      return {
        action: "converted",
        file: converted,
        original: file,
        reason: `${rule.onEmpty}-escalation`,
      };
    } catch (err) {
      console.warn(
        TAG,
        `${rule.onEmpty} escalation failed (${err.message}) — ${file.name} passes through`
      );
    }
  }
  return res;
}

// Public entry for running an already-routed file through its companion/http
// endpoint on demand — the ambiguous prompt's "convert with companion" choice
// calls this with the original file and the ambiguous result's rule. Resolves
// to the converted File, or throws (the caller falls back to the original).
export function convertViaCompanion(file, rule) {
  return convertViaBackground(file, rule);
}

// How an http/companion conversion reaches its endpoint. In the extension that
// is the background relay (below). A surface with no service worker — the CLI,
// where `browser` is undefined — injects a direct transport instead (B13):
//   setHttpTransport((file, rule) => httpConvert(file, rule))
// The transport resolves to the converted File or throws.
let httpTransport = null;
export function setHttpTransport(fn) {
  httpTransport = fn;
}

// Relay an http/companion conversion through the background service worker
// (see relay.js for why). Throws on any failure; the caller maps that to the
// rule's onError.
async function convertViaBackground(file, rule) {
  if (file.size > MAX_RELAY_BYTES) {
    throw new Error(`file exceeds relay cap (${file.size} bytes)`);
  }
  if (httpTransport) return httpTransport(file, rule);
  const resp = await browser.runtime.sendMessage({
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
// classifier), DOCX (mammoth), XLSX/XLS (SheetJS), and PPTX (jszip +
// DrawingML extraction). Anything else routed here passes through untouched.
//
// engineFor is the single type→engine mapping: convertFile uses it, and the CLI
// surface (CLI.md §4) uses it to run the raw analysis when forcing a mode —
// so the two can't drift on which types have an engine. Returns the analysis
// function ({decision, reason, summary, markdown}) or null for an unhandled type.
export function engineFor(file) {
  const engine = rawEngineFor(file);
  return engine && withSizeLimits(engine);
}

// Every engine opens the file behind the input-size ceilings (limits.js, B4):
// an over-limit file comes back as a "too-large" passthrough analysis without
// the engine ever parsing it.
function withSizeLimits({ analyze, kind }) {
  return async (file, opts) => (await sizeVerdict(file, kind)) ?? analyze(file, opts);
}

function rawEngineFor(file) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    return { analyze: analyzePdf, kind: "raw" };
  }
  if (file.type === DOCX_MIME || /\.docx$/i.test(file.name)) {
    return { analyze: analyzeDocx, kind: "zip" };
  }
  if (
    file.type === XLSX_MIME ||
    file.type === XLS_MIME ||
    /\.xlsx?$/i.test(file.name)
  ) {
    // .xls is CFB, not a zip; sizeVerdict finds no zip directory and applies
    // the raw ceiling only.
    return { analyze: analyzeXlsx, kind: "zip" };
  }
  if (file.type === PPTX_MIME || /\.pptx$/i.test(file.name)) {
    return { analyze: analyzePptx, kind: "zip" };
  }
  if (file.type === "text/html" || /\.html?$/i.test(file.name)) {
    return { analyze: analyzeHtml, kind: "markup" };
  }
  return null;
}

async function inbrowser(file) {
  const engine = engineFor(file);
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
