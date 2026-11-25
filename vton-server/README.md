# vton-server: FASHN VTON 1.5 for the self-hosted provider

A small Python server that runs the open [FASHN VTON 1.5](https://github.com/fashn-AI/fashn-vton-1.5) try-on model and answers the Try-On API's `self-hosted` provider. It runs on Apple Silicon (PyTorch's Metal backend, "MPS"), on an NVIDIA GPU, or very slowly on a CPU.

## Set it up on a Mac

Python 3.12 and about 3 GB of disk for the weights.

```bash
git clone https://github.com/fashn-AI/fashn-vton-1.5 ../vton-upstream/fashn-vton-1.5
cd ../vton-upstream
uv venv --python 3.12 .venv && source .venv/bin/activate
uv pip install torch torchvision safetensors huggingface_hub pillow numpy opencv-python-headless tqdm einops onnxruntime matplotlib fashn-human-parser
uv pip install --no-deps -e ./fashn-vton-1.5      # --no-deps: upstream asks for onnxruntime-gpu, which macOS doesn't have
python fashn-vton-1.5/scripts/download_weights.py --weights-dir ~/.cache/tryon-vton/weights
```

Then, from this folder:

```bash
python server.py --port 7861 --dtype float16 --steps 10 --guidance 1.0
```

and start the API with `--var PROVIDER:self-hosted` (see the main README).

## What it changes for Apple Silicon

- The model builds its RoPE frequencies in float64, which MPS doesn't support. `runner.py` swaps in a float32 copy.
- Attention builds the full attention matrix: about 6,900 image tokens and a batch of 2 for guidance came to several GB per layer, and a 32 GB Mac swapped (24.8 GB of GPU memory in use, no result after ten minutes). On MPS attention runs in chunks of 1024 queries (`VTON_ATTN_CHUNK`), with the same result.
- `--guidance 1.0` skips the unconditional half of every step, which halves the time.

## Speed

One render of the repo's sample model on a MacBook Pro M1 Pro (32 GB), measured with `bench.py`:

| Settings | Time per render |
|---|---|
| float16, 10 steps, guidance 1.0 | 93-103 s (shirt, kurti, dress) |
| float16, 10 steps, guidance 1.5 | 167 s |

```bash
python bench.py --steps 10 --dtype float16 --guidance 1.0
```

writes the renders to `eval/out/bench` (git-ignored). The sample photos are AI-generated.

## API

| Route | Body or answer |
|---|---|
| `POST /v1/tryon` | `{person_image, garment_image, category, garment_photo_type?, num_timesteps?, seed?}`, data URLs (jpeg, png, webp, 1.5 MB each). Answers `202 {id, status: "queued", position}` |
| `GET /v1/tryon/<id>` | `{id, status, position?, progress?: {step, steps}, result_image?, error?, ms?}` |
| `GET /health` | `{ok, device, dtype, guidance, queued, busy}` |

Jobs run one at a time on one worker thread (one GPU), with at most 8 waiting. Images live in memory only: a job's inputs are dropped when it ends and its result 10 minutes later.

Before rendering, the person photo is checked with the pose model already in the pipeline: it has to show one person, and enough of the body for the garment (hips for tops, knees for dresses and bottoms). A failed check answers `pose_not_found` with a plain reason. `garment_photo_type: "auto"` becomes `model` when a person is in the garment photo and `flat-lay` otherwise.

Set `VTON_SERVER_TOKEN` to require `Authorization: Bearer <token>` on `/v1`. The server refuses to listen on anything but localhost without a token.

## Tests

```bash
python3 -m unittest discover -s vton-server/tests
```

29 tests, standard library only (no model needed): data URL checks, the job queue, the body check, and the HTTP API with a fake runner.

## Licence

The server code is MIT, like the rest of the repo. FASHN VTON 1.5 is Apache-2.0, but its human parser ([fashn-human-parser](https://github.com/fashn-AI/fashn-human-parser)) uses NVIDIA's SegFormer licence, which is non-commercial. Use this for personal and non-commercial work, or swap the parser first.
