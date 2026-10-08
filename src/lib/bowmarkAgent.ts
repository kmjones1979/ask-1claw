import "server-only";
import { run } from "@bowmark/web";

/**
 * EXPERIMENTAL: Bowmark's hosted browser agent (bowmark.browser_agent) driving a task
 * on Bowmark's servers. Used only for the buy_via_bowmark experiment, which is off unless
 * EXPERIMENT_BOWMARK_CHECKOUT=true.
 *
 * Trade-offs vs the browser-bridge path (see README): the agent runs in Bowmark's browser,
 * not your signed-in one; it pauses for a human at a watch link on every login; and its
 * task is plain text, so any card details in it go to Bowmark in plain text.
 */

export type AgentStatus = {
  status: "running" | "needs_input" | "idle" | "failed" | string;
  result?: unknown;
  watchUrl?: string;
  kind?: string;
  [k: string]: unknown;
};

async function runScript<T>(script: string): Promise<T> {
  const env = (await run(script)) as { ok?: boolean; status?: string; result?: T; error?: unknown };
  if (!env.ok || env.status === "error") throw new Error(`Bowmark run failed: ${JSON.stringify(env.error ?? env.status).slice(0, 300)}`);
  return env.result as T;
}

export async function start(task: string, outputSchema?: Record<string, unknown>) {
  return runScript<{ id: string; watchUrl?: string }>(
    `return bowmark.browser_agent.start(${JSON.stringify({ task, ...(outputSchema ? { outputSchema } : {}) })});`,
  );
}

export async function status(id: string, waitMs = 45_000) {
  return runScript<AgentStatus>(`return bowmark.browser_agent.status(${JSON.stringify(id)}, { waitMs: ${waitMs} });`);
}

export async function stop(id: string) {
  await runScript(`return bowmark.browser_agent.stop(${JSON.stringify(id)});`).catch(() => {});
}

/**
 * Starts a task and polls (each poll is its own run, under Bowmark's 90s per-run cap) until it
 * finishes, needs a human, or the deadline passes. Always stops the session (open sessions bill).
 */
export type AgentEvent = {
  phase: "started" | "running" | "needs_input" | "done" | "failed" | "timeout";
  ms: number;
  id?: string;
  watchUrl?: string;
  kind?: string;
  result?: unknown;
  status?: AgentStatus;
};

export async function* runAgent(
  task: string,
  opts: { outputSchema?: Record<string, unknown>; deadlineMs?: number; stopOnNeedsInput?: boolean } = {},
): AsyncGenerator<AgentEvent, void, unknown> {
  const t0 = Date.now();
  const started = await start(task, opts.outputSchema);
  yield { phase: "started", ms: Date.now() - t0, id: started.id, watchUrl: started.watchUrl };
  const deadline = t0 + (opts.deadlineMs ?? 5 * 60_000);
  try {
    while (Date.now() < deadline) {
      const st = await status(started.id, 45_000);
      const ms = Date.now() - t0;
      if (st.status === "idle") {
        yield { phase: "done", ms, result: st.result, status: st };
        return;
      }
      if (st.status === "failed") {
        yield { phase: "failed", ms, status: st };
        return;
      }
      if (st.status === "needs_input") {
        yield { phase: "needs_input", ms, watchUrl: st.watchUrl ?? started.watchUrl, kind: st.kind, status: st };
        if (opts.stopOnNeedsInput) return;
      } else {
        yield { phase: "running", ms };
      }
    }
    yield { phase: "timeout", ms: Date.now() - t0 };
  } finally {
    await stop(started.id);
  }
}
