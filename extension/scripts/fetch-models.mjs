// Downloads the two MediaPipe models the live mirror uses into extension/vendor/mediapipe/ (git-ignored),
// and checks them against pinned SHA-256 hashes. The build copies them into the extension, so the live
// mirror runs fully on the device: no model or code is fetched at run time.
//
//   npm run fetch-models -w extension
//
// Both models are Apache-2.0, from Google's MediaPipe model storage.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MODELS = [
  {
    file: "pose_landmarker_lite.task",
    url: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
    sha256: "59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a",
  },
  {
    file: "selfie_multiclass_256x256.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite",
    sha256: "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0",
  },
];

export const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "vendor", "mediapipe");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** True when every model is present with the pinned hash. */
export function modelsReady(dir = VENDOR_DIR) {
  return MODELS.every((m) => existsSync(join(dir, m.file)) && sha256(readFileSync(join(dir, m.file))) === m.sha256);
}

async function main() {
  mkdirSync(VENDOR_DIR, { recursive: true });
  for (const m of MODELS) {
    const path = join(VENDOR_DIR, m.file);
    if (existsSync(path) && sha256(readFileSync(path)) === m.sha256) {
      console.log(`ok       ${m.file}`);
      continue;
    }
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`${m.file}: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = sha256(buf);
    if (got !== m.sha256) throw new Error(`${m.file}: SHA-256 ${got} does not match the pinned ${m.sha256}`);
    writeFileSync(path, buf);
    console.log(`fetched  ${m.file} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
