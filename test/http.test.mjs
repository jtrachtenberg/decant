// Unit tests for the http/companion engine (src/convert/http.js) with a
// stubbed fetch, plus an integration section that runs the real engine
// against the real local mock endpoint (scripts/mock-endpoint.mjs) — both
// sides of the SPEC §3.4 contract, no network beyond loopback.
//
//   node --test   (npm test)

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { httpConvert, HttpEngineError } from "../src/convert/http.js";
import { bufferToBase64, base64ToBuffer } from "../src/convert/codec.js";

const upload = (name = "note.txt", content = "hello decant") =>
  new File([content], name, { type: "text/plain" });

const rule = (over) => ({
  match: { mime: [], ext: ["txt"] },
  action: "http",
  enabled: true,
  onError: "passthrough",
  endpoint: "http://127.0.0.1:1/convert", // never actually fetched in unit tests
  responseField: "text",
  ...over,
});

// Minimal Response-shaped stub.
const reply = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
});

test("codec round-trips, including buffers larger than one chunk", () => {
  const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
  const back = new Uint8Array(base64ToBuffer(bufferToBase64(bytes.buffer)));
  assert.deepEqual(back, bytes);
});

test("default encoding is multipart with the file under 'file'", async () => {
  let got;
  const fetchFn = async (url, init) => {
    got = { url, init };
    return reply({ text: "# ok" });
  };
  await httpConvert(upload(), rule(), fetchFn);
  assert.equal(got.url, "http://127.0.0.1:1/convert");
  assert.equal(got.init.method, "POST");
  assert.ok(got.init.body instanceof FormData);
  const part = got.init.body.get("file");
  assert.equal(part.name, "note.txt");
  assert.equal(await part.text(), "hello decant");
});

test("base64-json encoding carries name, type, and decodable data", async () => {
  let got;
  const fetchFn = async (_url, init) => {
    got = init;
    return reply({ text: "# ok" });
  };
  await httpConvert(
    upload(),
    rule({ request: { encoding: "base64-json" } }),
    fetchFn
  );
  assert.equal(got.headers["content-type"], "application/json");
  const body = JSON.parse(got.body);
  assert.equal(body.name, "note.txt");
  assert.equal(body.type, "text/plain");
  assert.equal(
    new TextDecoder().decode(base64ToBuffer(body.data)),
    "hello decant"
  );
});

test("responseField extracts text; output defaults to .md markdown", async () => {
  const out = await httpConvert(upload("Report.TXT"), rule(), async () =>
    reply({ text: "# Converted" })
  );
  assert.equal(out.name, "Report.md");
  assert.equal(out.type, "text/markdown");
  assert.equal(await out.text(), "# Converted");
});

test("rule.output overrides extension and MIME type", async () => {
  const out = await httpConvert(
    upload(),
    rule({ output: { ext: "txt", mime: "text/plain" } }),
    async () => reply({ text: "plain" })
  );
  assert.equal(out.name, "note.txt");
  assert.equal(out.type, "text/plain");
});

test("no responseField → the response body is the text", async () => {
  const out = await httpConvert(
    upload(),
    rule({ responseField: undefined }),
    async () => reply("# Raw body")
  );
  assert.equal(await out.text(), "# Raw body");
});

for (const [name, fetchFn] of [
  ["non-2xx status", async () => reply("nope", 500)],
  ["unreachable endpoint", async () => { throw new TypeError("failed"); }],
  ["non-JSON body when responseField is set", async () => reply("not json {{{")],
  ["JSON missing the responseField", async () => reply({ wrong: "spot" })],
  ["empty text", async () => reply({ text: "   " })],
]) {
  test(`throws HttpEngineError on ${name}`, async () => {
    await assert.rejects(
      httpConvert(upload(), rule(), fetchFn),
      HttpEngineError
    );
  });
}

test("a hung endpoint times out into HttpEngineError (M1)", async () => {
  // fetch never settles; the timeout must abort and surface a fallback error
  // rather than hanging the upload forever.
  const hangs = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError"))
      );
    });
  await assert.rejects(
    httpConvert(upload(), rule(), hangs, 20),
    (err) => err instanceof HttpEngineError && /timed out/.test(err.message)
  );
});

// --- Integration: real engine ↔ real test endpoint over loopback -----------

describe("integration with scripts/mock-endpoint.mjs", () => {
  const PORT = 8899;
  const endpoint = (path) => `http://127.0.0.1:${PORT}${path}`;
  let child;

  before(async () => {
    child = spawn(
      process.execPath,
      [fileURLToPath(new URL("../scripts/mock-endpoint.mjs", import.meta.url))],
      { env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", "pipe", "inherit"] }
    );
    await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        if (d.toString().includes("Decant test endpoint")) resolve();
      });
      child.on("exit", () => reject(new Error("test endpoint exited early")));
      setTimeout(() => reject(new Error("test endpoint startup timeout")), 5000);
    });
  });

  after(() => child?.kill());

  test("multipart → /convert with responseField", async () => {
    const out = await httpConvert(
      upload(),
      rule({ endpoint: endpoint("/convert") })
    );
    assert.equal(out.name, "note.md");
    assert.match(await out.text(), /^# Converted note\.txt/);
    assert.match(await out.text(), /12 bytes \(multipart\)/);
  });

  test("base64-json → /convert-raw without responseField", async () => {
    const out = await httpConvert(
      upload(),
      rule({
        endpoint: endpoint("/convert-raw"),
        responseField: undefined,
        request: { encoding: "base64-json" },
      })
    );
    assert.match(await out.text(), /12 bytes \(base64-json\)/);
  });

  test("/error and /garbage trigger HttpEngineError", async () => {
    await assert.rejects(
      httpConvert(upload(), rule({ endpoint: endpoint("/error") })),
      HttpEngineError
    );
    await assert.rejects(
      httpConvert(upload(), rule({ endpoint: endpoint("/garbage") })),
      HttpEngineError
    );
  });
});
