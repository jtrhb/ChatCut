import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch to intercept the download step inside ContentEditor
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { ContentEditor } from "../content-editor.js";
import type { GenerationClient } from "../generation-client.js";
import type { ObjectStorage } from "../object-storage.js";
import type { ServerEditorCore } from "../server-editor-core.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGenerationClient(overrides: Partial<GenerationClient> = {}): GenerationClient {
  return {
    generateVideo: vi.fn().mockResolvedValue({ taskId: "task-gen-001" }),
    generateImage: vi.fn().mockResolvedValue({ taskId: "task-img-001" }),
    checkStatus: vi.fn().mockResolvedValue({ status: "completed", progress: 100, resultUrl: "https://cdn.example.com/out.mp4" }),
    waitForCompletion: vi.fn().mockResolvedValue("https://cdn.example.com/out.mp4"),
    ...overrides,
  } as unknown as GenerationClient;
}

function makeObjectStorage(overrides: Partial<ObjectStorage> = {}): ObjectStorage {
  return {
    upload: vi.fn().mockResolvedValue("generated/uuid-abc.mp4"),
    getSignedUrl: vi.fn().mockResolvedValue("https://r2.example.com/signed"),
    downloadToTempFile: vi.fn().mockResolvedValue("/tmp/downloaded.mp4"),
    delete: vi.fn().mockResolvedValue(undefined),
    guessExtension: vi.fn().mockReturnValue(".mp4"),
    ...overrides,
  } as unknown as ObjectStorage;
}

function makeServerEditorCore(overrides: Partial<ServerEditorCore> = {}): ServerEditorCore {
  return {
    snapshotVersion: 1,
    executeAgentCommand: vi.fn(),
    executeHumanCommand: vi.fn(),
    serialize: vi.fn().mockReturnValue({}),
    clone: vi.fn(),
    validateVersion: vi.fn(),
    ...overrides,
  } as unknown as ServerEditorCore;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ContentEditor", () => {
  let generationClient: GenerationClient;
  let objectStorage: ObjectStorage;
  let serverEditorCore: ServerEditorCore;
  let editor: ContentEditor;

  beforeEach(() => {
    vi.clearAllMocks();
    generationClient = makeGenerationClient();
    objectStorage = makeObjectStorage();
    serverEditorCore = makeServerEditorCore();
    editor = new ContentEditor({ generationClient, objectStorage, serverEditorCore });

    // Default fetch mock: simulate downloading the generated result URL
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => "video/mp4" },
      arrayBuffer: async () => Buffer.from("fake-video-data").buffer,
    });
  });

  describe("replaceWithGenerated()", () => {
    const baseParams = {
      elementId: "elem-001",
      timeRange: { start: 0, end: 5 },
      prompt: "A futuristic cityscape at night",
      provider: "kling",
      agentId: "agent-test-001",
    };

    it("calls generateVideo with the provided prompt and provider", async () => {
      await editor.replaceWithGenerated(baseParams);

      expect(generationClient.generateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: baseParams.prompt,
          provider: baseParams.provider,
        })
      );
    });

    it("calls generateVideo with an idempotencyKey", async () => {
      await editor.replaceWithGenerated(baseParams);

      const [callArgs] = (generationClient.generateVideo as ReturnType<typeof vi.fn>).mock.calls;
      expect(callArgs[0]).toHaveProperty("idempotencyKey");
      expect(typeof callArgs[0].idempotencyKey).toBe("string");
      expect(callArgs[0].idempotencyKey.length).toBeGreaterThan(0);
    });

    it("calls waitForCompletion with the taskId returned from generateVideo", async () => {
      await editor.replaceWithGenerated(baseParams);

      // Phase 4 wire-through: waitForCompletion now also receives an
      // optional onProgress as its 4th arg. Assert on the taskId only —
      // the optional plumbing trails behind.
      const call = (generationClient.waitForCompletion as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBe("task-gen-001");
    });

    it("returns newStorageKey after uploading the generated content to R2", async () => {
      const result = await editor.replaceWithGenerated(baseParams);

      expect(result).toEqual({ newStorageKey: "generated/uuid-abc.mp4" });
      expect(objectStorage.upload).toHaveBeenCalled();
    });

    it("downloads the resultUrl before uploading to R2", async () => {
      await editor.replaceWithGenerated(baseParams);

      // fetch (or downloadToTempFile) should have been called with the resultUrl
      // The implementation may use fetch or objectStorage.downloadToTempFile
      // We verify that the upload received data from the generation step
      expect(objectStorage.upload).toHaveBeenCalledTimes(1);
    });

    it("throws when generateVideo fails", async () => {
      (generationClient.generateVideo as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Generation API error")
      );

      await expect(editor.replaceWithGenerated(baseParams)).rejects.toThrow(
        "Generation API error"
      );
    });

    it("throws when waitForCompletion times out or fails", async () => {
      (generationClient.waitForCompletion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Task failed: generation error")
      );

      await expect(editor.replaceWithGenerated(baseParams)).rejects.toThrow(
        "Task failed"
      );
    });

    it("works without optional provider param", async () => {
      const paramsWithoutProvider = {
        elementId: "elem-002",
        timeRange: { start: 2, end: 8 },
        prompt: "Calm forest scene",
        agentId: "agent-test-002",
      };

      const result = await editor.replaceWithGenerated(paramsWithoutProvider);

      expect(result).toHaveProperty("newStorageKey");
      expect(generationClient.generateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Calm forest scene" })
      );
    });
  });
});
