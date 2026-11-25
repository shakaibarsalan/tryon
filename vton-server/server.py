"""Try-On render server: FASHN VTON 1.5 behind a small JSON API, for the API's `self-hosted` provider.

    POST /v1/tryon        {person_image, garment_image, category, garment_photo_type?, num_timesteps?, seed?}
                          -> 202 {id, status: "queued", position}
    GET  /v1/tryon/<id>   -> {id, status, position? | progress? | result_image? | error?, ms?}
    GET  /health          -> {ok, ready, device, dtype, steps, queued, busy}

Images are data URLs (jpeg/png/webp, at most 1.5 MB each). Jobs run one at a time on one worker
thread. Images stay in memory only: inputs are dropped when a job ends and results 10 minutes
later. If VTON_SERVER_TOKEN is set, every /v1 call needs "Authorization: Bearer <token>".

Run it (see README.md):  python server.py --port 7861
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Callable, Optional

from images import ImageError, decode_data_url, sniff_mime, to_data_url
from jobs import JobStore, QueueFull, Runner, start_worker

VERSION = "0.1.0"
CATEGORIES = {"tops", "bottoms", "one-pieces", "auto"}
PHOTO_TYPES = {"auto", "model", "flat-lay"}
# Two base64 images at the cap plus slack.
MAX_BODY_BYTES = 2 * (1_500_000 * 4 // 3 + 16) + 64 * 1024
JOB_PATH = re.compile(r"^/v1/tryon/([0-9a-f]{32})/?$")

log = logging.getLogger("vton-server")


def clamp_int(value: object, default: int, lo: int, hi: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    return max(lo, min(hi, int(value)))


def make_handler(store: JobStore, info: Callable[[], dict], token: Optional[str], default_steps: int):
    class Handler(BaseHTTPRequestHandler):
        server_version = f"tryon-vton/{VERSION}"
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: object) -> None:  # quieter than the default
            log.debug("%s %s", self.address_string(), fmt % args)

        def _send(self, status: int, body: dict) -> None:
            data = json.dumps(body).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _error(self, status: int, code: str, message: str) -> None:
            self._send(status, {"error": {"code": code, "message": message}})

        def _authorized(self) -> bool:
            if not token:
                return True
            got = self.headers.get("Authorization", "")
            return got.startswith("Bearer ") and hmac.compare_digest(got[7:].strip().encode(), token.encode())

        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/health", "/health/"):
                self._send(200, {"ok": True, "version": VERSION, **info(), "queued": store.queued(), "busy": store.busy is not None})
                return
            m = JOB_PATH.match(self.path)
            if not m:
                self._error(404, "not_found", f"No route for GET {self.path}")
                return
            if not self._authorized():
                self._error(401, "unauthorized", "Missing or wrong bearer token")
                return
            job = store.get(m.group(1))
            if job is None:
                self._error(404, "not_found", "Job not found (finished more than 10 minutes ago, or the server restarted)")
                return
            body = job.view(store.position(job.id))
            if job.status == "completed" and job.result is not None:
                body["result_image"] = to_data_url(sniff_mime(job.result) or "image/jpeg", job.result)
            self._send(200, body)

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") != "/v1/tryon":
                self._error(404, "not_found", f"No route for POST {self.path}")
                return
            if not self._authorized():
                self._error(401, "unauthorized", "Missing or wrong bearer token")
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                length = -1
            if length <= 0:
                self._error(400, "bad_request", "A JSON body with Content-Length is required")
                return
            if length > MAX_BODY_BYTES:
                self._error(413, "image_too_large", f"Body is larger than {MAX_BODY_BYTES} bytes")
                return
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._error(400, "bad_request", "Body must be valid JSON")
                return
            if not isinstance(body, dict):
                self._error(400, "bad_request", "Body must be a JSON object")
                return
            try:
                _, person = decode_data_url("person_image", body.get("person_image"))
                _, garment = decode_data_url("garment_image", body.get("garment_image"))
            except ImageError as e:
                self._error(413 if e.code == "image_too_large" else 400, e.code, e.message)
                return
            category = body.get("category", "auto")
            if category not in CATEGORIES:
                self._error(400, "bad_request", "category must be one of tops, bottoms, one-pieces, auto")
                return
            photo_type = body.get("garment_photo_type") or "auto"
            if photo_type not in PHOTO_TYPES:
                self._error(400, "bad_request", "garment_photo_type must be one of auto, model, flat-lay")
                return
            try:
                job = store.submit(
                    person=person,
                    garment=garment,
                    category=category,
                    photo_type=photo_type,
                    steps=clamp_int(body.get("num_timesteps"), default_steps, 10, 50),
                    seed=clamp_int(body.get("seed"), 42, 0, 2**31 - 1),
                )
            except QueueFull:
                self.close_connection = True
                self._error(429, "rate_limited", "The render queue is full; try again in a minute")
                return
            log.info("job %s queued (%s, %s, %d steps)", job.id[:8], category, photo_type, job.steps)
            self._send(202, {"id": job.id, "status": "queued", "position": store.position(job.id)})

    return Handler


def serve(host: str, port: int, store: JobStore, runner: Runner, info: Callable[[], dict], token: Optional[str], steps: int):
    start_worker(store, runner)
    httpd = ThreadingHTTPServer((host, port), make_handler(store, info, token, steps))
    httpd.daemon_threads = True
    return httpd


def main(argv: Optional[list] = None) -> int:
    p = argparse.ArgumentParser(description="FASHN VTON 1.5 render server for Try-On")
    p.add_argument("--host", default=os.environ.get("VTON_HOST", "127.0.0.1"))
    p.add_argument("--port", type=int, default=int(os.environ.get("VTON_PORT", "7861")))
    p.add_argument("--weights-dir", default=os.environ.get("VTON_WEIGHTS_DIR", os.path.expanduser("~/.cache/tryon-vton/weights")))
    p.add_argument("--device", default=os.environ.get("VTON_DEVICE", "auto"), help="auto, mps, cuda or cpu")
    p.add_argument("--dtype", default=os.environ.get("VTON_DTYPE", "auto"), help="auto, float32, float16 or bfloat16")
    p.add_argument("--steps", type=int, default=int(os.environ.get("VTON_STEPS", "30")), help="default diffusion steps (10-50)")
    p.add_argument("--guidance", type=float, default=float(os.environ.get("VTON_GUIDANCE", "1.5")), help="1.0 skips the unconditional pass (about 2x faster)")
    p.add_argument("--fake", action="store_true", help="no model: return the person photo after a short wait (UI work)")
    args = p.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    token = os.environ.get("VTON_SERVER_TOKEN") or None
    if args.host not in ("127.0.0.1", "localhost", "::1") and not token:
        log.error("Refusing to listen on %s without VTON_SERVER_TOKEN set", args.host)
        return 2

    if args.fake:
        from runner import FakeRunner

        runner_obj = FakeRunner()
    else:
        from runner import FashnRunner

        runner_obj = FashnRunner(args.weights_dir, device=args.device, dtype=args.dtype, guidance=args.guidance)

    store = JobStore()
    httpd = serve(args.host, args.port, store, runner_obj.run, runner_obj.info, token, max(10, min(50, args.steps)))
    log.info("listening on http://%s:%d (%s)", args.host, args.port, json.dumps(runner_obj.info()))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
