import { randomUUID } from "crypto";
import type { GenerationClient, GenerationProgressCallback } from "./generation-client.js";
import type { ObjectStorage } from "./object-storage.js";
import type { ServerEditorCore } from "./server-editor-core.js";

export interface ContentEditorDeps {
  generationClient: GenerationClient;
  objectStorage: ObjectStorage;
  serverEditorCore: ServerEditorCore;
}

export interface ReplaceWithGeneratedParams {
  elementId: string;
  timeRange: { start: number; end: number };
  prompt: string;
  provider?: string;
  agentId: string;
}

export interface ReplaceWithGeneratedResult {
  newStorageKey: string;
}

export class ContentEditor {
  private readonly generationClient: GenerationClient;
  private readonly objectStorage: ObjectStorage;
  private readonly serverEditorCore: ServerEditorCore;

  constructor(deps: ContentEditorDeps) {
    this.generationClient = deps.generationClient;
    this.objectStorage = deps.objectStorage;
    this.serverEditorCore = deps.serverEditorCore;
  }

  async replaceWithGenerated(
    params: ReplaceWithGeneratedParams,
    onProgress?: GenerationProgressCallback,
  ): Promise<ReplaceWithGeneratedResult> {
    // 1. Generate idempotency key
    const idempotencyKey = randomUUID();

    // 2. Kick off video generation
    const { taskId } = await this.generationClient.generateVideo({
      prompt: params.prompt,
      provider: params.provider as "kling" | "seedance" | "veo" | undefined,
      idempotencyKey,
    });

    // 3. Wait for completion — returns resultUrl. onProgress is
    // forwarded through so per-poll heartbeat events reach the pipeline
    // and surface as tool.progress on the SSE stream (audit Phase 4
    // wire-through, reviewer HIGH #8).
    const resultUrl = await this.generationClient.waitForCompletion(
      taskId,
      undefined,
      undefined,
      onProgress,
    );

    // 4. Download result and upload to R2
    const response = await fetch(resultUrl);
    if (!response.ok) {
      throw new Error(
        `Failed to download generated content from ${resultUrl}: ${response.status}`
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    const contentType =
      response.headers.get("content-type") ?? "video/mp4";

    const newStorageKey = await this.objectStorage.upload(buffer, {
      contentType,
      prefix: "generated",
    });

    // 5. Return new storage key
    return { newStorageKey };
  }
}
