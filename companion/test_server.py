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

os.environ["DECANT_ENGINE"] = "echo"  # contract-only; no real conversion engine

import server  # noqa: E402  (import after setting the engine env)

client = server.app.test_client()


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


def test_unparseable_body_is_400():
    r = client.post("/convert", data="not a file", content_type="text/plain")
    assert r.status_code == 400


def test_json_without_data_is_400():
    r = client.post("/convert", json={"name": "a.txt"})
    assert r.status_code == 400


def test_options_preflight_is_204_with_cors():
    r = client.open("/convert", method="OPTIONS")
    assert r.status_code == 204
    assert r.headers.get("Access-Control-Allow-Origin") == "*"
