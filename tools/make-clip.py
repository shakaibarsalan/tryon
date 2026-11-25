"""Builds the demo clip from frames recorded by `node tools/chrome-e2e.mjs --record`.

    python tools/make-clip.py eval/out/demo docs/media/try-on-demo.mp4

The side panel on the right, captions at the bottom. On the left: the store tab while picking,
the live mirror enlarged (cut from the panel frames) while it runs, the store tab during the
render, then the AI result enlarged. Each part runs at its own speed: the pick quickly, the live
mirror in real time, the render's wait sped up (the caption says how long it really took), then
the result held for a few seconds.
Needs numpy, Pillow and imageio-ffmpeg.
"""

import json
import os
import subprocess
import sys

import imageio_ffmpeg
import numpy as np
from PIL import Image, ImageDraw, ImageFont

W, H, FPS = 1280, 720, 30
FONT = "/System/Library/Fonts/Avenir Next.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    try:
        return ImageFont.truetype(FONT, size, index=1 if bold else 0)
    except OSError:
        return ImageFont.load_default()


def fit(img: Image.Image, box_w: int, box_h: int) -> Image.Image:
    s = min(box_w / img.width, box_h / img.height)
    return img.resize((max(1, int(img.width * s)), max(1, int(img.height * s))), Image.LANCZOS)


def light_box(img: Image.Image):
    """The camera picture inside a panel frame: the longest run of rows that are mostly light."""
    a = np.asarray(img).astype(int)
    light = a.sum(axis=2) > 420
    rows = light.mean(axis=1) > 0.75
    best, cur, start = (0, 0, 0), 0, 0
    for y, r in enumerate(rows):
        if r:
            start = y if cur == 0 else start
            cur += 1
            if cur > best[0]:
                best = (cur, start, y)
        else:
            cur = 0
    _, y0, _ = best
    cols = np.where(light[y0 : best[2]].mean(axis=0) > 0.6)[0]
    if not len(cols):
        return None
    x0, x1 = int(cols.min()), int(cols.max())
    return (x0, y0, x1, min(img.height, y0 + int((x1 - x0) * 4 / 3)))


def main(src: str, out: str) -> None:
    index = json.load(open(os.path.join(src, "frames", "index.json")))
    frames = {"store": [], "panel": []}
    marks = {}
    for e in index:
        if e["source"] == "mark":
            marks[e["label"].split(":")[0]] = e["t"]
        else:
            frames[e["source"]].append((e["t"], os.path.join(src, "frames", e["file"])))
    for v in frames.values():
        v.sort()
    t0 = min(f[0][0] for f in frames.values() if f)
    t_mirror = marks.get("mirror", t0)
    t_try = marks.get("try", t_mirror + 8)
    t_done = marks.get("done", t_try + 10)
    render_s = t_done - t_try
    t_end = max(f[-1][0] for f in frames.values() if f)

    # (source start, source end, output seconds, caption)
    segments = [
        (t0, t_mirror, 5.0, "Pick a garment on the store page with the Try on button"),
        (t_mirror, t_try, min(t_try - t_mirror, 11.0), "Live mirror: runs on the laptop, the garment follows you"),
        (t_try, t_done, 6.0, f"Make it real: AI photo on the MacBook, {int(render_s // 60)} min {int(render_s % 60)} s (sped up)"),
        (t_done, max(t_end, t_done + 0.1), 6.0, "The live preview, then the AI photo. Both free, on your own computer"),
    ]

    def latest(source: str, t: float):
        best = None
        for ft, path in frames[source]:
            if ft <= t:
                best = path
            else:
                break
        return best or (frames[source][0][1] if frames[source] else None)

    title = font(30, bold=True)
    small = font(18)
    cache: dict = {}
    # Where the live mirror sits in the panel frames, from a frame in the middle of that part.
    mid_frames = [path for t, path in frames["panel"] if t_mirror + 4 < t < t_try]
    mirror_box = light_box(Image.open(mid_frames[len(mid_frames) // 2]).convert("RGB")) if mid_frames else None
    results = [f for f in os.listdir(src) if f.endswith("-result.jpg")]
    result_img = Image.open(os.path.join(src, results[0])).convert("RGB") if results else None

    def load(path):
        if path not in cache:
            if len(cache) > 64:
                cache.clear()
            cache[path] = Image.open(path).convert("RGB")
        return cache[path]

    writer = subprocess.Popen(
        [imageio_ffmpeg.get_ffmpeg_exe(), "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS),
         "-i", "-", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "medium", "-movflags", "+faststart", out],
        stdin=subprocess.PIPE,
    )
    total = 0.0
    for part, (start, end, seconds, caption) in enumerate(segments):
        n = max(1, int(seconds * FPS))
        for k in range(n):
            t = start + (end - start) * (k / max(1, n - 1)) if end > start else start
            frame = Image.new("RGB", (W, H), (24, 16, 30))
            store_path, panel_path = latest("store", t), latest("panel", t)
            panel_w = 400
            left_w, left_h = W - panel_w - 30, H - 90
            if part == 1 and mirror_box and panel_path:
                big = fit(load(panel_path).crop(mirror_box), left_w, left_h)
                frame.paste(big, (10 + (left_w - big.width) // 2, 10))
            elif part == 3 and result_img is not None:
                # The last live-mirror frame next to the AI photo made from it.
                pair = [fit(result_img, left_w // 2 - 10, left_h - 34)]
                if mirror_box and mid_frames:
                    pair.insert(0, fit(load(mid_frames[-1]).crop(mirror_box), left_w // 2 - 10, left_h - 34))
                labels = ["Live mirror, on the laptop", "AI photo, made on the Mac"][-len(pair):]
                x = 10 + (left_w - sum(im.width for im in pair) - 16 * (len(pair) - 1)) // 2
                d0 = ImageDraw.Draw(frame)
                for im, label in zip(pair, labels):
                    frame.paste(im, (x, 10))
                    d0.text((x + im.width // 2, 10 + im.height + 6), label, font=small, fill=(251, 247, 240), anchor="ma")
                    x += im.width + 16
            elif store_path:
                s = fit(load(store_path), left_w, left_h)
                frame.paste(s, (10 + (left_w - s.width) // 2, 10))
            if panel_path:
                p = fit(load(panel_path), panel_w, H - 90)
                frame.paste(p, (W - panel_w - 10 + (panel_w - p.width) // 2, 10))
            d = ImageDraw.Draw(frame)
            d.rectangle((0, H - 70, W, H), fill=(59, 31, 74))
            d.text((24, H - 56), caption, font=title, fill=(251, 247, 240))
            d.text((W - 24, H - 46), "Try-On", font=small, fill=(217, 164, 65), anchor="ra")
            writer.stdin.write(np.asarray(frame, dtype=np.uint8).tobytes())
        total += seconds
    writer.stdin.close()
    writer.wait()
    print(f"{out}: {total:.1f} s at {FPS} fps, render took {render_s:.0f} s")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
