#!/usr/bin/env python3
"""Serveur bouchon : fait croire au greffon KOReader qu'il parle à OpenAI.

But : voir exactement ce que la liseuse envoie, et vérifier le tuyau avant
d'écrire le vrai serveur Marginalia.

    python3 mock-openai.py                 # écoute sur 0.0.0.0:8080
    python3 mock-openai.py 9000            # autre port

Dans le greffon (KOReader), ajouter un fournisseur « openai » avec :
    base_url = "http://<ip-du-pc>:8080/v1"
    api_key  = "test"
    model    = "marginalia-mock"

Chaque requête est écrite en entier dans ./mock-requests/<horodatage>.json,
et la réponse renvoyée dit ce qui a été reçu (taille de la sélection, page,
titre, nombre de messages) : c'est le miroir de ce que le greffon envoie.
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "mock-requests")


def summarise(body: dict) -> str:
    msgs = body.get("messages") or []
    last = ""
    for m in reversed(msgs):
        c = m.get("content")
        if isinstance(c, list):
            c = " ".join(p.get("text", "") for p in c if isinstance(p, dict))
        if m.get("role") == "user" and c:
            last = c
            break
    return (
        "**Reçu par le bouchon**\n\n"
        f"- messages: {len(msgs)}\n"
        f"- modèle: {body.get('model', '?')}\n"
        f"- dernier message: {len(last)} caractères\n\n"
        "```\n"
        f"{last[:600]}\n"
        "```\n\n"
        "Si tu lis ça sur la liseuse, le tuyau fonctionne."
    )


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):  # noqa: A002 - silence stdout
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        if self.path.rstrip("/") in ("/v1/models", "/models"):
            payload = json.dumps(
                {"object": "list", "data": [{"id": "marginalia-mock", "object": "model"}]}
            ).encode()
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(200)
        self._cors()
        body = b"mock openai server: POST /v1/chat/completions"
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length)
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {"raw": raw.decode("utf-8", "replace")}

        os.makedirs(OUT, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S") + f"-{int(time.time() * 1000) % 1000:03d}"
        with open(os.path.join(OUT, f"{stamp}.json"), "w") as f:
            json.dump(body, f, ensure_ascii=False, indent=2)
        print(f"→ {stamp}.json  ({len(raw)} octets)")

        text = summarise(body)

        if body.get("stream"):
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()
            words = text.split(" ")
            for i, w in enumerate(words):
                chunk = {
                    "id": "mock",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": body.get("model", "marginalia-mock"),
                    "choices": [
                        {
                            "index": 0,
                            "delta": ({"role": "assistant"} if i == 0 else {})
                            | {"content": w + (" " if i < len(words) - 1 else "")},
                            "finish_reason": None,
                        }
                    ],
                }
                self._write_sse(chunk)
            self._write_sse(
                {
                    "id": "mock",
                    "object": "chat.completion.chunk",
                    "created": int(time.time()),
                    "model": "marginalia-mock",
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
            )
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            return

        payload = json.dumps(
            {
                "id": "mock",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": body.get("model", "marginalia-mock"),
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": text},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            }
        ).encode()
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _write_sse(self, obj: dict):
        data = f"data: {json.dumps(obj, ensure_ascii=False)}\n\n".encode()
        self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
        self.wfile.flush()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
    print(f"bouchon OpenAI sur http://0.0.0.0:{port}/v1  — requêtes dans {OUT}")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
