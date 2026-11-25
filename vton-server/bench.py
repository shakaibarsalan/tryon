"""Times FASHN VTON 1.5 renders on this machine with the sample photos.

    python bench.py --steps 30 --dtype float32 --out ../eval/out/bench

The samples in extension/dev/samples are AI-generated (FLUX.1-schnell), so no real person's photo
is used. Prints one JSON line per render and writes the results as JPEGs to --out.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import threading
import time
import uuid

from jobs import Job
from runner import FashnRunner

HERE = os.path.dirname(os.path.abspath(__file__))
SAMPLES = os.path.join(HERE, "..", "extension", "dev", "samples")
DEFAULT_GARMENTS = ["kurti.jpg:tops", "shirt.jpg:tops", "dress.jpg:one-pieces"]


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--weights-dir", default=os.environ.get("VTON_WEIGHTS_DIR", os.path.expanduser("~/.cache/tryon-vton/weights")))
    p.add_argument("--device", default="auto")
    p.add_argument("--dtype", default="auto")
    p.add_argument("--steps", type=int, default=30)
    p.add_argument("--guidance", type=float, default=1.5, help="1.0 skips the unconditional pass (about 2x faster)")
    p.add_argument("--person", default=os.path.join(SAMPLES, "model.jpg"))
    p.add_argument("--garment", action="append", help="file[:category], relative to the samples folder or absolute")
    p.add_argument("--photo-type", default="auto", choices=["auto", "model", "flat-lay"])
    p.add_argument("--out", default=os.path.join(HERE, "..", "eval", "out", "bench"))
    args = p.parse_args()

    os.makedirs(args.out, exist_ok=True)
    with open(args.person, "rb") as f:
        person = f.read()

    t0 = time.time()
    runner = FashnRunner(args.weights_dir, device=args.device, dtype=args.dtype, guidance=args.guidance)
    print(json.dumps({"event": "loaded", "device": runner.device, "dtype": runner.dtype, "seconds": round(time.time() - t0, 1)}), flush=True)

    for spec in args.garment or DEFAULT_GARMENTS:
        name, _, category = spec.partition(":")
        path = name if os.path.isabs(name) else os.path.join(SAMPLES, name)
        with open(path, "rb") as f:
            garment = f.read()
        job = Job(
            id=uuid.uuid4().hex,
            category=category or "auto",
            photo_type=args.photo_type,
            steps=args.steps,
            seed=42,
            person=person,
            garment=garment,
            created=time.time(),
        )
        start = time.time()
        done = threading.Event()

        def report() -> None:  # progress every 15 s, so a slow machine shows it's alive
            while not done.wait(15):
                print(json.dumps({"event": "progress", "step": job.step, "steps": job.steps, "seconds": round(time.time() - start)}), flush=True)

        threading.Thread(target=report, daemon=True).start()
        try:
            result = runner.run(job)
        finally:
            done.set()
        seconds = time.time() - start
        stem = os.path.splitext(os.path.basename(name))[0]
        out_path = os.path.join(args.out, f"{stem}-{runner.dtype}-{args.steps}-g{args.guidance:g}.jpg")
        with open(out_path, "wb") as f:
            f.write(result)
        print(json.dumps({
            "event": "render",
            "garment": stem,
            "category": job.category,
            "steps": args.steps,
            "dtype": runner.dtype,
            "guidance": args.guidance,
            "seconds": round(seconds, 1),
            "checks_s": round(job.timings.get("checks", 0), 1),
            "render_s": round(job.timings.get("render", 0), 1),
            "out": out_path,
        }), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
