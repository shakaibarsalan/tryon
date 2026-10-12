import { HEADER_IDEMPOTENCY_KEY, HEADER_INSTALL_TOKEN, type InstallToken, type RenderRequest } from "@tryon/shared";
import { createApp, type App } from "../src/app";
import type { Env } from "../src/env";
import { createMockProvider } from "../src/providers/mock";
import type { Provider } from "../src/providers/types";
import { MemoryStore } from "../src/store/memory";
import { bytesToBase64 } from "../src/util";

export function bytes(head: number[], total = 64): Uint8Array {
  const out = new Uint8Array(total);
  out.set(head);
  for (let i = head.length; i < total; i++) out[i] = (i * 7) & 0xff;
  return out;
}

export const PNG_BYTES = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
export const JPEG_BYTES = bytes([0xff, 0xd8, 0xff, 0xe0]);
export const WEBP_BYTES = bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

export const dataUrl = (mime: string, b: Uint8Array) => `data:${mime};base64,${bytesToBase64(b)}`;
export const PERSON = dataUrl("image/png", PNG_BYTES);
export const GARMENT = dataUrl("image/jpeg", JPEG_BYTES);

export function body(overrides: Partial<RenderRequest> = {}): RenderRequest {
  return { person_image: PERSON, garment_image: GARMENT, category: "tops", ...overrides };
}

export function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: undefined as unknown as D1Database,
    ENVIRONMENT: "test",
    PROVIDER: "mock",
    DAILY_BUDGET_USD: "5",
    FREE_RENDERS_PER_INSTALL: "3",
    IP_DAILY_LIMIT: "20",
    FASHN_MODE: "balanced",
    ALLOWED_ORIGINS: "chrome-extension://*,http://localhost:*,http://127.0.0.1:*",
    INSTALL_TOKEN_SECRET: "test-secret-0123456789",
    ...overrides,
  };
}

/** A paid provider for breaker tests: the mock's behaviour with a real-looking price. */
export function paidProvider(cost = 0.075): Provider {
  const mock = createMockProvider();
  return { ...mock, name: "paid", estimateCostUsd: () => cost };
}

export interface Harness {
  app: App;
  store: MemoryStore;
  env: Env;
  call(method: string, path: string, init?: { body?: unknown; headers?: Record<string, string>; raw?: string }): Promise<Response>;
  install(): Promise<InstallToken>;
  render(token: string, b?: unknown, opts?: { key?: string; ip?: string }): Promise<Response>;
  get(token: string, id: string): Promise<Response>;
}

let keyCounter = 0;

export function harness(opts: { env?: Partial<Env>; providers?: Record<string, Provider>; now?: () => number } = {}): Harness {
  const store = new MemoryStore();
  const env = makeEnv(opts.env);
  const app = createApp({
    store: () => store,
    providers: opts.providers ?? { mock: createMockProvider(), paid: paidProvider() },
    now: opts.now,
  });
  const call: Harness["call"] = (method, path, init = {}) => {
    const headers: Record<string, string> = { ...init.headers };
    let reqBody: string | undefined = init.raw;
    if (init.body !== undefined) {
      reqBody = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }
    return app.fetch(new Request(`http://api.test${path}`, { method, headers, body: reqBody }), env);
  };
  return {
    app,
    store,
    env,
    call,
    async install() {
      const res = await call("POST", "/v1/installs");
      if (res.status !== 201) throw new Error(`install failed: ${res.status}`);
      return (await res.json()) as InstallToken;
    },
    render(token, b = body(), o = {}) {
      return call("POST", "/v1/renders", {
        body: b,
        headers: {
          [HEADER_INSTALL_TOKEN]: token,
          [HEADER_IDEMPOTENCY_KEY]: o.key ?? `key-${++keyCounter}`,
          "CF-Connecting-IP": o.ip ?? "203.0.113.7",
        },
      });
    },
    get(token, id) {
      return call("GET", `/v1/renders/${id}`, { headers: { [HEADER_INSTALL_TOKEN]: token } });
    },
  };
}

export async function errorCode(res: Response): Promise<string> {
  const j = (await res.json()) as { error?: { code?: string } };
  return j.error?.code ?? "";
}
