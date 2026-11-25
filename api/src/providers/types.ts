import type { ApiError, RenderRequest, RenderStatus } from "@tryon/shared";
import type { Env } from "../env";

export interface ProviderPollResult {
  status: RenderStatus;
  /** Data URL of the result, when completed and still available. */
  imageDataUrl?: string;
  error?: ApiError;
  /** 0..1 while processing, when the provider reports it. */
  progress?: number;
  /** Place in the provider's queue (1 = next), when the provider reports it. */
  queuePosition?: number;
}

/** Context passed to poll(); images are never persisted so they are not part of it. */
export type PollContext = Pick<RenderRequest, "category" | "client_ref">;

/**
 * A render provider. start() throws ProviderError on failure; poll() returns a failed status for
 * job-level failures and throws ProviderError (retryable) for transient transport problems.
 * poll() on a completed job must return the image again when the provider still has it.
 */
export interface Provider {
  readonly name: string;
  estimateCostUsd(req: RenderRequest): number;
  start(req: RenderRequest, env: Env): Promise<{ providerJobId: string }>;
  poll(providerJobId: string, env: Env, req?: PollContext): Promise<ProviderPollResult>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
