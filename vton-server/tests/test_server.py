"""Tests for the render server's HTTP API, job queue and checks. Stdlib only, no model needed.

Run from the repo root:  python3 -m unittest discover -s vton-server/tests -t vton-server
"""

from __future__ import annotations

import base64
import json
import os
import sys
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from images import ImageError, MAX_IMAGE_BYTES, decode_data_url, sniff_mime, to_data_url  # noqa: E402
from jobs import Job, JobStore, QueueFull, RenderError, run_job  # noqa: E402
from runner import FakeRunner, body_problem  # noqa: E402
import server  # noqa: E402

# Smallest valid-looking images: only the magic bytes are checked here.
JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 60
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 60
WEBP = b"RIFF\x00\x00\x00\x00WEBPVP8 " + b"\x00" * 60


def data_url(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode()}"


def person(scores=None, area=10_000.0):
    s = [0.9] * 17 if scores is None else scores
    return {"area": area, "scores": s}


class ImageTests(unittest.TestCase):
    def test_sniff(self):
        self.assertEqual(sniff_mime(JPEG), "image/jpeg")
        self.assertEqual(sniff_mime(PNG), "image/png")
        self.assertEqual(sniff_mime(WEBP), "image/webp")
        self.assertIsNone(sniff_mime(b"GIF89a"))

    def test_decode_ok(self):
        mime, data = decode_data_url("p", data_url("image/png", PNG))
        self.assertEqual((mime, data), ("image/png", PNG))

    def test_round_trip(self):
        self.assertEqual(decode_data_url("p", to_data_url("image/webp", WEBP))[1], WEBP)

    def test_rejects(self):
        cases = [
            (None, "bad_request"),
            ("", "bad_request"),
            ("https://x/y.jpg", "image_invalid"),
            ("data:image/gif;base64,R0lGODlh", "image_invalid"),
            ("data:image/png;base64,!!!", "image_invalid"),
            (data_url("image/png", JPEG), "image_invalid"),  # content does not match the declared type
            ("data:image/jpeg;base64,", "image_invalid"),
        ]
        for value, code in cases:
            with self.subTest(value=str(value)[:30]):
                with self.assertRaises(ImageError) as cm:
                    decode_data_url("p", value)
                self.assertEqual(cm.exception.code, code)

    def test_too_large(self):
        big = data_url("image/jpeg", JPEG + b"\x00" * MAX_IMAGE_BYTES)
        with self.assertRaises(ImageError) as cm:
            decode_data_url("p", big)
        self.assertEqual(cm.exception.code, "image_too_large")


class BodyCheckTests(unittest.TestCase):
    def test_no_person(self):
        err = body_problem("tops", [])
        self.assertEqual(err.code, "pose_not_found")
        self.assertIn("couldn't find a person", err.message)

    def test_one_person_full_body(self):
        self.assertIsNone(body_problem("one-pieces", [person()]))

    def test_two_people(self):
        err = body_problem("tops", [person(area=10_000), person(area=8_000)])
        self.assertIn("more than one person", err.message)

    def test_small_background_person_is_ignored(self):
        self.assertIsNone(body_problem("tops", [person(area=10_000), person(area=500)]))

    def test_head_and_shoulders_photo(self):
        scores = [0.9] * 17
        for i in (11, 12, 13, 14, 15, 16):  # hips, knees, ankles hidden
            scores[i] = 0.05
        self.assertIn("hips", body_problem("tops", [person(scores)]).message)
        dress = body_problem("one-pieces", [person(scores)])
        self.assertIn("hips and knees", dress.message)
        self.assertIn("down to at least your knees", dress.message)

    def test_one_side_is_enough(self):
        scores = [0.9] * 17
        scores[6] = scores[12] = scores[14] = 0.0  # right shoulder, hip, knee hidden
        self.assertIsNone(body_problem("one-pieces", [person(scores)]))

    def test_upper_body_photo_is_fine_for_tops_not_bottoms(self):
        scores = [0.9] * 17
        for i in (13, 14, 15, 16):
            scores[i] = 0.1
        self.assertIsNone(body_problem("tops", [person(scores)]))
        self.assertIn("knees", body_problem("bottoms", [person(scores)]).message)


