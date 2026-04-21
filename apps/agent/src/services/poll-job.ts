/**
 * Poll a GPU service job until it reaches a terminal state.
 *
 * Stage D upgrade: adaptive backoff (1.5s → 5s after 30s no-change) +
 * `onProgress` callback so the worker can forward `tool.progress` events
 * to the EventBus → SSE → web pipeline. The synthesized timeout failure
 * still fires `onProgress` once before returning so the SSE consumer
 * sees the final terminal state.
 */

import type {
  GpuServiceClient,
  JobStatusResult,
  TerminalJobStatus,
} from "./gpu-service-client.js";

export interface PollJobOpts {
  /** Initial poll interval. Default 1500ms (matches plan §D.1). */
  intervalMs?: number;
  /** Backoff ceiling once progress stalls. Default 5000ms (plan §D.1). */
  maxIntervalMs?: number;
  /** Stagnation window before ramp begins. Default 30_000ms (plan §D.1). */
  noChangeBackoffMs?: number;
  /** Hard ceiling on the poll loop. Default 90_000ms (plan §D.3). */
  timeoutMs?: number;
  /** Injectable for tests; defaults to setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Fires once per poll cycle (including the terminal state, including
   * the synthesized timeout) so callers can forward heartbeats over
   * SSE. Errors thrown by the callback are swallowed — a faulty progress
   * sink must never abort a render that's already running.
   */
  onProgress?: (status: JobStatusResult) => void;
}

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_MAX_INTERVAL_MS = 5000;
const DEFAULT_NO_CHANGE_BACKOFF_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 90_000;

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function safeOnProgress(
  cb: ((status: JobStatusResult) => void) | undefined,
  s: JobStatusResult,
): void {
  if (!cb) return;
  try {
    cb(s);
  } catch {
    /* best-effort — never break the poll loop */
  }
}

/**
 * Poll `client.getJobStatus(jobId)` until the job is `done` or `failed`,
 * or until `timeoutMs` elapses. Backoff: starts at `intervalMs` and ramps
 * to `maxIntervalMs` once `progress` has been unchanged for at least
 * `noChangeBackoffMs`. The cap snaps back to the initial interval the
 * moment progress moves again.
 *
 * On timeout, returns a synthesized `failed` status with `synthesized:
 * true` set so callers can distinguish "GPU said failed" (real failure,
 * no recovery) from "agent timed out, GPU may still be running" (a later
 * poll could reveal a successful render). Reviewer Stage C HIGH #2.
 *
 * Return type is narrowed to TerminalJobStatus so consumers don't
 * need to handle queued/running cases.
 */
export async function pollUntilTerminal(
  client: GpuServiceClient,
  jobId: string,
  opts: PollJobOpts = {},
): Promise<TerminalJobStatus> {
  const initialMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const maxMs = opts.maxIntervalMs ?? DEFAULT_MAX_INTERVAL_MS;
  const backoffStartMs =
    opts.noChangeBackoffMs ?? DEFAULT_NO_CHANGE_BACKOFF_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const onProgress = opts.onProgress;

  const start = now();
  let lastProgress: number | null = null;
  let lastChangeAt = start;

  while (true) {
    const last = await client.getJobStatus(jobId);
    safeOnProgress(onProgress, last);
    if (last.state === "done" || last.state === "failed") {
      return last;
    }
    if (now() - start > timeoutMs) {
      const synth: TerminalJobStatus = {
        job_id: last.job_id,
        state: "failed",
        progress: last.progress,
        error: `polling timeout after ${timeoutMs}ms (synthesized; GPU may still be running)`,
        synthesized: true,
      };
      safeOnProgress(onProgress, synth);
      return synth;
    }
    if (lastProgress === null || last.progress !== lastProgress) {
      lastProgress = last.progress;
      lastChangeAt = now();
    }
    const stagnantFor = now() - lastChangeAt;
    const interval = stagnantFor >= backoffStartMs ? maxMs : initialMs;
    await sleep(interval);
  }
}
