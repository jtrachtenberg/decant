# Decant companion service

The optional local, high-fidelity conversion tier (SPEC §4 **M3**). It's the
real "shape B" engine behind Decant's `companion`/`http` routing: a **localhost**
HTTP service that receives an uploaded file and returns Markdown, using a
document engine ([MarkItDown](https://github.com/microsoft/markitdown) or
[Docling](https://github.com/docling-project/docling)) that reads charts, scans,
and complex tables the in-browser engines can't.

It speaks the **same wire contract** as [`scripts/mock-endpoint.mjs`](../scripts/mock-endpoint.mjs),
so the extension talks to either without changes. The in-browser engines remain
the default and the fallback — the companion is a quality upgrade you opt into,
and if it's not running, conversions fall back per each rule's `onError`.

## Install & run

```bash
cd companion
python -m venv .venv
. .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements.txt

python server.py                # MarkItDown, http://127.0.0.1:8765
```

Options (environment variables):

| Var | Default | Meaning |
| --- | --- | --- |
| `DECANT_ENGINE` | `markitdown` | `markitdown`, `docling`, or `echo` (see below) |
| `PORT` | `8765` | port to bind on `127.0.0.1` |

- **`markitdown`** — default; broad format coverage (PDF/DOCX/PPTX/XLSX/HTML/images/audio), light install.
- **`docling`** — higher-fidelity tables/layout; heavier (ML models). Uncomment `docling` in `requirements.txt`, then `DECANT_ENGINE=docling python server.py`.
- **`echo`** — no real conversion; returns a deterministic stub. Needs only Flask, so you can verify the **HTTP contract and the extension wiring** before installing a heavy engine.

## Wire it into Decant

The default routing ships the built-in engines (`inbrowser`). To send a type to
the companion instead, edit that rule in the options page (or JSON import) to:

```jsonc
{
  "match": { "mime": ["application/pdf"], "ext": ["pdf"] },
  "action": "companion",
  "endpoint": "http://127.0.0.1:8765/convert",
  "responseField": "text",
  "output": { "ext": "md", "mime": "text/markdown" },
  "onError": "inbrowser"          // if the service is down, fall back to shape A
}
```

- `endpoint` `/convert` returns `{"text": "<markdown>"}`, so set `responseField: "text"`.
  Use `/convert-raw` (which returns the Markdown body directly) and **omit**
  `responseField` if you prefer a plain-text endpoint.
- `onError: "inbrowser"` means a dead/failing service degrades gracefully to the
  built-in engine; `passthrough` sends the original file untouched instead.

## Contract (must match the mock endpoint & `src/convert/http.js`)

| Method / path | Response |
| --- | --- |
| `POST\|PUT /convert` | `200 {"text": "<markdown>"}` |
| `POST\|PUT /convert-raw` | `200 <markdown>` (`text/markdown`) |
| `GET /health` | `200 {"status":"ok","engine":"<name>"}` |

Request body is either `multipart/form-data` with a **`file`** field, or
`application/json {"name","type","data"(base64)}`. A conversion that fails or
produces no text returns a **non-2xx**, so the extension falls back per
`onError` and never loses the upload.

## Smoke test

With the server running (any engine — `echo` is enough for the contract):

```bash
curl -s http://127.0.0.1:8765/health
# {"engine":"echo","status":"ok"}

curl -s -F file=@../test/fixtures/tables/fidelity_call_brief.pdf \
     http://127.0.0.1:8765/convert            # multipart -> {"text": ...}

curl -s -X POST http://127.0.0.1:8765/convert-raw \
     -H 'Content-Type: application/json' \
     -d "{\"name\":\"a.txt\",\"data\":\"$(printf 'hello' | base64)\"}"   # base64-json -> raw md
```

Both encodings and both response shapes exercise the exact paths the extension's
background worker uses.

## Privacy

The server binds **`127.0.0.1` only** — documents never leave the machine
(SPEC §3.5). Pointing a routing rule at a non-localhost endpoint is the
conscious "shape C" tradeoff and is warned about in the options page, not here.