class JobStoreTests(unittest.TestCase):
    def make(self, store: JobStore, **kw) -> Job:
        args = dict(person=JPEG, garment=PNG, category="tops", photo_type="auto", steps=10, seed=1)
        args.update(kw)
        return store.submit(**args)

    def test_fifo_and_positions(self):
        store = JobStore()
        a, b = self.make(store), self.make(store)
        self.assertEqual(store.position(a.id), 1)
        self.assertEqual(store.position(b.id), 2)
        taken = store.take(timeout=0)
        self.assertIs(taken, a)
        self.assertEqual(a.status, "processing")
        # b is now behind the running job.
        self.assertEqual(store.position(b.id), 2)
        self.assertIsNone(store.position(a.id))

    def test_queue_limit(self):
        store = JobStore(max_queued=2)
        self.make(store)
        self.make(store)
        with self.assertRaises(QueueFull):
            self.make(store)

    def test_inputs_dropped_and_ttl(self):
        now = [1000.0]
        store = JobStore(ttl_s=60, clock=lambda: now[0])
        job = self.make(store)
        store.take(timeout=0)
        run_job(store, job, lambda j: b"result")
        self.assertEqual(job.status, "completed")
        self.assertIsNone(job.person)
        self.assertIsNone(job.garment)
        self.assertEqual(job.result, b"result")
        now[0] += 61
        self.assertIsNone(store.get(job.id))

    def test_render_error_and_crash(self):
        store = JobStore()
        bad = self.make(store)
        store.take(timeout=0)
        run_job(store, bad, lambda j: (_ for _ in ()).throw(RenderError("pose_not_found", "no person")))
        self.assertEqual(bad.error, {"code": "pose_not_found", "message": "no person"})
        boom = self.make(store)
        store.take(timeout=0)
        run_job(store, boom, lambda j: 1 / 0)
        self.assertEqual(boom.status, "failed")
        self.assertEqual(boom.error["code"], "provider_error")
        self.assertIn("ZeroDivisionError", boom.error["message"])
        self.assertIsNone(store.busy)

    def test_view(self):
        store = JobStore(clock=lambda: 50.0)
        job = self.make(store, steps=20)
        store.take(timeout=0)
        job.step = 7
        self.assertEqual(job.view()["progress"], {"step": 7, "steps": 20})


class HttpTests(unittest.TestCase):
    """Real HTTP on a random local port, with the fake runner."""

    token = None

    def setUp(self):
        self.store = JobStore()
        runner = FakeRunner(seconds=0.05)
        self.httpd = server.serve("127.0.0.1", 0, self.store, runner.run, runner.info, self.token, 30)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def call(self, method, path, body=None, headers=None):
        data = None if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers or {})
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=10) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read())

    def body(self, **kw):
        b = {"person_image": data_url("image/jpeg", JPEG), "garment_image": data_url("image/png", PNG), "category": "tops"}
        b.update(kw)
        return b

    def test_health(self):
        status, body = self.call("GET", "/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertEqual(body["device"], "fake")
        self.assertEqual(body["queued"], 0)

    def test_full_job(self):
        status, job = self.call("POST", "/v1/tryon", self.body(num_timesteps=10))
        self.assertEqual(status, 202)
        self.assertEqual(job["status"], "queued")
        deadline = time.time() + 5
        while time.time() < deadline:
            status, view = self.call("GET", f"/v1/tryon/{job['id']}")
            self.assertEqual(status, 200)
            if view["status"] == "completed":
                break
            time.sleep(0.02)
        self.assertEqual(view["status"], "completed")
        # The fake runner returns the person photo; the MIME is sniffed from the bytes.
        self.assertEqual(view["result_image"], data_url("image/jpeg", JPEG))
        self.assertIn("ms", view)

    def test_validation(self):
        cases = [
            (self.body(category="shoes"), 400, "bad_request"),
            (self.body(garment_photo_type="sketch"), 400, "bad_request"),
            (self.body(person_image="data:image/png;base64,AAAA"), 400, "image_invalid"),
            ([1, 2], 400, "bad_request"),
        ]
        for body, status, code in cases:
            with self.subTest(code=code, body=str(body)[:40]):
                got, res = self.call("POST", "/v1/tryon", body)
                self.assertEqual(got, status)
                self.assertEqual(res["error"]["code"], code)
        got, res = self.call("POST", "/v1/tryon", b"{not json")
        self.assertEqual((got, res["error"]["code"]), (400, "bad_request"))

    def test_steps_are_clamped(self):
        _, job = self.call("POST", "/v1/tryon", self.body(num_timesteps=500, seed=-5))
        stored = self.store.get(job["id"])
        self.assertEqual(stored.steps, 50)
        self.assertEqual(stored.seed, 0)

    def test_unknown(self):
        self.assertEqual(self.call("GET", "/v1/tryon/" + "0" * 32)[0], 404)
        self.assertEqual(self.call("GET", "/nope")[0], 404)
        self.assertEqual(self.call("POST", "/v1/other", {})[0], 404)


class HttpTokenTests(HttpTests):
    token = "s3cret-token"

    def call(self, method, path, body=None, headers=None):
        h = {"Authorization": f"Bearer {self.token}"}
        h.update(headers or {})
        return super().call(method, path, body, h)

    def test_wrong_token(self):
        status, body = HttpTests.call(self, "POST", "/v1/tryon", self.body(), {"Authorization": "Bearer nope"})
        self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"))
        status, _ = HttpTests.call(self, "GET", "/v1/tryon/" + "0" * 32)
        self.assertEqual(status, 401)
        # Health stays open so a load balancer or the API can check it.
        self.assertEqual(HttpTests.call(self, "GET", "/health")[0], 200)


class MainTests(unittest.TestCase):
    def test_refuses_public_bind_without_token(self):
        old = os.environ.pop("VTON_SERVER_TOKEN", None)
        try:
            self.assertEqual(server.main(["--host", "0.0.0.0", "--fake"]), 2)
        finally:
            if old is not None:
                os.environ["VTON_SERVER_TOKEN"] = old


if __name__ == "__main__":
    unittest.main()
