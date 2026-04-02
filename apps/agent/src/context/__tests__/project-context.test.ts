import { describe, it, expect, beforeEach } from "vitest";
import { ProjectContextManager } from "../project-context.js";

describe("ProjectContextManager", () => {
  let manager: ProjectContextManager;

  beforeEach(() => {
    manager = new ProjectContextManager();
  });

  describe("constructor", () => {
    it("fills defaults when no initial value is provided", () => {
      const ctx = manager.get();
      expect(ctx.timelineState).toBe("");
      expect(ctx.snapshotVersion).toBe(0);
      expect(ctx.videoAnalysis).toBeNull();
      expect(ctx.currentIntent).toEqual({
        raw: "",
        parsed: "",
        explorationMode: false,
      });
      expect(ctx.memoryContext).toEqual({
        promptText: "",
        injectedMemoryIds: [],
        injectedSkillIds: [],
      });
      expect(ctx.artifacts).toEqual({});
      expect(ctx.recentChanges).toEqual([]);
    });

    it("merges provided partial values over defaults", () => {
      const m = new ProjectContextManager({ snapshotVersion: 3, timelineState: "abc" });
      const ctx = m.get();
      expect(ctx.snapshotVersion).toBe(3);
      expect(ctx.timelineState).toBe("abc");
      // other fields still default
      expect(ctx.videoAnalysis).toBeNull();
    });
  });

  describe("get()", () => {
    it("returns the current context", () => {
      const ctx = manager.get();
      expect(ctx).toBeDefined();
      expect(ctx).toHaveProperty("timelineState");
    });

    it("returns a readonly-typed value (structural check)", () => {
      const ctx = manager.get();
      // Can read but TypeScript readonly prevents mutation at type level.
      // Runtime: object reference should be the same shape each call.
      expect(typeof ctx.snapshotVersion).toBe("number");
    });
  });

  describe("updateVideoAnalysis()", () => {
    it("sets videoAnalysis from null to a full object", () => {
      expect(manager.get().videoAnalysis).toBeNull();

      const analysis = {
        scenes: [{ start: 0, end: 5.2, description: "Opening shot" }],
        characters: ["Alice"],
        mood: "tense",
        style: "documentary",
        sourceStorageKey: "s3://bucket/video.mp4",
        analyzedAtSnapshotVersion: 3,
        lastAnalyzedAt: "2026-01-15T10:00:00.000Z",
      };

      manager.updateVideoAnalysis(analysis);
      const ctx = manager.get();

      expect(ctx.videoAnalysis).not.toBeNull();
      expect(ctx.videoAnalysis!.scenes).toHaveLength(1);
      expect(ctx.videoAnalysis!.scenes[0]).toEqual({
        start: 0,
        end: 5.2,
        description: "Opening shot",
      });
      expect(ctx.videoAnalysis!.characters).toEqual(["Alice"]);
      expect(ctx.videoAnalysis!.mood).toBe("tense");
      expect(ctx.videoAnalysis!.style).toBe("documentary");
      expect(ctx.videoAnalysis!.sourceStorageKey).toBe("s3://bucket/video.mp4");
      expect(ctx.videoAnalysis!.analyzedAtSnapshotVersion).toBe(3);
      expect(ctx.videoAnalysis!.lastAnalyzedAt).toBe("2026-01-15T10:00:00.000Z");
    });

    it("replaces a previous videoAnalysis entirely", () => {
      manager.updateVideoAnalysis({
        scenes: [{ start: 0, end: 1, description: "first" }],
        characters: ["A"],
        mood: "calm",
        style: "vlog",
        sourceStorageKey: "key-1",
        analyzedAtSnapshotVersion: 1,
        lastAnalyzedAt: "2026-01-01T00:00:00.000Z",
      });

      manager.updateVideoAnalysis({
        scenes: [
          { start: 0, end: 2, description: "new-first" },
          { start: 2, end: 4, description: "new-second" },
        ],
        characters: ["B", "C"],
        mood: "energetic",
        style: "cinematic",
        sourceStorageKey: "key-2",
        analyzedAtSnapshotVersion: 5,
        lastAnalyzedAt: "2026-03-01T00:00:00.000Z",
      });

      const va = manager.get().videoAnalysis!;
      expect(va.scenes).toHaveLength(2);
      expect(va.characters).toEqual(["B", "C"]);
      expect(va.sourceStorageKey).toBe("key-2");
      expect(va.analyzedAtSnapshotVersion).toBe(5);
    });
  });

  describe("updateTimeline()", () => {
    it("changes timelineState", () => {
      manager.updateTimeline("new-state", 1);
      expect(manager.get().timelineState).toBe("new-state");
    });

    it("changes snapshotVersion", () => {
      manager.updateTimeline("x", 7);
      expect(manager.get().snapshotVersion).toBe(7);
    });

    it("updates both fields atomically", () => {
      manager.updateTimeline("state-v5", 5);
      const ctx = manager.get();
      expect(ctx.timelineState).toBe("state-v5");
      expect(ctx.snapshotVersion).toBe(5);
    });
  });

  describe("setArtifact()", () => {
    it("adds an artifact under the given key", () => {
      manager.setArtifact("key1", {
        producedBy: "agent-1",
        type: "text",
        data: "hello",
        sizeBytes: 5,
        timestamp: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      const ctx = manager.get();
      expect(ctx.artifacts["key1"]).toBeDefined();
      expect(ctx.artifacts["key1"].producedBy).toBe("agent-1");
    });

    it("evicts the oldest artifact by lastAccessedAt when cap of 50 is reached", () => {
      const base = new Date("2024-01-01T00:00:00Z").getTime();

      // Add 50 artifacts with ascending lastAccessedAt
      for (let i = 0; i < 50; i++) {
        const t = new Date(base + i * 1000).toISOString();
        manager.setArtifact(`key${i}`, {
          producedBy: "agent",
          type: "text",
          data: i,
          sizeBytes: 1,
          timestamp: t,
          lastAccessedAt: t,
        });
      }

      expect(Object.keys(manager.get().artifacts).length).toBe(50);

      // Adding a 51st should evict key0 (oldest lastAccessedAt)
      manager.setArtifact("key-new", {
        producedBy: "agent",
        type: "text",
        data: "new",
        sizeBytes: 3,
        timestamp: new Date(base + 100000).toISOString(),
        lastAccessedAt: new Date(base + 100000).toISOString(),
      });

      const artifacts = manager.get().artifacts;
      expect(Object.keys(artifacts).length).toBe(50);
      expect(artifacts["key0"]).toBeUndefined();
      expect(artifacts["key-new"]).toBeDefined();
    });
  });

  describe("getArtifact()", () => {
    it("returns undefined for a missing key", () => {
      expect(manager.getArtifact("nonexistent")).toBeUndefined();
    });

    it("returns the artifact data for an existing key", () => {
      manager.setArtifact("mykey", {
        producedBy: "agent-2",
        type: "json",
        data: { x: 1 },
        sizeBytes: 10,
        timestamp: new Date().toISOString(),
        lastAccessedAt: new Date().toISOString(),
      });
      expect(manager.getArtifact("mykey")).toEqual({ x: 1 });
    });

    it("updates lastAccessedAt on access", async () => {
      const originalTime = new Date("2024-01-01T00:00:00Z").toISOString();
      manager.setArtifact("tracked", {
        producedBy: "agent",
        type: "text",
        data: "data",
        sizeBytes: 4,
        timestamp: originalTime,
        lastAccessedAt: originalTime,
      });

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      manager.getArtifact("tracked");

      const updated = manager.get().artifacts["tracked"];
      expect(updated.lastAccessedAt).not.toBe(originalTime);
      expect(new Date(updated.lastAccessedAt).getTime()).toBeGreaterThan(
        new Date(originalTime).getTime()
      );
    });
  });
});
