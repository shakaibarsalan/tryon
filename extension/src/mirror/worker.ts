// Runs one of the live mirror's camera models, the pose landmarker or the body segmenter, off the
// page's thread (see lib/mirror/lanes.ts). The page sends a frame whenever this worker is free and
// draws with the newest answer. Built as its own bundle (mirror-worker.js), next to mirror-engine.js.
import { FilesetResolver, ImageSegmenter, PoseLandmarker } from "@mediapipe/tasks-vision";
import type { Delegate, LaneTask, WorkerReply, WorkerRequest } from "../lib/mirror/lanes";
import { POSE_MODEL, POSE_SETTINGS, SEGMENT_MODEL } from "../lib/mirror/models";

const scope = self as unknown as {
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let run: ((frame: ImageBitmap, ts: number) => void) | undefined;

async function init(task: LaneTask, base: string, delegates: Delegate[]): Promise<Delegate> {
  const vision = await FilesetResolver.forVisionTasks(base);
  let failure: unknown = new Error("no delegate to try");
  for (const delegate of delegates) {
    try {
      if (task === "pose") {
        const pose = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: `${base}/${POSE_MODEL}`, delegate },
          runningMode: "VIDEO",
          ...POSE_SETTINGS,
        });
        run = (frame, ts) => {
          const t0 = performance.now();
          const lm = pose.detectForVideo(frame, ts).landmarks[0] ?? [];
          const landmarks = lm.map(({ x, y, z, visibility }) => ({ x, y, z, visibility }));
          scope.postMessage({ type: "pose", ts, ms: performance.now() - t0, landmarks });
        };
      } else {
        const segmenter = await ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: `${base}/${SEGMENT_MODEL}`, delegate },
          runningMode: "VIDEO",
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        run = (frame, ts) => {
          const t0 = performance.now();
          const result = segmenter.segmentForVideo(frame, ts);
          const cm = result.categoryMask;
          const mask = cm ? cm.getAsUint8Array().slice() : null;
          const width = cm?.width ?? 0;
          const height = cm?.height ?? 0;
          result.close();
          scope.postMessage({ type: "mask", ts, ms: performance.now() - t0, mask, width, height }, mask ? [mask.buffer] : []);
        };
      }
      return delegate;
    } catch (e) {
      failure = e;
    }
  }
  throw failure;
}

scope.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === "init") {
    init(msg.task, msg.base, msg.delegates).then(
      (delegate) => scope.postMessage({ type: "ready", delegate }),
      (err: unknown) => scope.postMessage({ type: "error", message: err instanceof Error ? err.message : String(err) }),
    );
    return;
  }
  const t0 = performance.now();
  try {
    if (!run) throw new Error("the model isn't ready");
    run(msg.frame, msg.ts);
  } catch (err) {
    scope.postMessage({ type: "skipped", ts: msg.ts, ms: performance.now() - t0, message: err instanceof Error ? err.message : String(err) });
  } finally {
    msg.frame.close();
  }
};
