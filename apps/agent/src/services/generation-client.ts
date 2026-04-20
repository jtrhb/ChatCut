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
export type GenerationProgressUpdate = { step: number; totalSteps?: number; text?: string };
export type GenerationProgressCallback = (update: GenerationProgressUpdate) => void;

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
    const deadline = Date.now() + timeoutMs;
    let pollCount = 0;

    while (Date.now() < deadline) {
      const status = await this.checkStatus(taskId);
      pollCount++;
      // status.progress is a 0-100 int from the upstream provider — we
      // pass it through as `step`. totalSteps is fixed at 100 so the
      // event reads as "X / 100 percent done" on the wire. Per-poll
      // emission gives the operator a heartbeat even when progress
      // doesn't advance numerically.
      onProgress?.({
        step: status.progress,
        totalSteps: 100,
        text: `Generation ${status.status} (${status.progress}%)`,
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
