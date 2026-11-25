"""In-memory job queue. One worker thread runs jobs in order, because one GPU runs one render at a time.

Images live only in memory: a job's inputs are dropped when it ends, and the result is dropped
JOB_TTL_S after that. Nothing is written to disk.
"""

from __future__ import annotations

import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Deque, Dict, List, Optional

JOB_TTL_S = 10 * 60
MAX_QUEUED = 8


class QueueFull(Exception):
    pass


class RenderError(Exception):
    """A job-level failure with an API error code (pose_not_found, image_invalid, provider_error...)."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass
class Job:
    id: str
    category: str
    photo_type: str
    steps: int
    seed: int
    person: Optional[bytes]
    garment: Optional[bytes]
    created: float
    status: str = "queued"  # queued | processing | completed | failed
    started: Optional[float] = None
    finished: Optional[float] = None
    step: int = 0
    result: Optional[bytes] = None  # JPEG bytes
    error: Optional[Dict[str, str]] = None
    timings: Dict[str, float] = field(default_factory=dict)

    def view(self, position: Optional[int] = None) -> dict:
        out: dict = {"id": self.id, "status": self.status}
        if position is not None:
            out["position"] = position
        if self.status == "processing":
            out["progress"] = {"step": self.step, "steps": self.steps}
        if self.finished is not None:
            out["ms"] = int((self.finished - self.created) * 1000)
        if self.timings:
            out["timings_ms"] = {k: int(v * 1000) for k, v in self.timings.items()}
        if self.error:
            out["error"] = dict(self.error)
        return out


Runner = Callable[[Job], bytes]


class JobStore:
    def __init__(self, ttl_s: float = JOB_TTL_S, max_queued: int = MAX_QUEUED, clock: Callable[[], float] = time.time):
        self._jobs: Dict[str, Job] = {}
        self._queue: Deque[str] = deque()
        self._lock = threading.Lock()
        self._ready = threading.Condition(self._lock)
        self._ttl = ttl_s
        self._max = max_queued
        self._clock = clock
        self.busy: Optional[str] = None

    def submit(self, *, person: bytes, garment: bytes, category: str, photo_type: str, steps: int, seed: int) -> Job:
        with self._lock:
            self._sweep()
            if len(self._queue) >= self._max:
                raise QueueFull()
            job = Job(
                id=uuid.uuid4().hex,
                category=category,
                photo_type=photo_type,
                steps=steps,
                seed=seed,
                person=person,
                garment=garment,
                created=self._clock(),
            )
            self._jobs[job.id] = job
            self._queue.append(job.id)
            self._ready.notify()
            return job

    def get(self, job_id: str) -> Optional[Job]:
        with self._lock:
            self._sweep()
            return self._jobs.get(job_id)

    def position(self, job_id: str) -> Optional[int]:
        """1-based place in line for a queued job, counting a running job ahead of it."""
        with self._lock:
            if job_id not in self._queue:
                return None
            return list(self._queue).index(job_id) + 1 + (1 if self.busy else 0)

    def queued(self) -> int:
        with self._lock:
            return len(self._queue)

    def take(self, timeout: Optional[float] = None) -> Optional[Job]:
        """Next queued job (blocks up to `timeout` seconds); marks it processing."""
        with self._ready:
            if not self._queue:
                self._ready.wait(timeout)
            while self._queue:
                job = self._jobs.get(self._queue.popleft())
                if job is None:
                    continue
                job.status = "processing"
                job.started = self._clock()
                self.busy = job.id
                return job
            return None

    def finish(self, job: Job, result: Optional[bytes] = None, error: Optional[RenderError] = None) -> None:
        with self._lock:
            job.finished = self._clock()
            job.person = None
            job.garment = None
            if error is None and result is not None:
                job.status = "completed"
                job.result = result
            else:
                err = error or RenderError("provider_error", "Render produced no image")
                job.status = "failed"
                job.error = {"code": err.code, "message": err.message}
            if self.busy == job.id:
                self.busy = None

    def _sweep(self) -> None:
        now = self._clock()
        for jid in [j.id for j in self._jobs.values() if j.finished is not None and now - j.finished > self._ttl]:
            del self._jobs[jid]


def run_job(store: JobStore, job: Job, runner: Runner) -> None:
    try:
        result = runner(job)
    except RenderError as e:
        store.finish(job, error=e)
    except Exception as e:  # anything else is the server's fault, not the user's
        store.finish(job, error=RenderError("provider_error", f"Render failed: {type(e).__name__}: {e}"[:300]))
    else:
        store.finish(job, result=result)


def worker_loop(store: JobStore, runner: Runner, stop: threading.Event) -> None:
    while not stop.is_set():
        job = store.take(timeout=0.5)
        if job is not None:
            run_job(store, job, runner)


def start_worker(store: JobStore, runner: Runner) -> List[object]:
    stop = threading.Event()
    t = threading.Thread(target=worker_loop, args=(store, runner, stop), name="render-worker", daemon=True)
    t.start()
    return [t, stop]
