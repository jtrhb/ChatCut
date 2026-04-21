/**
 * Preview-render pg-boss job handler (Phase 3 Stage C.7).
 *
 * Extracted from src/index.ts so the full enqueue → poll → log lifecycle
 * is unit-testable with a mock GpuServiceClient. Stage D will grow this
 * with progress emission via safeProgress + tool.progress events; for
 * now it just logs done/failed.
 *
 * The handler is dependency-injected: gpuClient may be null (config
 * missing → stub log + return; queue still drains), and log/warn are
 * pluggable for tests + future structured logging.
 */

import {
  GpuServiceError,
  type GpuServiceClient,
  type EnqueueRenderArgs,
} from "./gpu-service-client.js";
import { pollUntilTerminal, type PollJobOpts } from "./poll-job.js";

// Reviewer Stage C MED #9 (defense-in-depth log-injection guard): all
// IDs that flow into log lines pass through this. Server-generated
// UUIDs always pass; a future code path that lets users supply IDs
// stays safe by default.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
function safeForLog(id: string): string {
  return SAFE_ID_RE.test(id) ? id : "<invalid-id>";
}

export interface PreviewRenderJobData {
  explorationId: string;
  candidateId: string;
  snapshotStorageKey?: string;
  // timelineSnapshot retained on the type for backwards-compat with
  // legacy in-flight jobs (Stage F deletes the field once the queue
  // drains). Stage C.5 reads snapshotStorageKey only.
  timelineSnapshot?: unknown;
  durationSec?: number;
}

export interface PreviewRenderHandlerDeps {
  gpuClient: GpuServiceClient | null;
  log?: (msg: string) => void;
  warn?: (msg: string) => void;
  pollOpts?: PollJobOpts;
}

export async function handlePreviewRender(
  job: { data: PreviewRenderJobData },
  deps: PreviewRenderHandlerDeps,
): Promise<void> {
  const log = deps.log ?? ((msg) => console.log(msg));
  const warn = deps.warn ?? ((msg) => console.warn(msg));
  const { explorationId, candidateId, snapshotStorageKey } = job.data;
  const tag = `explorationId=${safeForLog(explorationId)} candidateId=${safeForLog(candidateId)}`;

  if (!deps.gpuClient) {
    log(`[preview-render stub] ${tag} (gpu-service-client not configured)`);
    return;
  }
  if (!snapshotStorageKey) {
    warn(
      `[preview-render] missing snapshotStorageKey for ${safeForLog(explorationId)}/${safeForLog(candidateId)} — skipping (legacy payload)`,
    );
    return;
  }

  try {
    const args: EnqueueRenderArgs = {
      explorationId,
      candidateId,
      snapshotStorageKey,
    };
    const enq = await deps.gpuClient.enqueueRender(args);
    log(`[preview-render] enqueued ${tag} jobId=${enq.jobId}`);

    const final = await pollUntilTerminal(
      deps.gpuClient,
      enq.jobId,
      deps.pollOpts,
    );
    // pollUntilTerminal returns TerminalJobStatus → state is "done" or "failed".
    // Discriminated union narrows .result vs .error access.
    if (final.state === "done") {
      log(`[preview-render] ${tag} → ${final.result.storage_key}`);
    } else {
      // state === "failed" (synthesized timeout or real GPU failure).
      // Don't re-throw; pg-boss should NOT retry these — real failures
      // aren't transient, and a synthesized timeout means GPU may still
      // be running (retrying would burn another container).
      const synthMarker = final.synthesized ? " [synthesized]" : "";
      warn(`[preview-render] failed${synthMarker}: ${tag} — ${final.error}`);
    }
  } catch (err) {
    // Reviewer Stage C HIGH #3: split transient (network / 5xx) from
    // permanent (4xx / unexpected) errors so pg-boss retries the
    // transient ones. Without this, a single 502 silently kills a
    // candidate's preview with no retry attempt.
    if (
      (err instanceof GpuServiceError && err.status >= 500) ||
      err instanceof TypeError // fetch network failure
    ) {
      warn(
        `[preview-render] transient failure (will retry): ${tag} — ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
    warn(
      `[preview-render] failed: ${tag} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
