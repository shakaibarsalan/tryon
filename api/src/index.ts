// Worker entry point: the app with D1 persistence and the default providers.
import { createApp } from "./app";
import type { Env } from "./env";
import { D1Store } from "./store/d1";

const app = createApp({ store: (env: Env) => new D1Store(env.DB) });

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
} satisfies ExportedHandler<Env>;
