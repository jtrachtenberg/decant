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

**Pick one shell and stay in it** — a virtualenv is per-OS, so a Windows venv
(`.venv\Scripts\`) and a WSL/Linux venv (`.venv/bin/`) can't share the same
`companion/.venv` folder. On Windows + WSL, **WSL is the better choice**: it
tends to ship a Python (3.11/3.12) with wider wheel coverage than a bleeding-edge
Windows Python, which matters for the heavier engines.

<details open><summary><b>WSL / macOS / Linux (bash)</b></summary>

```bash
cd companion
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

python server.py                       # MarkItDown, http://127.0.0.1:8765
DECANT_ENGINE=echo python server.py    # deterministic stub, no heavy deps
PORT=9000 python server.py
```
</details>

<details><summary><b>Windows PowerShell</b></summary>

```powershell
cd companion
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt

python server.py                       # MarkItDown, http://127.0.0.1:8765
$env:DECANT_ENGINE = "echo"; python server.py
$env:PORT = "9000"; python server.py
```

In PowerShell, use **`curl.exe`** (bare `curl` is an alias for
`Invoke-WebRequest`).
</details>

**The server runs in the foreground** — it prints a startup banner and keeps
running until `Ctrl-C`. That's correct; it's a service. Test it from a **second**
terminal (or the browser), not the one it's running in.

> Python 3.14 is very new; MarkItDown/Docling may not have wheels for it yet.
> If `pip install` fails, use a venv on Python 3.11–3.12.

Options (environment variables):

| Var | Default | Meaning |
| --- | --- | --- |
| `DECANT_ENGINE` | `markitdown` | `markitdown`, `docling`, or `echo` (see below) |
| `PORT` | `8765` | port to bind on `127.0.0.1` |

- **`markitdown`** — default; fast, broad format coverage, light install. But its
  PDF path is flat text extraction: it does **not** reconstruct tables or
  headings, so on clean text PDFs it can be *worse* than Decant's own in-browser
  engine. Best for breadth and speed, not PDF fidelity.
- **`docling`** — the real quality tier: reconstructs headings and tables and
  does OCR on scanned pages, matching or beating the in-browser engine. Slower
  (ML models, downloads weights on first run) and a heavier install
  (`pip install docling`), then `DECANT_ENGINE=docling python server.py`.
- **`echo`** — no real conversion; returns a deterministic stub. Needs only Flask, so you can verify the **HTTP contract and the extension wiring** before installing a heavy engine.

> **Which engine?** The in-browser engines are already strong on clean text
> documents, so the companion is a *fidelity* upgrade mainly with **Docling** and
> mainly on the cases the browser can't handle — complex layouts and **scanned /
> image-only PDFs** (which the browser passes through untouched). Routing clean
> text PDFs to **MarkItDown** can lower fidelity, not raise it.

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

### Recommended: escalate only on scans (`onEmpty`)

Sending *every* PDF to the companion is usually the wrong trade — the in-browser
engine is fast and strong on native text PDFs, and MarkItDown can even be worse
there. The better pattern is **in-browser first, companion only when the browser
comes up empty** (a scanned / image-only PDF it can't read). Keep the rule on
`inbrowser` and add an `onEmpty` escalation target:

```jsonc
{
  "match": { "mime": ["application/pdf"], "ext": ["pdf"] },
  "action": "inbrowser",           // native PDFs convert locally, no latency
  "onEmpty": "companion",          // a scan (no text layer) escalates to OCR
  "endpoint": "http://127.0.0.1:8765/convert-raw",
  "output": { "ext": "md", "mime": "text/markdown" }
}
```

Now native PDFs are handled instantly in the browser, and only the scans the
browser *can't* read are sent to the companion (run it with `DECANT_ENGINE=docling`
for OCR). If you never set up the companion, drop `onEmpty`/`endpoint` and scans
simply pass through — nothing to install. Escalation that fails for any reason
(service down, no text recovered) falls back to passing the original through, so
the file is never lost.

> Set `onEmpty` via the options page's **Show current → edit → Apply JSON**; the
> quick-add rule form doesn't expose it yet.

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
