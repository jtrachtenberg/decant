"""Decant companion — the local, high-fidelity conversion service (SPEC §4 M3).

This is the real "shape B" engine behind Decant's http/companion transport: a
localhost HTTP service that receives an uploaded file and returns Markdown,
using a document engine (MarkItDown or Docling) that reads charts, scans, and
complex tables the in-browser engines can't. It is the production counterpart
of scripts/mock-endpoint.mjs — same wire contract, so the extension talks to
either without changes.

Run:
    pip install -r requirements.txt
    python server.py                 # MarkItDown, port 8765
    DECANT_ENGINE=docling python server.py
    PORT=9000 python server.py

Then point a routing rule at it (see README.md): action "companion", endpoint
http://127.0.0.1:8765/convert, responseField "text", onError "inbrowser".

Wire contract (must match scripts/mock-endpoint.mjs and src/convert/http.js):
  POST|PUT /convert      -> 200 {"text": "<markdown>"}     (responseField "text")
  POST|PUT /convert-raw  -> 200 "<markdown>"               (text/markdown, no field)
  GET      /health       -> 200 {"status": "ok", "engine": "<name>"}
Request body is either multipart/form-data with a "file" field, or
application/json {"name", "type", "data"(base64)}. A conversion that fails or
yields nothing returns a non-2xx so the extension falls back per the rule's
onError (never loses the upload). Binds 127.0.0.1 only — documents never leave
the machine (SPEC §3.5 privacy guardrail); pointing a rule at a non-localhost
host is the conscious "shape C" tradeoff and lives elsewhere.
"""

import base64
import os
import tempfile

from flask import Flask, Response, jsonify, request

# --- Engine selection (MarkItDown default, Docling opt-in) ------------------
# Imported lazily inside make_engine so the service starts with only the engine
# you actually installed. Choose with DECANT_ENGINE=markitdown|docling.
ENGINE_NAME = os.environ.get("DECANT_ENGINE", "markitdown").strip().lower()
PORT = int(os.environ.get("PORT", "8765"))


def make_engine(name):
    """Return convert(path, filename) -> markdown for the named engine, or raise."""
    if name == "echo":
        # Zero-dependency deterministic engine (no real conversion): lets the
        # HTTP contract be smoke-tested with only Flask installed, before the
        # heavy MarkItDown/Docling models. Mirrors scripts/mock-endpoint.mjs.
        def convert(path, filename):
            size = os.path.getsize(path)
            return f"# Converted {filename}\n\nDecant companion (echo) received {size} bytes.\n"

        return convert

    if name == "docling":
        from docling.document_converter import DocumentConverter

        converter = DocumentConverter()

        def convert(path, filename):
            return converter.convert(path).document.export_to_markdown()

        return convert

    if name == "markitdown":
        from markitdown import MarkItDown

        md = MarkItDown()

        def convert(path, filename):
            # .text_content is the Markdown body across MarkItDown versions.
            return md.convert(path).text_content

        return convert

    raise ValueError(
        f"unknown engine {name!r} (use 'markitdown', 'docling', or 'echo')"
    )


# Built once at startup so the (potentially slow) model/engine init is paid
# before the first request, not on it.
_engine = make_engine(ENGINE_NAME)


# --- Upload parsing: mirror the two encodings the client speaks -------------
def read_upload():
    """(name, data_bytes) from a multipart 'file' field or base64-JSON body.

    Raises ValueError on anything the contract doesn't allow, which the caller
    maps to a 400.
    """
    file = request.files.get("file")
    if file is not None:
        return file.filename or "upload", file.read()

    if request.is_json:
        body = request.get_json(silent=True) or {}
        data = body.get("data")
        if not isinstance(data, str):
            raise ValueError('JSON body has no base64 "data"')
        try:
            raw = base64.b64decode(data, validate=True)
        except Exception as exc:  # noqa: BLE001 - report any decode failure as 400
            raise ValueError(f"invalid base64 data: {exc}") from exc
        return body.get("name") or "upload", raw

    raise ValueError(
        'expected multipart/form-data with a "file" field or '
        'application/json {"name","type","data"}'
    )


def convert_upload(name, data):
    """Run the engine over the uploaded bytes and return Markdown.

    The engines sniff format largely from the file extension, so the bytes are
    written to a temp file carrying the upload's own suffix. On Windows a
    NamedTemporaryFile can't be reopened while held, so it's closed first and
    removed in finally.
    """
    suffix = os.path.splitext(name)[1] or ".bin"
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix)
    try:
        tmp.write(data)
        tmp.close()
        return _engine(tmp.name, name)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


app = Flask(__name__)


@app.after_request
def cors(resp):
    # Permissive CORS so the endpoint is also probeable from a page or curl; the
    # extension's background fetch doesn't need it (mirrors the mock endpoint).
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "POST, PUT, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


def _convert_or_error():
    """Shared body handling: parse, convert, and normalize failures to codes.

    Returns (name, text) on success, or (None, flask_response) on a handled
    error so both endpoints answer identically.
    """
    try:
        name, data = read_upload()
    except ValueError as exc:
        return None, (str(exc) + "\n", 400, {"Content-Type": "text/plain"})

    try:
        text = convert_upload(name, data)
    except Exception as exc:  # noqa: BLE001 - any engine failure -> onError fallback
        app.logger.warning("conversion failed for %s: %s", name, exc)
        return None, (f"conversion failed: {exc}\n", 422, {"Content-Type": "text/plain"})

    # An empty conversion isn't worth substituting; a non-2xx lets the client
    # fall back rather than attach a blank file (matches http.js).
    if not text or not text.strip():
        return None, ("engine produced no text\n", 422, {"Content-Type": "text/plain"})

    app.logger.info("converted %s (%d bytes -> %d chars)", name, len(data), len(text))
    return name, text


@app.route("/convert", methods=["POST", "PUT", "OPTIONS"])
def convert():
    if request.method == "OPTIONS":
        return ("", 204)
    name, result = _convert_or_error()
    if name is None:
        return result
    return jsonify({"text": result})


@app.route("/convert-raw", methods=["POST", "PUT", "OPTIONS"])
def convert_raw():
    if request.method == "OPTIONS":
        return ("", 204)
    name, result = _convert_or_error()
    if name is None:
        return result
    return Response(result, mimetype="text/markdown")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine": ENGINE_NAME})


if __name__ == "__main__":
    print(f"Decant companion ({ENGINE_NAME}) on http://127.0.0.1:{PORT}")
    print("paths: POST /convert  POST /convert-raw  GET /health")
    # 127.0.0.1 only: the companion is a local service; documents never leave
    # the machine. threaded so a slow conversion doesn't block /health probes.
    app.run(host="127.0.0.1", port=PORT, threaded=True)
