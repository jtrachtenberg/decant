"""Contract tests for the companion service (companion/server.py).

Runs against the zero-dependency `echo` engine, so it needs only Flask + pytest
(no MarkItDown/Docling) and asserts the exact wire shape the extension's
background worker and scripts/mock-endpoint.mjs rely on.

    pip install flask pytest
    cd companion && pytest
"""

import base64
import io
import os

import pytest

os.environ["DECANT_ENGINE"] = "echo"  # contract-only; no real conversion engine
os.environ.pop("DECANT_TOKEN", None)  # token tests opt in via monkeypatch
os.environ.pop("PORT", None)

import server  # noqa: E402  (import after setting the engine env)



class _Client:
    """The Flask test client, naming the server the way the extension does.

    Requests go to http://127.0.0.1:PORT (the default "localhost" with no port
    would be refused by the Host check); a test may still pass its own Host.
    """

    def __init__(self):
        self._inner = server.app.test_client()
        self._base = f"http://127.0.0.1:{server.PORT}"

    def __getattr__(self, method):
        call = getattr(self._inner, method)
        return lambda *a, **kw: call(*a, base_url=self._base, **kw)


client = _Client()


def test_health_reports_engine():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json() == {"status": "ok", "engine": "echo"}


def test_convert_multipart_returns_text_field():
    data = {"file": (io.BytesIO(b"hello world"), "note.txt")}
    r = client.post("/convert", data=data, content_type="multipart/form-data")
    assert r.status_code == 200
    text = r.get_json()["text"]
    assert "Converted note.txt" in text
    assert "11 bytes" in text  # echo reports the received byte count


def test_convert_base64_json_body():
    payload = {
        "name": "a.txt",
        "type": "text/plain",
        "data": base64.b64encode(b"hello").decode(),
    }
    r = client.post("/convert", json=payload)
    assert r.status_code == 200
    assert "5 bytes" in r.get_json()["text"]


def test_convert_raw_returns_markdown_body():
    data = {"file": (io.BytesIO(b"abc"), "x.txt")}
    r = client.post("/convert-raw", data=data, content_type="multipart/form-data")
    assert r.status_code == 200
    assert r.mimetype == "text/markdown"
    assert r.get_data(as_text=True).startswith("# Converted x.txt")


def test_hostile_upload_name_still_converts():
    # The extension of the upload name selects a temp-file suffix; anything not
    # in the known-format table must fall back to .bin rather than reach the path.
    payload = {
        "name": "..\\..\\evil.a-b!c",
        "type": "application/octet-stream",
        "data": base64.b64encode(b"payload").decode(),
    }
    r = client.post("/convert", json=payload)
    assert r.status_code == 200
    assert "7 bytes" in r.get_json()["text"]


def test_suffix_table_maps_extensions_to_its_own_literals():
    # Every value the table can yield is one of its own constant strings, so
    # nothing user-controlled ever reaches the temp-file path.
    assert all(k == v for k, v in server._KNOWN_SUFFIXES.items())
    assert server._KNOWN_SUFFIXES[".pdf"] == ".pdf"
    assert ".exe" not in server._KNOWN_SUFFIXES
    assert ".t xt" not in server._KNOWN_SUFFIXES
    assert "" not in server._KNOWN_SUFFIXES


def test_unparseable_body_is_400():
    r = client.post("/convert", data="not a file", content_type="text/plain")
    assert r.status_code == 400
    # Errors must never go out as renderable HTML — plain text plus nosniff
    # (CodeQL py/reflective-xss) — and never carry exception text; the body is
    # a constant restating the request contract (py/stack-trace-exposure).
    assert r.mimetype == "text/plain"
    assert r.headers.get("X-Content-Type-Options") == "nosniff"
    assert "multipart/form-data" in r.get_data(as_text=True)


def test_json_without_data_is_400():
    r = client.post("/convert", json={"name": "a.txt"})
    assert r.status_code == 400


# --- Access control (S2) ------------------------------------------------------


def _upload():
    return {"file": (io.BytesIO(b"hello"), "a.txt")}


def test_no_cors_headers_so_pages_cannot_read_results():
    # The extension's background fetch runs under its host permission and needs
    # no CORS; a permissive Access-Control-Allow-Origin let any page read results.
    r = client.post("/convert", data=_upload(), content_type="multipart/form-data")
    assert r.status_code == 200
    assert "Access-Control-Allow-Origin" not in r.headers
    r = client.open("/convert", method="OPTIONS")
    assert "Access-Control-Allow-Origin" not in r.headers


@pytest.mark.parametrize("origin", ["https://evil.example", "http://127.0.0.1:8000", "null"])
def test_web_page_origins_are_refused(origin):
    r = client.post(
        "/convert", data=_upload(), content_type="multipart/form-data",
        headers={"Origin": origin},
    )
    assert r.status_code == 403
    assert client.get("/health", headers={"Origin": origin}).status_code == 403


@pytest.mark.parametrize("origin", [
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    "moz-extension://0b3f7a2e-1111-2222-3333-444455556666",
    "safari-web-extension://ABCDEF",
])
def test_extension_origins_are_allowed(origin):
    r = client.post(
        "/convert", data=_upload(), content_type="multipart/form-data",
        headers={"Origin": origin},
    )
    assert r.status_code == 200


@pytest.mark.parametrize("host", ["evil.example:8765", "localhost", "127.0.0.1:9999", "attacker.test"])
def test_foreign_host_header_is_refused(host):
    # DNS rebinding reaches 127.0.0.1 under the attacker's own hostname.
    r = client.get("/health", headers={"Host": host})
    assert r.status_code == 403


@pytest.mark.parametrize("host", ["127.0.0.1", "localhost", "[::1]"])
def test_loopback_host_names_are_allowed(host):
    r = client.get("/health", headers={"Host": f"{host}:{server.PORT}"})
    assert r.status_code == 200


def test_oversized_body_is_413():
    big = b"x" * (server.MAX_UPLOAD_BYTES + 1)
    r = client.post(
        "/convert", data={"file": (io.BytesIO(big), "big.txt")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 413


def test_zip_is_not_a_known_suffix():
    # MarkItDown recurses into archives — a decompression-bomb surface.
    assert ".zip" not in server._KNOWN_SUFFIXES


def test_token_when_configured(monkeypatch):
    monkeypatch.setattr(server, "REQUIRED_TOKEN", "s3cret-value")
    post = lambda path, **kw: client.post(  # noqa: E731
        path, data=_upload(), content_type="multipart/form-data", **kw
    )
    assert post("/convert").status_code == 401
    assert post("/convert?token=wrong").status_code == 401
    assert post("/convert?token=s3cret-value").status_code == 200
    assert post("/convert-raw", headers={"Authorization": "Bearer s3cret-value"}).status_code == 200
    assert post("/convert", headers={"X-Decant-Token": "s3cret-value"}).status_code == 200
    # /health stays open to a local probe (it carries no document).
    assert client.get("/health").status_code == 200


def test_token_never_reaches_the_request_log():
    import logging

    rec = logging.LogRecord(
        "werkzeug", logging.INFO, __file__, 1, '%s - - [%s] "%s" %s -',
        ("127.0.0.1", "now", "POST /convert?token=abc123&x=1 HTTP/1.1", "200"), None,
    )
    server._RedactToken().filter(rec)
    assert "abc123" not in rec.getMessage()
