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
  JobStatusResult,
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

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 90_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Poll `client.getJobStatus(jobId)` until the job is `done` or `failed`,
 * or until `timeoutMs` elapses. On timeout, returns a synthesized
 * `failed` status whose error names the timeout — caller treats it the
 * same as any other terminal failure.
 */
export async function pollUntilTerminal(
  client: GpuServiceClient,
  jobId: string,
  opts: PollJobOpts = {},
): Promise<JobStatusResult> {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;

  const start = now();
  let last: JobStatusResult | null = null;
  while (true) {
    last = await client.getJobStatus(jobId);
    if (last.state === "done" || last.state === "failed") {
      return last;
    }
    if (now() - start > timeoutMs) {
      return {
        ...last,
        state: "failed",
        error: `polling timeout after ${timeoutMs}ms`,
      };
    }
    await sleep(intervalMs);
  }
}
