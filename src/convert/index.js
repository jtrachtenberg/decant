// Converter interface — engine-agnostic entry point the content script calls.
// The routing table decides each intercepted file's fate (SPEC §3.2); this
// module dispatches the routed action to an engine. M2 wires in the
// in-browser (shape A) PDF path; companion/http engines (shapes B/C) drop in
// behind the same contract and fall back per the rule's `onError` until then.
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
import { resultFromAnalysis } from "./result.js";
import { routeFile } from "../router/route.js";
import { DEFAULT_CONFIG } from "../config/defaults.js";

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
    // Shapes B/C arrive in M3; honor the rule's fallback meanwhile so a
    // forward-written config still behaves sanely today.
    console.warn(
      TAG,
      `${action} engine not available yet — ${rule.onError} fallback for ${file.name}`
    );
    if (rule.onError !== "inbrowser") {
      return { action: "passthrough", file, reason: "engine-unavailable" };
    }
  }

  return inbrowser(file);
}

// Shape A: the in-browser engine. PDF-only so far — anything else routed here
// passes through untouched (mammoth.js / SheetJS arrive later in M2).
async function inbrowser(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    return { action: "passthrough", file, reason: "no-engine" };
  }

  let res = null;
  try {
    res = await analyzePdf(file);
  } catch (err) {
    console.error(TAG, "analysis failed, passing original through:", err);
  }
  return resultFromAnalysis(file, res);
}
