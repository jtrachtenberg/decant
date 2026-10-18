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
http://127.0.0.1:8765/convert, responseField "text", onError "inbrowser"
(append ?token=<DECANT_TOKEN> when you run it with a token).

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

Access control (S2). Binding to loopback is not enough on its own: any web page
the user visits can POST to 127.0.0.1, and DNS rebinding reaches it under a
foreign Host name. So every request must
  - name this server in its Host header (127.0.0.1 / localhost / [::1] + port);
  - carry no Origin, or an extension origin (chrome-extension://,
    moz-extension://, safari-web-extension://) — a web page's Origin is
    refused; and, for the conversion paths,
  - when DECANT_TOKEN is set, present it: `?token=` on the endpoint URL (what
    the extension's routing rule carries), `Authorization: Bearer <token>`, or
    `X-Decant-Token: <token>`.
No CORS headers are sent: the extension's background fetch runs under its host
permission and doesn't need them, and a page must not be able to read results.
Uploads are capped at MAX_UPLOAD_BYTES.
"""

import base64
import hmac
import logging
import os
import re
import tempfile

from flask import Flask, Response, abort, jsonify, request

# --- Engine selection (MarkItDown default, Docling opt-in) ------------------
# Imported lazily inside make_engine so the service starts with only the engine
# you actually installed. Choose with DECANT_ENGINE=markitdown|docling.
ENGINE_NAME = os.environ.get("DECANT_ENGINE", "markitdown").strip().lower()
PORT = int(os.environ.get("PORT", "8765"))

# Largest request body accepted (Flask answers 413 above it). The extension's
# relay caps files at 32 MB (src/convert/relay.js MAX_RELAY_BYTES); base64-JSON
# inflates that by 4/3, so 64 MB admits every upload the extension can send.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

# Browser origins allowed to call the service: extension pages and workers only.
EXTENSION_ORIGIN_PREFIXES = (
    "chrome-extension://",
    "moz-extension://",
    "safari-web-extension://",
)

# Host header values that name this server. Anything else (a rebinding
# attacker's hostname) is refused.
ALLOWED_HOSTS = {f"127.0.0.1:{PORT}", f"localhost:{PORT}", f"[::1]:{PORT}"}
if PORT == 80:
    ALLOWED_HOSTS |= {"127.0.0.1", "localhost", "[::1]"}


# Optional shared secret (DECANT_TOKEN). When set, the conversion paths also
# require it — `?token=` on the endpoint URL (what a Decant routing rule can
# carry today), `Authorization: Bearer …`, or `X-Decant-Token: …` — which keeps
# other local processes and other users of a shared machine out as well. The
# server never prints or stores it; you choose it and paste the same value into
# the rule's endpoint. Unset, the Host and Origin checks still refuse every web
# page, so existing endpoints keep working unchanged.
REQUIRED_TOKEN = os.environ.get("DECANT_TOKEN", "").strip()


class _RedactToken(logging.Filter):
    """Keep the token out of the request log (werkzeug logs the query string)."""

    _pattern = re.compile(r"(token=)[^&\s\"]+")

    def filter(self, record):
        if isinstance(record.args, tuple):
            record.args = tuple(
                self._pattern.sub(r"\1***", a) if isinstance(a, str) else a
                for a in record.args
            )
        return True


logging.getLogger("werkzeug").addFilter(_RedactToken())


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


# The temp-file suffix is the one piece of the upload name that touches the
# filesystem. The upload's extension only *selects* from this table of formats
# the engines can sniff; the string handed to NamedTemporaryFile is always one
# of these literals, never user data (CodeQL py/path-injection). Bare `.zip` is
# deliberately absent: MarkItDown recurses into archives, which is a
# decompression-bomb surface for no document-conversion benefit (S2).
_KNOWN_SUFFIXES = {s: s for s in (
    ".pdf", ".docx", ".doc", ".pptx", ".ppt", ".xlsx", ".xls",
    ".csv", ".tsv", ".json", ".xml", ".html", ".htm", ".md", ".txt", ".rtf",
    ".epub", ".ipynb", ".msg", ".eml", ".adoc", ".asciidoc",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".tif",
    ".mp3", ".wav", ".m4a",
)}


def convert_upload(name, data):
    """Run the engine over the uploaded bytes and return Markdown.

    The engines sniff format largely from the file extension, so the bytes are
    written to a temp file carrying the upload's own suffix — when it's a
    format we know; anything else becomes .bin. On Windows a
    NamedTemporaryFile can't be reopened while held, so it's closed first and
    removed in finally.
    """
    suffix = _KNOWN_SUFFIXES.get(os.path.splitext(name)[1].lower(), ".bin")
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
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_BYTES


def _presented_token():
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return request.headers.get("X-Decant-Token") or request.args.get("token") or ""


def _origin_allowed(origin):
    return origin is None or origin.startswith(EXTENSION_ORIGIN_PREFIXES)


@app.before_request
def guard():
    # Host first: a DNS-rebinding page reaches us under its own hostname.
    if request.host not in ALLOWED_HOSTS:
        return _plain_error("forbidden host\n", 403)
    # A web page's fetch always carries its Origin on POST; extension workers
    # carry an extension origin; curl and the CLI carry none.
    if not _origin_allowed(request.headers.get("Origin")):
        return _plain_error("forbidden origin\n", 403)
    if REQUIRED_TOKEN and request.endpoint in ("convert", "convert_raw"):
        if not hmac.compare_digest(_presented_token().encode(), REQUIRED_TOKEN.encode()):
            app.logger.warning(
                "rejected %s: missing or wrong DECANT_TOKEN — add ?token=<value> "
                "to the endpoint in Decant's routing rule", request.path
            )
            return _plain_error("missing or invalid token\n", 401)
    return None


@app.after_request
def headers(resp):
    # No Access-Control-Allow-* headers: the extension's background fetch runs
    # under its host permission and doesn't need CORS, and a web page must not
    # be able to read a conversion result.
    # Responses echo request-derived text (errors, converted uploads); nosniff
    # stops a legacy browser from second-guessing text/plain or text/markdown
    # into something renderable.
    resp.headers["X-Content-Type-Options"] = "nosniff"
    return resp


def _plain_error(message, status):
    # Error text can echo request details (filename, decode errors), so it goes
    # out as an explicit text/plain Response — never a renderable page. The
    # Response mimetype form (vs a headers dict) is also what CodeQL models
    # (py/reflective-xss).
    return Response(message, status=status, mimetype="text/plain")


def _convert_or_abort():
    """Shared body handling: parse, convert, and normalize failures to codes.

    Returns the converted text; every handled failure aborts with a plain-text
    response instead, so both endpoints answer identically. Errors travel as
    raised responses — never through the same variable as the converted text —
    which is also what keeps CodeQL's py/reflective-xss flow provably closed.
    """
    try:
        name, data = read_upload()
    except ValueError as exc:
        # Exception text stays in the local console (CodeQL py/stack-trace-
        # exposure); the body restates the whole request contract instead, which
        # is what a curl user actually needs.
        app.logger.info("invalid upload request: %s", exc)
        abort(_plain_error(
            'invalid request: expected multipart/form-data with a "file" field '
            'or application/json {"name","type","data"} with valid base64\n',
            400,
        ))

    try:
        text = convert_upload(name, data)
    except Exception as exc:  # noqa: BLE001 - any engine failure -> onError fallback
        app.logger.warning("conversion failed for %s: %s", name, exc, exc_info=True)
        abort(_plain_error("conversion failed; see companion log\n", 422))

    # An empty conversion isn't worth substituting; a non-2xx lets the client
    # fall back rather than attach a blank file (matches http.js).
    if not text or not text.strip():
        abort(_plain_error("engine produced no text\n", 422))

    app.logger.info("converted %s (%d bytes -> %d chars)", name, len(data), len(text))
    return text


@app.route("/convert", methods=["POST", "PUT"])
def convert():
    return jsonify({"text": _convert_or_abort()})


@app.route("/convert-raw", methods=["POST", "PUT"])
def convert_raw():
    return Response(_convert_or_abort(), mimetype="text/markdown")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "engine": ENGINE_NAME})


if __name__ == "__main__":
    print(f"Decant companion ({ENGINE_NAME}) on http://127.0.0.1:{PORT}")
    print("paths: POST /convert  POST /convert-raw  GET /health")
    print("token:", "required (DECANT_TOKEN)" if REQUIRED_TOKEN else "off (set DECANT_TOKEN to require one)")
    # 127.0.0.1 only: the companion is a local service; documents never leave
    # the machine. threaded so a slow conversion doesn't block /health probes.
    app.run(host="127.0.0.1", port=PORT, threaded=True)
