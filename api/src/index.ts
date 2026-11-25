// Worker entry point: the app with D1 persistence and the default providers, plus the nightly
// retention cleanup (cron trigger in wrangler.toml).
import { createApp } from "./app";
import type { Env } from "./env";
import { purgeOld } from "./retention";
import { D1Store } from "./store/d1";

const app = createApp({ store: (env: Env) => new D1Store(env.DB) });

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),
  scheduled: (_event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(purgeOld(new D1Store(env.DB), Date.now()));
  },
} satisfies ExportedHandler<Env>;
