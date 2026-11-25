// The live mirror's two camera models (pose and body segmentation) run in "lanes". A lane takes one
// camera frame at a time and keeps its newest answer; the mirror draws every camera frame with
// whatever answers it has. A worker lane runs its model off the page's thread, so a slow model costs
// freshness, not smoothness: on a slow laptop or phone the picture stays at the camera's rate and the
// garment updates as often as the device manages. An inline lane runs the model on the spot, for
// browsers that can't run it in a worker.

export type LaneTask = "pose" | "segment";

/** The parts of a MediaPipe landmark the mirror uses (x and y are 0..1 across the frame). */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
}

/** The segmenter's answer: one category per pixel (see CLOTHES in mirror/engine.ts). */
export interface MaskAnswer {
  mask: Uint8Array;
  width: number;
  height: number;
}

export type Delegate = "GPU" | "CPU";

/** Page to worker. `delegates` is the order to try them in. */
export type WorkerRequest = { type: "init"; task: LaneTask; base: string; delegates: Delegate[] } | { type: "frame"; frame: ImageBitmap; ts: number };

/** Worker to page. `ms` is how long the model took. */
export type WorkerReply =
  | { type: "ready"; delegate: Delegate }
  | { type: "error"; message: string }
  | { type: "pose"; ts: number; ms: number; landmarks: Landmark[] }
  | { type: "mask"; ts: number; ms: number; mask: Uint8Array | null; width: number; height: number }
  | { type: "skipped"; ts: number; ms: number; message: string };

/** Just what a lane needs from a Worker (and what the tests fake). */
export interface WorkerLike {
  postMessage(message: WorkerRequest, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null;
  onerror?: ((e: Event) => void) | null;
  terminate(): void;
}

export interface LaneStats {
  /** Answers since the last call. */
  answers: number;
  /** Average milliseconds the model took per frame since the last call. */
  ms: number;
}

export interface Lane<T> {
  /** True while a frame is with the model. */
  readonly busy: boolean;
  /** Newest answer, or null before the first. */
  readonly latest: T | null;
  /** Camera time (performance.now() when it was sent) of the frame the newest answer belongs to; -1 before the first. */
  readonly at: number;
  /** Sends the current camera frame, stamped `ts`. Ignored while busy. */
  submit(ts: number): void;
  /** Counts for the speed governor and the developer timings; resets them. */
  stats(): LaneStats;
}

abstract class Counting<T> {
  latest: T | null = null;
  at = -1;
  private answers = 0;
  private frames = 0;
  private spent = 0;

  protected record(ms: number, answer: T | undefined, ts: number): void {
    this.frames++;
    this.spent += ms;
    if (answer === undefined) return;
    this.latest = answer;
    this.at = ts;
    this.answers++;
  }

  stats(): LaneStats {
    const out = { answers: this.answers, ms: this.frames ? this.spent / this.frames : 0 };
    this.answers = this.frames = this.spent = 0;
    return out;
  }
}

/**
 * A model in a Web Worker (see mirror/worker.ts). `grab` copies the current camera frame into an
 * ImageBitmap, which is handed to the worker without another copy.
 */
export class WorkerLane<T> extends Counting<T> implements Lane<T> {
  busy = false;
  private sent = 0;

  constructor(
    private readonly worker: WorkerLike,
    private readonly grab: () => Promise<ImageBitmap>,
    private readonly read: (reply: WorkerReply) => T | undefined,
  ) {
    super();
    worker.onmessage = (e) => this.receive(e.data);
  }

  private receive(reply: WorkerReply): void {
    if (reply.type !== "pose" && reply.type !== "mask" && reply.type !== "skipped") return;
    // One frame is out at a time, so anything else is an answer to a previous mirror session on this worker.
    if (reply.ts !== this.sent) return;
    this.busy = false;
    this.record(reply.ms, reply.type === "skipped" ? undefined : this.read(reply), reply.ts);
  }

  submit(ts: number): void {
    if (this.busy) return;
    this.busy = true;
    this.sent = ts;
    this.grab().then(
      (frame) => this.worker.postMessage({ type: "frame", frame, ts }, [frame]),
      () => {
        this.busy = false;
      },
    );
  }
}

/** A model run right away on this thread (`run` returns undefined when the frame gave no answer). */
export class InlineLane<T> extends Counting<T> implements Lane<T> {
  readonly busy = false;

  constructor(
    private readonly run: (ts: number) => T | undefined,
    private readonly clock: () => number = () => performance.now(),
  ) {
    super();
  }

  submit(ts: number): void {
    const t0 = this.clock();
    let answer: T | undefined;
    try {
      answer = this.run(ts);
    } catch (e) {
      console.debug("[try-on] mirror frame skipped", e);
    }
    this.record(this.clock() - t0, answer, ts);
  }
}

/** Reads a pose reply: the landmarks, an empty list when nobody is in view. */
export const readPose = (r: WorkerReply): Landmark[] | undefined => (r.type === "pose" ? r.landmarks : undefined);

/** Reads a segmentation reply. */
export const readMask = (r: WorkerReply): MaskAnswer | undefined =>
  r.type === "mask" && r.mask ? { mask: r.mask, width: r.width, height: r.height } : undefined;

/**
 * Starts a worker and its model. Resolves once the model is ready, or rejects (bad worker URL, no
 * OffscreenCanvas, the model failed, or no answer within `timeoutMs`); the mirror then runs inline.
 */
export function startWorker(
  make: () => WorkerLike,
  task: LaneTask,
  base: string,
  delegates: Delegate[] = ["GPU", "CPU"],
  timeoutMs = 90_000,
): Promise<{ worker: WorkerLike; delegate: Delegate }> {
  return new Promise((resolve, reject) => {
    let worker: WorkerLike;
    try {
      worker = make();
    } catch (e) {
      reject(e);
      return;
    }
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`the ${task} worker didn't start`));
    }, timeoutMs);
    worker.onerror = (e) => {
      clearTimeout(timer);
      worker.terminate();
      reject(new Error(`the ${task} worker failed to load: ${(e as ErrorEvent).message ?? "script error"}`));
    };
    worker.onmessage = (e) => {
      const r = e.data;
      if (r.type !== "ready" && r.type !== "error") return;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      if (r.type === "ready") resolve({ worker, delegate: r.delegate });
      else {
        worker.terminate();
        reject(new Error(r.message));
      }
    };
    worker.postMessage({ type: "init", task, base, delegates }, []);
  });
}
