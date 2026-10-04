import { createFashnProvider } from "./fashn";
import { createHfSpaceProvider } from "./hf-space";
import { createMockProvider } from "./mock";
import type { Provider } from "./types";

export type { Provider, ProviderPollResult, PollContext, FetchLike } from "./types";

/** Default provider registry; PROVIDER selects one by name. */
export function defaultProviders(): Record<string, Provider> {
  return {
    mock: createMockProvider(),
    fashn: createFashnProvider(),
    "hf-space": createHfSpaceProvider(),
  };
}
