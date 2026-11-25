// Progress text for a render that is still running.
import type { RenderJob } from "@tryon/shared";

/** Progress text for a running job: queue place or percent when the provider reports them. */
export function progressLabel(j: Pick<RenderJob, "status" | "progress" | "queue_position">): string {
  if (j.status === "queued") {
    const ahead = (j.queue_position ?? 1) - 1;
    return ahead > 0 ? `Waiting in line, ${ahead} ahead of you…` : "Waiting in line…";
  }
  if (typeof j.progress === "number" && j.progress > 0 && j.progress < 1) return `Creating your look (${Math.round(j.progress * 100)}%)…`;
  return "Creating your look…";
}
