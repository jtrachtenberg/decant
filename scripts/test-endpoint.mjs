// Decant — local test endpoint for the http/companion engine.
//
// A zero-dependency mock of the conversion contract (SPEC §3.4) so the
// extension's http transport can be developed and QA'd without any real
// service, API key, or network. It is also the executable definition of the
// contract the M3 Python companion must satisfy.
//
//   npm run test-endpoint          (default port 8765)
//   PORT=9000 npm run test-endpoint
//
// Behavior by path (POST/PUT):
//   /convert      → 200 JSON { "text": ... }     happy path; responseField "text"
//   /convert-raw  → 200 raw markdown body        happy path; no responseField
//   /slow         → /convert after 4 s           converting-badge QA
//   /error        → 500                          onError-fallback QA
//   /garbage      → 200 invalid JSON             parse-failure QA
//
// Accepted request encodings (SPEC §3.4 request.encoding):
//   multipart/form-data with a "file" field, or
//   application/json { "name", "type", "data" } with base64 data.
//
// The response text is deterministic for a given upload, so QA assertions
// are stable: "# Converted <name>" + byte count + encoding used.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT || process.argv[2] || 8765);

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// Parse either accepted encoding into { name, bytes, how }.
async function parseUpload(req, body) {
  const ct = req.headers["content-type"] || "";
  if (ct.startsWith("multipart/form-data")) {
    // undici's Response can parse multipart bodies — no dependency needed.
    const form = await new Response(body, {
      headers: { "content-type": ct },
    }).formData();
    const file = form.get("file");
    if (!file || typeof file === "string") {
      throw new Error('multipart body has no "file" field');
    }
    return {
      name: file.name || "upload",
      bytes: (await file.arrayBuffer()).byteLength,
      how: "multipart",
    };
  }
  if (ct.startsWith("application/json")) {
    const { name, data } = JSON.parse(body.toString("utf8"));
    if (typeof data !== "string") throw new Error('JSON body has no base64 "data"');
    return {
      name: name || "upload",
      bytes: Buffer.from(data, "base64").length,
      how: "base64-json",
    };
  }
  throw new Error(`unsupported content-type: ${ct || "(none)"}`);
}

function convertedMarkdown({ name, bytes, how }) {
  return `# Converted ${name}\n\nDecant test endpoint received ${bytes} bytes (${how}).\n`;
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url, `http://localhost:${PORT}`).pathname;
  const stamp = `${req.method} ${path}`;

  // Permissive CORS so the endpoint is also probeable from a page or curl -
  // the extension's background fetch doesn't need it, but QA might.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if (req.method !== "POST" && req.method !== "PUT") {
    res.writeHead(405, { "content-type": "text/plain" }).end("POST or PUT a file\n");
    return;
  }

  try {
    const upload = await parseUpload(req, await readBody(req));
    console.log(`${stamp}  ${upload.name} (${upload.bytes} bytes, ${upload.how})`);

    switch (path) {
      case "/slow":
        await new Promise((r) => setTimeout(r, 4000));
      // fall through to /convert behavior
      case "/convert":
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ text: convertedMarkdown(upload) }));
        return;
      case "/convert-raw":
        res
          .writeHead(200, { "content-type": "text/markdown" })
          .end(convertedMarkdown(upload));
        return;
      case "/error":
        res
          .writeHead(500, { "content-type": "text/plain" })
          .end("test endpoint: simulated failure\n");
        return;
      case "/garbage":
        res
          .writeHead(200, { "content-type": "application/json" })
          .end("this is not json {{{");
        return;
      default:
        res.writeHead(404, { "content-type": "text/plain" }).end("unknown path\n");
        return;
    }
  } catch (err) {
    console.warn(`${stamp}  rejected: ${err.message}`);
    res.writeHead(400, { "content-type": "text/plain" }).end(`${err.message}\n`);
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Decant test endpoint on http://127.0.0.1:${PORT}`);
  console.log("paths: /convert /convert-raw /slow /error /garbage");
});
