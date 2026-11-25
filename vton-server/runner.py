"""Runs FASHN VTON 1.5 (github.com/fashn-AI/fashn-vton-1.5) for the render server.

Apple Silicon notes:
  * MPS has no float64, and the model's RoPE helper builds its frequencies in float64, so `rope`
    is swapped for a float32 copy when the device is MPS.
  * MPS attention builds the full attention matrix. With ~6,900 image tokens and the guidance
    batch of 2 that is several GB per layer, and a 32 GB Mac starts swapping. On MPS attention runs
    in chunks of queries instead (VTON_ATTN_CHUNK, default 1024), which gives the same result.
  * The checkpoint is loaded on the CPU and then moved, which avoids safetensors' device loader.
  * DWPose (ONNX) and the human parser run on the CPU unless the device is CUDA, as upstream does.

Before rendering, the person photo is checked with the pose detector already in the pipeline:
exactly one person, and enough of the body for the garment (hips for tops, knees for dresses and
bottoms). `garment_photo_type: "auto"` becomes "model" when a person is found in the garment
photo and "flat-lay" otherwise.
"""

from __future__ import annotations

import io
import logging
import os
import threading
import time
from typing import Dict, List, Optional

from jobs import Job, RenderError

log = logging.getLogger("vton-server")

# COCO body keypoint indices, as DWPose's pose model returns them (before upstream's OpenPose remap).
SHOULDERS = (5, 6)
HIPS = (11, 12)
KNEES = (13, 14)
VISIBLE = 0.3  # upstream KEYPOINT_VISIBILITY_THRESHOLD

NEEDS = {
    "tops": [("shoulders", SHOULDERS), ("hips", HIPS)],
    "bottoms": [("hips", HIPS), ("knees", KNEES)],
    "one-pieces": [("shoulders", SHOULDERS), ("hips", HIPS), ("knees", KNEES)],
}
HINT = {
    "tops": "Use a photo that shows you from the head down to at least your hips.",
    "bottoms": "Use a photo that shows you from the waist down to at least your knees.",
    "one-pieces": "Use a photo that shows you from the head down to at least your knees.",
}


def body_problem(category: str, people: List[Dict]) -> Optional[RenderError]:
    """Checks the people found in the person photo. Returns an error, or None when it's usable.

    Each person is {"area": box area in pixels, "scores": [17 COCO body keypoint scores]}.
    """
    hint = HINT.get(category, HINT["tops"])
    if not people:
        return RenderError("pose_not_found", "We couldn't find a person in your photo. " + hint)
    biggest = max(p["area"] for p in people)
    # People much smaller than the main one (a poster, someone far behind) don't count.
    main = [p for p in people if p["area"] >= 0.2 * biggest]
    if len(main) > 1:
        return RenderError("pose_not_found", "Your photo has more than one person in it. Use a photo of just you.")
    scores = max(people, key=lambda p: p["area"])["scores"]
    missing = [name for name, idx in NEEDS.get(category, NEEDS["tops"]) if not any(scores[i] > VISIBLE for i in idx)]
    if missing:
        return RenderError("pose_not_found", f"Your {' and '.join(missing)} aren't visible in the photo. " + hint)
    return None


class FakeRunner:
    """No model: waits a moment and returns the person photo. For UI work and smoke tests."""

    def __init__(self, seconds: float = 2.0):
        self.seconds = seconds

    def info(self) -> dict:
        return {"ready": True, "device": "fake", "dtype": "none", "model": "fake"}

    def run(self, job: Job) -> bytes:
        for i in range(job.steps):
            job.step = i + 1
            time.sleep(self.seconds / max(1, job.steps))
        if job.person is None:
            raise RenderError("provider_error", "Job has no images")
        return job.person  # already a JPEG/PNG/WebP; the fake doesn't re-encode


