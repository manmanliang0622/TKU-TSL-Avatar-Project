#!/usr/bin/env python3
import json
from urllib.error import HTTPError
from urllib.request import Request, urlopen


BASE = "http://127.0.0.1:8083"


def fetch(path, method="GET", payload=None, timeout=180):
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(
        BASE + path,
        data=body,
        method=method,
        headers={} if body is None else {"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=timeout) as response:
        return response.status, response.headers.get_content_type(), response.read()


status, _content_type, body = fetch("/health")
health = json.loads(body)
assert status == 200, health
assert health["status"] == "ok", health
assert health["model"] == "qlora_e4b_v11_holdout", health
assert health["model_process_alive"] is True, health
print("HEALTH_OK", json.dumps(health, ensure_ascii=False))

status, _content_type, body = fetch(
    "/translate", method="POST", payload={"text": "我要喝水"}
)
translation = json.loads(body)
assert status == 200, translation
assert translation.get("chinese") == "我要喝水", translation
assert isinstance(translation.get("gloss"), list) and translation["gloss"], translation
print("TRANSLATE_OK", json.dumps(translation, ensure_ascii=False))

assets = [
    "/",
    "/style.css",
    "/script.js",
    "/models/avatar.vrm",
    "/recordings/lexicon.json",
    "/recordings/moc_G1D4P2.json",
]
for asset in assets:
    status, content_type, body = fetch(asset, timeout=30)
    assert status == 200 and body, (asset, status, len(body))
    print("ASSET_OK", asset, content_type, len(body))
