"""Makes a fake webcam video (Y4M) from a still photo, for Chrome's --use-file-for-fake-video-capture.

    python tools/fake-camera.py extension/dev/samples/model.jpg ~/.cache/tryon-e2e/camera.y4m [--speed 3] [--noise 4]

The person sways, leans and steps closer, so the live mirror has motion to track. --speed 3 moves
three times as fast (a sway every 2.7 s, up to about 210 px/s), closer to a person turning in front
of a mirror; --speed 0 stands still. --noise 4 adds a webcam's sensor noise (sigma, out of 255):
identical frames give the pose model nothing to jitter on, which flatters any smoothing. Use only
AI-generated photos here (the repo's samples are made with FLUX.1-schnell), never a real person's.
Needs numpy and Pillow.
"""

import math
import sys

import numpy as np
from PIL import Image

W, H, FPS, SECONDS = 960, 720, 30, 8


def main(src: str, out: str, speed: int = 1, noise: float = 0.0) -> None:
    rng = np.random.default_rng(7)
    photo = Image.open(src).convert("RGB")
    corner = np.array(photo.crop((0, 0, 16, 16))).reshape(-1, 3).mean(axis=0)
    bg = tuple(int(c) for c in corner)
    # Feathered edges, so the pasted photo blends into the backdrop as it moves.
    fade = 80
    ramp = np.minimum(np.arange(photo.width), np.arange(photo.width)[::-1])[None, :]
    rampy = np.minimum(np.arange(photo.height), np.arange(photo.height)[::-1])[:, None]
    edge = np.clip(np.minimum(ramp, rampy) / fade, 0, 1)
    photo_mask = Image.fromarray((edge * 255).astype(np.uint8))
    base_h = H * 0.96
    frames = FPS * SECONDS
    with open(out, "wb") as f:
        f.write(f"YUV4MPEG2 W{W} H{H} F{FPS}:1 Ip A1:1 C420jpeg\n".encode())
        for i in range(frames):
            # A whole number of cycles per loop, so the video repeats without a jump.
            t = i / frames * 2 * math.pi * speed
            scale = 1.0 + 0.06 * math.sin(t)  # steps closer and back
            angle = 4.0 * math.sin(2 * t)  # leans
            dx = 90 * math.sin(t)  # sways
            h = int(base_h * scale)
            w = int(photo.width * h / photo.height)
            person = photo.resize((w, h), Image.BILINEAR).rotate(angle, resample=Image.BILINEAR, expand=True, fillcolor=bg)
            mask = photo_mask.resize((w, h), Image.BILINEAR).rotate(angle, resample=Image.BILINEAR, expand=True, fillcolor=0)
            frame = Image.new("RGB", (W, H), bg)
            frame.paste(person, (int(W / 2 - person.width / 2 + dx), int(H - person.height * 0.98)), mask)
            if noise > 0:
                grainy = np.asarray(frame, dtype=np.float32) + rng.normal(0, noise, (H, W, 3))
                frame = Image.fromarray(np.clip(grainy, 0, 255).astype(np.uint8))
            yuv = np.array(frame.convert("YCbCr"))
            y = yuv[:, :, 0]
            cb = yuv[:, :, 1].reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3)).astype(np.uint8)
            cr = yuv[:, :, 2].reshape(H // 2, 2, W // 2, 2).mean(axis=(1, 3)).astype(np.uint8)
            f.write(b"FRAME\n")
            f.write(y.tobytes())
            f.write(cb.tobytes())
            f.write(cr.tobytes())
    print(f"{out}: {frames} frames, {W}x{H} at {FPS} fps")


if __name__ == "__main__":
    args = sys.argv[1:]
    opts = {"--speed": 1.0, "--noise": 0.0}
    for name in opts:
        if name in args:
            i = args.index(name)
            opts[name] = float(args[i + 1])
            del args[i : i + 2]
    main(args[0], args[1], int(opts["--speed"]), opts["--noise"])
