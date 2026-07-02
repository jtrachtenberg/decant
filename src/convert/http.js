// Shape B/C engine: POST a file to the rule's endpoint and rebuild the
// response as the substituted upload (SPEC §3.4). "companion" and "http"
// actions share this engine — a companion is just an http endpoint on
// localhost.
//
// Chrome-free with an injectable fetch, so the whole request/response
// contract unit-tests in Node (test/http.test.mjs) and integration-tests
// against scripts/test-endpoint.mjs. In the extension it runs in the
// background service worker: content-script fetches are subject to the
// page's CORS, background fetches use the extension's host permissions.
//
// httpConvert(file, rule, fetchFn) → converted File, or throws
// HttpEngineError for anything that should trigger the rule's onError
// fallback (unreachable endpoint, non-2xx, bad response shape, empty text).

import { bufferToBase64 } from "./codec.js";

export class HttpEngineError extends Error {}

export async function httpConvert(file, rule, fetchFn = fetch) {
  let res;
  try {
    res = await fetchFn(rule.endpoint, await buildRequest(file, rule));
  } catch (err) {
    throw new HttpEngineError(`endpoint unreachable: ${err.message}`);
  }
  if (!res.ok) {
    throw new HttpEngineError(`endpoint returned ${res.status}`);
  }
  const text = await extractText(res, rule.responseField);
  return outputFile(file, rule.output, text);
}

// SPEC §3.4 request.encoding — multipart/form-data (default) or base64 JSON.
async function buildRequest(file, rule) {
  if (rule.request?.encoding === "base64-json") {
    return {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: file.name,
        type: file.type || "application/octet-stream",
        data: bufferToBase64(await file.arrayBuffer()),
      }),
    };
  }
  const form = new FormData();
  form.append("file", file, file.name);
  return { method: "POST", body: form };
}

// SPEC §3.4 responseField — where the converted text lives in a JSON
// response. When absent, the response body itself is the text (the contract
// plain converters like Apache Tika speak).
async function extractText(res, responseField) {
  const body = await res.text();
  let text = body;
  if (responseField) {
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new HttpEngineError("endpoint response is not JSON");
    }
    text = parsed?.[responseField];
    if (typeof text !== "string") {
      throw new HttpEngineError(`response JSON has no text at ${responseField}`);
    }
  }
  // An empty conversion is a misconfigured endpoint, not a result worth
  // substituting — fall back rather than attach a blank file.
  if (!text.trim()) {
    throw new HttpEngineError("endpoint returned empty text");
  }
  return text;
}

function outputFile(original, output, text) {
  const ext = output?.ext || "md";
  const mime = output?.mime || "text/markdown";
  const base = original.name.replace(/\.[a-z0-9]+$/i, "");
  return new File([text], `${base || original.name}.${ext}`, { type: mime });
}
