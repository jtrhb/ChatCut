/**
 * Preview-render pg-boss job handler (Phase 3 Stage C.7 + Stage D.2).
 *
 * Extracted from src/index.ts so the full enqueue → poll → log → emit
 * lifecycle is unit-testable with a mock GpuServiceClient. Stage D.2
 * forwards `tool.progress` per poll cycle and emits
 * `exploration.candidate_ready` on terminal `done` so the SSE consumer
 * (apps/web) can drive the per-card progress bar and swap in the
 * playable preview without manual polling.
 *
 * The handler is dependency-injected: gpuClient may be null (config
 * missing → stub log + return; queue still drains), eventBus may be
 * null (tests + degraded boot — emission becomes a no-op), and
 * log/warn are pluggable for tests + future structured logging.
 */

import type { EventBus } from "../events/event-bus.js";
import {
  GpuServiceError,
  type GpuServiceClient,
  type EnqueueRenderArgs,
  type JobStatusResult,
} from "./gpu-service-client.js";
import { pollUntilTerminal, type PollJobOpts } from "./poll-job.js";
import type { PreviewWriteback } from "./preview-writeback.js";

// Reviewer Stage C MED #9 (defense-in-depth log-injection guard): all
// IDs that flow into log lines pass through this. Server-generated
// UUIDs always pass; a future code path that lets users supply IDs
// stays safe by default.
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/;
function safeForLog(id: string): string {
  return SAFE_ID_RE.test(id) ? id : "<invalid-id>";
}

/**
 * Clamp + sanitize the upstream progress field so the SSE event surfaces
 * a clean 0-100 even if the GPU service returns garbage (NaN, -1, 200,
 * undefined). Mirrors generation-client's helper (Phase 4 MED #6).
 */
function sanitizePct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Stable per-candidate identifier so the web client can correlate every
 * `tool.progress` event with the right candidate card. The format is
 * intentionally distinct from creator-tool toolCallIds (which are UUIDs)
 * — this is a synthetic id minted by the worker, not by the model.
 */
function previewToolCallId(explorationId: string, candidateId: string): string {
  return `preview-render:${explorationId}:${candidateId}`;
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
  /**
   * Optional event bus for `tool.progress` + `exploration.candidate_ready`
   * emission. When omitted (boot without EventBus, unit tests), the
   * handler still completes and logs but produces no SSE traffic.
   */
  eventBus?: EventBus;
  /**
   * Optional persistence sink (Stage E.2). When supplied, the worker
   * writes terminal `done` to `exploration_sessions.preview_storage_keys`
   * and terminal `failed` to `exploration_sessions.preview_render_failures`
   * so the route layer can serve a stable URL after page reload. Boots
   * without DATABASE_URL pass `null` and the handler simply logs.
   */
  writeback?: PreviewWriteback | null;
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

  const toolCallId = previewToolCallId(explorationId, candidateId);
  const eventBus = deps.eventBus;

  const emitProgress = (status: JobStatusResult): void => {
    if (!eventBus) return;
    const pct = sanitizePct(status.progress);
    let text: string;
    switch (status.state) {
      case "done":
        text = "render complete";
        break;
      case "failed":
        text = `render failed: ${status.error}`;
        break;
      default:
        text = `render ${status.state} (${pct}%)`;
    }
    try {
      eventBus.emit({
        type: "tool.progress",
        timestamp: Date.now(),
        data: {
          toolName: "render_preview",
          toolCallId,
          step: pct,
          totalSteps: 100,
          text,
          explorationId,
          candidateId,
        },
      });
    } catch {
      /* best-effort — never break the worker */
    }
  };

  // Compose the caller-supplied pollOpts.onProgress (if any) with our
  // own emission so existing tests that pass onProgress still see their
  // callback fire alongside the SSE traffic.
  const callerOnProgress = deps.pollOpts?.onProgress;
  const onProgress = (status: JobStatusResult): void => {
    emitProgress(status);
    if (callerOnProgress) {
      try {
        callerOnProgress(status);
      } catch {
        /* best-effort */
      }
    }
  };

  try {
    const args: EnqueueRenderArgs = {
      explorationId,
      candidateId,
      snapshotStorageKey,
    };
    const enq = await deps.gpuClient.enqueueRender(args);
    log(`[preview-render] enqueued ${tag} jobId=${enq.jobId}`);

    const final = await pollUntilTerminal(deps.gpuClient, enq.jobId, {
      ...deps.pollOpts,
      onProgress,
    });
    // pollUntilTerminal returns TerminalJobStatus → state is "done" or "failed".
    // Discriminated union narrows .result vs .error access.
    if (final.state === "done") {
      log(`[preview-render] ${tag} → ${final.result.storage_key}`);
      // Stage E.2: persist the storage key BEFORE emitting candidate_ready.
      // If a slow web client subscribes after the SSE fires (page reload
      // mid-render), the GET /exploration/.../preview/... route falls
      // back to this row to mint a signed URL — so the row needs to win
      // the race against any reload-and-fetch. Writeback failure is
      // logged but does NOT abort the SSE path: the in-flight viewer
      // still sees the preview, only the reload-survival breaks.
      if (deps.writeback) {
        try {
          await deps.writeback.recordSuccess({
            explorationId,
            candidateId,
            storageKey: final.result.storage_key,
          });
        } catch (wbErr) {
          warn(
            `[preview-render] writeback recordSuccess failed (preview still served via SSE): ${tag} — ${
              wbErr instanceof Error ? wbErr.message : String(wbErr)
            }`,
          );
        }
      }
      // Stage D.2 / Stage E.5: emit candidate_ready so apps/web swaps
      // the card to the playable preview. Note: the final tool.progress
      // (100%) was already emitted synchronously inside pollUntilTerminal
      // before we reached this branch — strict ordering tested in
      // preview-render-worker.test.ts §"SSE event sequence (D.4)".
      if (eventBus) {
        try {
          eventBus.emit({
            type: "exploration.candidate_ready",
            timestamp: Date.now(),
            data: {
              explorationId,
              candidateId,
              storageKey: final.result.storage_key,
            },
          });
        } catch {
          /* best-effort */
        }
      }
    } else {
      // state === "failed" (synthesized timeout or real GPU failure).
      // Don't re-throw; pg-boss should NOT retry these — real failures
      // aren't transient, and a synthesized timeout means GPU may still
      // be running (retrying would burn another container).
      const synthMarker = final.synthesized ? " [synthesized]" : "";
      warn(`[preview-render] failed${synthMarker}: ${tag} — ${final.error}`);
      // Stage E.2: persist the failure so the route can serve 422 with
      // a useful message instead of silent 404. Same best-effort
      // semantics — a writeback hiccup must not retry-thrash this job.
      if (deps.writeback) {
        try {
          await deps.writeback.recordFailure({
            explorationId,
            candidateId,
            message: final.error,
            synthesized: final.synthesized,
          });
        } catch (wbErr) {
          warn(
            `[preview-render] writeback recordFailure failed: ${tag} — ${
              wbErr instanceof Error ? wbErr.message : String(wbErr)
            }`,
          );
        }
      }
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