class FashnRunner:
    def __init__(self, weights_dir: str, device: str = "auto", dtype: str = "auto", guidance: float = 1.5):
        import torch

        if device == "auto":
            device = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
        self.device = device
        self._lock = threading.Lock()
        self._current: Optional[Job] = None
        self._patch_upstream(device)

        from fashn_vton import TryOnPipeline

        t0 = time.time()
        self.pipe = TryOnPipeline(weights_dir=weights_dir, device=device)
        want = {"float32": torch.float32, "float16": torch.float16, "bfloat16": torch.bfloat16}.get(dtype)
        if want is not None and want != self.pipe.inference_dtype:
            self.pipe.inference_dtype = want
            self.pipe.tryon_model.to(dtype=want)
        self.dtype = str(self.pipe.inference_dtype).replace("torch.", "")
        self.guidance = guidance
        if guidance <= 1.0:
            self._skip_unconditional_pass()
        self.load_s = time.time() - t0
        log.info("FASHN VTON 1.5 loaded on %s (%s) in %.1f s", self.device, self.dtype, self.load_s)

    def _patch_upstream(self, device: str) -> None:
        import torch
        from einops import rearrange
        from fashn_vton import pipeline as pipeline_mod
        from fashn_vton import tryon_mmdit
        from fashn_vton.utils import checkpoint as checkpoint_mod

        if device == "mps":

            def rope(pos, dim: int, theta: int):  # upstream rope() in float32
                assert dim % 2 == 0
                scale = torch.arange(0, dim, 2, dtype=torch.float32, device=pos.device) / dim
                omega = 1.0 / (theta**scale)
                out = torch.einsum("...n,d->...nd", pos.float(), omega)
                out = torch.stack([torch.cos(out), -torch.sin(out), torch.sin(out), torch.cos(out)], dim=-1)
                out = rearrange(out, "b n d (i j) -> b n d i j", i=2, j=2)
                return out.float()

            tryon_mmdit.rope = rope

            chunk = max(128, int(os.environ.get("VTON_ATTN_CHUNK", "1024")))
            sdpa = torch.nn.functional.scaled_dot_product_attention

            def chunked_attention(q, k, v):  # q, k, v: (batch, heads, tokens, dim)
                n = q.shape[2]
                if n <= chunk:
                    return sdpa(q, k, v)
                out = torch.empty_like(q)
                for i in range(0, n, chunk):
                    out[:, :, i : i + chunk] = sdpa(q[:, :, i : i + chunk], k, v)
                return out

            tryon_mmdit._attn_processor = chunked_attention

        original_load = checkpoint_mod.load_checkpoint

        def load_on_cpu(path: str, device: str = "cpu") -> dict:
            return original_load(path, device="cpu")

        pipeline_mod.load_checkpoint = load_on_cpu

        runner = self

        def progress_tqdm(iterable, *args, **kwargs):  # stands in for tqdm in the sampling loop
            for i, item in enumerate(iterable):
                job = runner._current
                if job is not None:
                    job.step = i
                yield item

        pipeline_mod.tqdm = progress_tqdm

    def _skip_unconditional_pass(self) -> None:
        """Guidance 1.0 ignores the unconditional half of the batch, so don't compute it (about 2x faster)."""
        from fashn_vton.utils import compact

        model = self.pipe.tryon_model

        def conditional_only(*args, **kwargs):
            out = model.forward(*args, **compact(kwargs))["x"]
            return {"v_c": out, "v_u": out}

        model.forward_for_cfg = conditional_only

    def info(self) -> dict:
        return {"ready": True, "device": self.device, "dtype": self.dtype, "guidance": self.guidance, "model": "fashn-vton-1.5"}

    def _people(self, rgb) -> List[Dict]:
        """Every person the detector finds: box area and the 17 COCO body keypoint scores."""
        import numpy as np
        from fashn_vton.dwpose.onnxdet import inference_detector
        from fashn_vton.dwpose.onnxpose import inference_pose

        bgr = np.ascontiguousarray(rgb[..., ::-1])
        wholebody = self.pipe.pose_model.pose_estimation
        boxes = inference_detector(wholebody.session_det, bgr)
        if len(boxes) == 0:
            return []
        _, scores = inference_pose(wholebody.session_pose, boxes, bgr)
        return [
            {"area": float((b[2] - b[0]) * (b[3] - b[1])), "scores": [float(x) for x in scores[i, :17]]}
            for i, b in enumerate(boxes)
        ]

    def run(self, job: Job) -> bytes:
        import numpy as np
        from PIL import Image

        if job.person is None or job.garment is None:
            raise RenderError("provider_error", "Job has no images")
        try:
            person = Image.open(io.BytesIO(job.person)).convert("RGB")
            garment = Image.open(io.BytesIO(job.garment)).convert("RGB")
        except Exception:
            raise RenderError("image_invalid", "An image could not be decoded")

        category = "tops" if job.category == "auto" else job.category
        with self._lock:
            t0 = time.time()
            person_small = self.pipe.pre_resize(person, allow_upsampling=False)
            problem = body_problem(category, self._people(np.array(person_small)))
            if problem:
                raise problem
            photo_type = job.photo_type
            if photo_type == "auto":
                garment_small = self.pipe.pre_resize(garment, allow_upsampling=False)
                photo_type = "model" if self._people(np.array(garment_small)) else "flat-lay"
            job.timings["checks"] = time.time() - t0

            t1 = time.time()
            self._current = job
            try:
                out = self.pipe(
                    person_image=person,
                    garment_image=garment,
                    category=category,
                    garment_photo_type=photo_type,
                    num_timesteps=job.steps,
                    guidance_scale=max(1.0, self.guidance),
                    seed=job.seed,
                    segmentation_free=True,
                )
            finally:
                self._current = None
                self._empty_cache()
            job.step = job.steps
            job.timings["render"] = time.time() - t1
            log.info(
                "job %s done: %s %s, %d steps, checks %.1f s, render %.1f s",
                job.id[:8], category, photo_type, job.steps, job.timings["checks"], job.timings["render"],
            )

        buf = io.BytesIO()
        out.images[0].convert("RGB").save(buf, format="JPEG", quality=92)
        return buf.getvalue()

    def _empty_cache(self) -> None:
        try:
            import torch

            if self.device == "mps":
                torch.mps.empty_cache()
            elif self.device == "cuda":
                torch.cuda.empty_cache()
        except Exception:
            pass
