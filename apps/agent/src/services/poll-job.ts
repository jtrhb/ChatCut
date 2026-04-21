/**
 * Poll a GPU service job until it reaches a terminal state.
 *
 * Stage C.5 helper. Stage D will grow this with progress emission via
 * safeProgress + tool.progress events; for now it just returns the
 * final status (or a synthetic "failed" with a timeout error if the
 * deadline is hit before the job terminates).
 */

import type {
  GpuServiceClient,
  TerminalJobStatus,
} from "./gpu-service-client.js";

export interface PollJobOpts {
  /** Time between polls. Default 1500ms (matches plan §D.1). */
  intervalMs?: number;
  /** Hard ceiling. Default 90_000ms (matches plan §D.3). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}

// Reviewer Stage C LOW #1: these match the plan §D.1/§D.3 contract.
// Stage D will replace with backoff (1.5s → 5s after 30s no-change);
// keeping in sync with the plan doc is a manual responsibility until then.
const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 90_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `client.getJobStatus(jobId)` until the job is `done` or `failed`,
 * or until `timeoutMs` elapses. On timeout, returns a synthesized
 * `failed` status with `synthesized: true` set so callers can
 * distinguish "GPU said failed" (real failure, no recovery) from
 * "agent timed out, GPU may still be running" (a later poll could
 * reveal a successful render). Reviewer Stage C HIGH #2.
 *
 * Return type is narrowed to TerminalJobStatus so consumers don't
 * need to handle queued/running cases.
 */
export async function pollUntilTerminal(
  client: GpuServiceClient,
  jobId: string,
  opts: PollJobOpts = {},
): Promise<TerminalJobStatus> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const start = now();
  while (true) {
    const last = await client.getJobStatus(jobId);
    if (last.state === "done" || last.state === "failed") {
      return last;
    }
    if (now() - start > timeoutMs) {
      return {
        job_id: last.job_id,
        state: "failed",
        progress: last.progress,
        error: `polling timeout after ${timeoutMs}ms (synthesized; GPU may still be running)`,
        synthesized: true,
      };
    }
    await sleep(intervalMs);
  }
}
