import { afterEach, describe, expect, it, vi } from "vitest";
import { InlineLane, WorkerLane, readMask, readPose, startWorker, type Landmark, type MaskAnswer, type WorkerLike, type WorkerReply, type WorkerRequest } from "../src/lib/mirror/lanes";

class FakeWorker implements WorkerLike {
  sent: { message: WorkerRequest; transfer: Transferable[] }[] = [];
  onmessage: ((e: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  terminated = false;
  postMessage(message: WorkerRequest, transfer: Transferable[]): void {
    this.sent.push({ message, transfer });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(r: WorkerReply): void {
    this.onmessage?.({ data: r } as MessageEvent<WorkerReply>);
  }
}

const bitmap = () => ({ close() {} }) as unknown as ImageBitmap;
const flush = () => new Promise((r) => setTimeout(r, 0));
const shoulder: Landmark = { x: 0.4, y: 0.3, z: 0, visibility: 0.9 };

describe("worker lane", () => {
  it("sends one frame at a time and keeps the newest answer", async () => {
    const w = new FakeWorker();
    const lane = new WorkerLane<Landmark[]>(w, async () => bitmap(), readPose);
    expect(lane.at).toBe(-1);
    lane.submit(100);
    lane.submit(110); // busy: ignored
    await flush();
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]!.message).toMatchObject({ type: "frame", ts: 100 });
    expect(w.sent[0]!.transfer).toHaveLength(1); // the bitmap is handed over, not copied
    expect(lane.busy).toBe(true);

    w.reply({ type: "pose", ts: 100, ms: 20, landmarks: [shoulder] });
    expect(lane.busy).toBe(false);
    expect(lane.at).toBe(100);
    expect(lane.latest).toEqual([shoulder]);

    lane.submit(140);
    await flush();
    w.reply({ type: "pose", ts: 140, ms: 30, landmarks: [] }); // nobody in view is an answer too
    expect(lane.latest).toEqual([]);
    expect(lane.stats()).toEqual({ answers: 2, ms: 25 });
    expect(lane.stats()).toEqual({ answers: 0, ms: 0 });
  });

  it("ignores answers left over from an earlier session on the same worker", async () => {
    const w = new FakeWorker();
    const lane = new WorkerLane<MaskAnswer>(w, async () => bitmap(), readMask);
    lane.submit(500);
    await flush();
    w.reply({ type: "mask", ts: 420, ms: 60, mask: new Uint8Array(4), width: 2, height: 2 });
    expect(lane.busy).toBe(true);
    expect(lane.latest).toBeNull();
    w.reply({ type: "mask", ts: 500, ms: 60, mask: new Uint8Array([4, 4, 0, 2]), width: 2, height: 2 });
    expect(lane.latest?.mask).toEqual(new Uint8Array([4, 4, 0, 2]));
    expect(lane.at).toBe(500);
  });

  it("frees itself when a frame is skipped or can't be grabbed", async () => {
    const w = new FakeWorker();
    let fail = true;
    const lane = new WorkerLane<Landmark[]>(w, async () => (fail ? Promise.reject(new Error("no frame")) : bitmap()), readPose);
    lane.submit(10);
    await flush();
    expect(lane.busy).toBe(false);
    expect(w.sent).toHaveLength(0);
    fail = false;
    lane.submit(20);
    await flush();
    w.reply({ type: "skipped", ts: 20, ms: 1, message: "the model isn't ready" });
    expect(lane.busy).toBe(false);
    expect(lane.latest).toBeNull();
    expect(lane.stats()).toEqual({ answers: 0, ms: 1 });
  });
});

describe("inline lane", () => {
  it("answers on the spot and keeps the last answer when a frame gives none", () => {
    let now = 0;
    const answers: (Landmark[] | undefined)[] = [[shoulder], undefined];
    const lane = new InlineLane<Landmark[]>(
      () => {
        now += 40;
        return answers.shift();
      },
      () => now,
    );
    lane.submit(1);
    expect(lane.latest).toEqual([shoulder]);
    lane.submit(2);
    expect(lane.latest).toEqual([shoulder]);
    expect(lane.at).toBe(1);
    expect(lane.stats()).toEqual({ answers: 1, ms: 40 });
  });

  it("survives a model error", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const lane = new InlineLane<Landmark[]>(() => {
      throw new Error("GPU lost");
    });
    expect(() => lane.submit(5)).not.toThrow();
    expect(lane.latest).toBeNull();
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });
});

describe("starting a worker", () => {
  afterEach(() => vi.useRealTimers());

  it("asks for the model and resolves once it is ready", async () => {
    const w = new FakeWorker();
    const started = startWorker(() => w, "segment", "https://example.test/mediapipe", ["GPU", "CPU"]);
    expect(w.sent[0]!.message).toEqual({ type: "init", task: "segment", base: "https://example.test/mediapipe", delegates: ["GPU", "CPU"] });
    w.reply({ type: "ready", delegate: "GPU" });
    await expect(started).resolves.toEqual({ worker: w, delegate: "GPU" });
    expect(w.onmessage).toBeNull(); // the lane takes over the messages
  });

  it("rejects, and stops the worker, when the model fails or the script doesn't load", async () => {
    const a = new FakeWorker();
    const failed = startWorker(() => a, "pose", "/m");
    a.reply({ type: "error", message: "no WebGL2" });
    await expect(failed).rejects.toThrow("no WebGL2");
    expect(a.terminated).toBe(true);

    const b = new FakeWorker();
    const missing = startWorker(() => b, "pose", "/m");
    b.onerror?.(new Event("error"));
    await expect(missing).rejects.toThrow("failed to load");
    expect(b.terminated).toBe(true);

    await expect(
      startWorker(() => {
        throw new Error("SecurityError");
      }, "pose", "/m"),
    ).rejects.toThrow("SecurityError");
  });

  it("gives up when the worker never answers", async () => {
    vi.useFakeTimers();
    const w = new FakeWorker();
    const started = startWorker(() => w, "pose", "/m", ["CPU"], 5000);
    const check = expect(started).rejects.toThrow("didn't start");
    await vi.advanceTimersByTimeAsync(5001);
    await check;
    expect(w.terminated).toBe(true);
  });
});

describe("reading worker replies", () => {
  it("takes landmarks from pose replies and masks from mask replies only", () => {
    expect(readPose({ type: "pose", ts: 1, ms: 1, landmarks: [shoulder] })).toEqual([shoulder]);
    expect(readPose({ type: "mask", ts: 1, ms: 1, mask: null, width: 0, height: 0 })).toBeUndefined();
    expect(readMask({ type: "mask", ts: 1, ms: 1, mask: null, width: 0, height: 0 })).toBeUndefined();
    const m = new Uint8Array(4);
    expect(readMask({ type: "mask", ts: 1, ms: 1, mask: m, width: 2, height: 2 })).toEqual({ mask: m, width: 2, height: 2 });
  });
});
