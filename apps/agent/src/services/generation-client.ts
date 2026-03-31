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
    pollIntervalMs: number = 5_000
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const status = await this.checkStatus(taskId);

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

    throw new Error(`Task ${taskId} timed out after ${timeoutMs}ms`);
  }
}
