// Mock provider for UI work and tests. Deterministic: the 1st poll reports "processing", the 2nd "completed".
// The result is an SVG that shows the person photo with the garment overlaid at chest height.
// client_ref "mock:fail" -> provider_error, "mock:pose" -> pose_not_found (both on the 2nd poll),
// "mock:start-fail" -> start() throws provider_error.
// Inputs are kept in this module (isolate memory) for 10 minutes so the SVG can be regenerated:
// fine for local dev, never relied on in production.
import type { RenderRequest } from "@tryon/shared";
import { ProviderError } from "../errors";
import { bytesToBase64, utf8 } from "../util";
import type { PollContext, Provider, ProviderPollResult } from "./types";

const TTL_MS = 10 * 60 * 1000;
const WIDTH = 768;
const HEIGHT = 1024;

interface MockJob {
  person: string;
  garment: string;
  category: string;
  clientRef?: string;
  polls: number;
  createdAt: number;
}

const jobs = new Map<string, MockJob>();
let counter = 0;

function sweep(now: number): void {
  for (const [id, job] of jobs) if (now - job.createdAt > TTL_MS) jobs.delete(id);
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function mockSvg(person: string, garment: string, category: string): string {
  // Chest height: the garment box sits about 22-55% down the frame, centred.
  const gw = Math.round(WIDTH * 0.46);
  const gh = Math.round(HEIGHT * 0.33);
  const gx = Math.round((WIDTH - gw) / 2);
  const gy = Math.round(HEIGHT * 0.22);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="100%" height="100%" fill="#e9e6e1"/>`,
    `<image href="${escapeXml(person)}" x="0" y="0" width="${WIDTH}" height="${HEIGHT}" preserveAspectRatio="xMidYMid slice"/>`,
    `<image href="${escapeXml(garment)}" x="${gx}" y="${gy}" width="${gw}" height="${gh}" preserveAspectRatio="xMidYMid meet" opacity="0.9"/>`,
    `<rect x="0" y="0" width="${WIDTH}" height="64" fill="#000" fill-opacity="0.6"/>`,
    `<text x="${WIDTH / 2}" y="42" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" fill="#fff" text-anchor="middle">MOCK RENDER · ${escapeXml(category)}</text>`,
    `</svg>`,
  ].join("");
}

export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;base64,${bytesToBase64(utf8(svg))}`;
}

export interface MockProviderOptions {
  now?: () => number;
}

export function createMockProvider(opts: MockProviderOptions = {}): Provider {
  const now = opts.now ?? Date.now;
  return {
    name: "mock",
    estimateCostUsd: () => 0,

    async start(req: RenderRequest) {
      const t = now();
      sweep(t);
      if (req.client_ref === "mock:start-fail") {
        throw new ProviderError("provider_error", "Mock provider refused to start (client_ref mock:start-fail)");
      }
      counter += 1;
      const providerJobId = `mock_${t.toString(36)}_${counter}`;
      jobs.set(providerJobId, {
        person: req.person_image,
        garment: req.garment_image,
        category: req.category,
        clientRef: req.client_ref,
        polls: 0,
        createdAt: t,
      });
      return { providerJobId };
    },

    async poll(providerJobId: string, _env, ctx?: PollContext): Promise<ProviderPollResult> {
      const job = jobs.get(providerJobId);
      if (!job || now() - job.createdAt > TTL_MS) {
        jobs.delete(providerJobId);
        return {
          status: "failed",
          error: { code: "provider_error", message: "Mock job expired or unknown (the dev server keeps inputs for 10 minutes)" },
        };
      }
      job.polls += 1;
      if (job.polls < 2) return { status: "processing" };
      const ref = job.clientRef ?? ctx?.client_ref;
      if (ref === "mock:fail") return { status: "failed", error: { code: "provider_error", message: "Mock provider failure" } };
      if (ref === "mock:pose") return { status: "failed", error: { code: "pose_not_found", message: "Mock: no body pose found" } };
      return { status: "completed", imageDataUrl: svgDataUrl(mockSvg(job.person, job.garment, job.category)) };
    },
  };
}

/** Test helper: forget all mock jobs. */
export function resetMockJobs(): void {
  jobs.clear();
}
