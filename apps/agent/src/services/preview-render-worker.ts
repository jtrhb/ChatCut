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

import type {
  GpuServiceClient,
  EnqueueRenderArgs,
} from "./gpu-service-client.js";
import { pollUntilTerminal, type PollJobOpts } from "./poll-job.js";

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
  const tag = `explorationId=${explorationId} candidateId=${candidateId}`;

  if (!deps.gpuClient) {
    log(`[preview-render stub] ${tag} (gpu-service-client not configured)`);
    return;
  }
  if (!snapshotStorageKey) {
    warn(
      `[preview-render] missing snapshotStorageKey for ${explorationId}/${candidateId} — skipping (legacy payload)`,
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
    if (final.state === "done") {
      log(
        `[preview-render] ${tag} → ${final.result?.storage_key ?? "<no key>"}`,
      );
    } else {
      warn(
        `[preview-render] failed: ${tag} — ${final.error ?? "no error msg"}`,
      );
    }
  } catch (err) {
    warn(
      `[preview-render] failed: ${tag} — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
