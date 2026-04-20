export interface GenerationClientConfig {
  baseUrl: string;
  apiKey: string;
}

export type VideoProvider = "kling" | "seedance" | "veo";

export interface GenerateVideoParams {
  prompt: string;
  provider?: VideoProvider;
  duration?: number;
  refImage?: string;
  idempotencyKey: string;
}

export interface GenerateImageParams {
  prompt: string;
  provider?: string;
  dimensions?: string;
  idempotencyKey: string;
}

export interface TaskStatus {
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  resultUrl?: string;
}

/**
 * Progress callback shape (audit Phase 4 / tool-evolution §6). Emitted
 * once per poll cycle from waitForCompletion so the pipeline can forward
 * `tool.progress` events on the EventBus → SSE → web. Pipeline-side
 * wrappedProgress auto-injects toolName + toolCallId.
 */
export type GenerationProgressUpdate = {
  step: number;
  totalSteps?: number;
  text?: string;
  estimatedRemainingMs?: number;
};
export type GenerationProgressCallback = (update: GenerationProgressUpdate) => void;

/**
 * Progress emit is best-effort. A throwing onProgress must not abort
 * the long-running poll that has already succeeded. Reviewer MEDIUM #1.
 */
function safeProgress(cb: GenerationProgressCallback | undefined, u: GenerationProgressUpdate): void {
  if (!cb) return;
  try { cb(u); } catch { /* best-effort */ }
}

/**
 * Clamp + sanitize the upstream provider's progress field. Upstream is
 * declared `number` with no range constraint — guard against garbage
 * (-1, 200, NaN, undefined) so the SSE event surfaces a clean 0-100.
 * Reviewer MEDIUM #6.
 */
function sanitizePct(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

export class GenerationClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: GenerationClientConfig) {
    this.baseUrl = config.baseUrl;
    this.apiKey = config.apiKey;
  }

  private authHeaders(): Record<string, string> {
    return {
      "Authorization": `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async generateVideo(params: GenerateVideoParams): Promise<{ taskId: string }> {
    const response = await fetch(`${this.baseUrl}/generate/video`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`generateVideo failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<{ taskId: string }>;
  }

  async generateImage(params: GenerateImageParams): Promise<{ taskId: string }> {
    const response = await fetch(`${this.baseUrl}/generate/image`, {
      method: "POST",
      headers: this.authHeaders(),
      body: JSON.stringify(params),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`generateImage failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<{ taskId: string }>;
  }

  async checkStatus(taskId: string): Promise<TaskStatus> {
    const response = await fetch(`${this.baseUrl}/status/${taskId}`, {
      method: "GET",
      headers: this.authHeaders(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`checkStatus failed (${response.status}): ${text}`);
    }

    return response.json() as Promise<TaskStatus>;
  }

  async waitForCompletion(
    taskId: string,
    timeoutMs: number = 300_000,
    pollIntervalMs: number = 5_000,
    onProgress?: GenerationProgressCallback,
  ): Promise<string> {
    const start = Date.now();
    const deadline = start + timeoutMs;
    let pollCount = 0;
    let lastPct = 0;

    while (Date.now() < deadline) {
      const status = await this.checkStatus(taskId);
      pollCount++;
      // status.progress is a 0-100 int from the upstream provider; we
      // pass it through as `step`. Per-poll emission gives the operator
      // a heartbeat even when progress doesn't advance numerically.
      // Monotonic step is enforced at the boundary — backward jumps
      // from a flaky upstream get pinned to the previous max so the
      // SSE consumer sees a non-decreasing progress bar.
      const pct = Math.max(lastPct, sanitizePct(status.progress));
      lastPct = pct;
      // Linear ETA: only meaningful once we have a fix on the rate;
      // stays undefined for very-low and 100 (already done).
      const elapsed = Date.now() - start;
      const eta = pct >= 5 && pct < 100
        ? Math.round((elapsed * (100 - pct)) / pct)
        : undefined;
      safeProgress(onProgress, {
        step: pct,
        totalSteps: 100,
        text: `Generation ${status.status} (${pct}%)`,
        estimatedRemainingMs: eta,
      });

      if (status.status === "completed") {
        if (!status.resultUrl) {
          throw new Error(`Task ${taskId} completed but resultUrl is missing`);
        }
        return status.resultUrl;
      }

      if (status.status === "failed") {
        throw new Error(`Task ${taskId} failed`);
      }

      // Check if we have enough time left for another poll
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;

      await new Promise<void>((resolve) =>
        setTimeout(resolve, Math.min(pollIntervalMs, remaining))
      );
    }

    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms (${pollCount} polls)`);
  }
}
