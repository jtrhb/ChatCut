import { describe, it, expect, vi } from "vitest";
import { DrizzlePreviewWriteback } from "../preview-writeback.js";

function makeFakeDb(executeImpl?: (q: unknown) => Promise<void>) {
  const calls: unknown[] = [];
  const db = {
    async execute(q: unknown): Promise<void> {
      calls.push(q);
      if (executeImpl) await executeImpl(q);
    },
  };
  return { db: db as any, calls };
}

// Drizzle's `sql` template returns a SQL chunk with .queryChunks holding
// strings + params. Asserting on the rendered SQL string is brittle, so
// we just verify the call shape: db.execute was invoked exactly once
// per writeback method, and validation rejects unsafe ids before hitting
// the db.

describe("DrizzlePreviewWriteback", () => {
  describe("recordSuccess", () => {
    it("calls db.execute exactly once with a SQL chunk", async () => {
      const { db, calls } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await wb.recordSuccess({
        explorationId: "exp-1",
        candidateId: "cand-1",
        storageKey: "previews/exp-1/cand-1.mp4",
      });
      expect(calls.length).toBe(1);
    });

    it("rejects unsafe explorationId (path-injection guard)", async () => {
      const { db } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await expect(
        wb.recordSuccess({
          explorationId: "exp/../etc",
          candidateId: "cand-1",
          storageKey: "previews/x/y.mp4",
        }),
      ).rejects.toThrow(/explorationId.*unsafe/);
    });

    it("rejects unsafe candidateId", async () => {
      const { db } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await expect(
        wb.recordSuccess({
          explorationId: "exp-1",
          candidateId: "cand;DROP",
          storageKey: "previews/x/y.mp4",
        }),
      ).rejects.toThrow(/candidateId.*unsafe/);
    });

    it("propagates db errors to the caller", async () => {
      const { db } = makeFakeDb(async () => {
        throw new Error("connection refused");
      });
      const wb = new DrizzlePreviewWriteback(db);
      await expect(
        wb.recordSuccess({
          explorationId: "exp-1",
          candidateId: "cand-1",
          storageKey: "previews/x/y.mp4",
        }),
      ).rejects.toThrow("connection refused");
    });
  });

  describe("recordFailure", () => {
    it("calls db.execute exactly once", async () => {
      const { db, calls } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await wb.recordFailure({
        explorationId: "exp-1",
        candidateId: "cand-1",
        message: "melt subprocess crashed",
      });
      expect(calls.length).toBe(1);
    });

    it("includes synthesized flag when provided", async () => {
      const { db, calls } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await wb.recordFailure({
        explorationId: "exp-1",
        candidateId: "cand-1",
        message: "polling timeout after 90000ms",
        synthesized: true,
      });
      // Inspect the SQL params to confirm the JSON payload includes
      // "synthesized":true. Drizzle's sql chunk exposes .queryChunks
      // for inspection in tests.
      const chunk = calls[0] as { queryChunks?: unknown[] };
      const serialized = JSON.stringify(chunk.queryChunks ?? []);
      expect(serialized).toContain("synthesized");
    });

    it("payload includes ISO timestamp", async () => {
      const { db, calls } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await wb.recordFailure({
        explorationId: "exp-1",
        candidateId: "cand-1",
        message: "boom",
      });
      const chunk = calls[0] as { queryChunks?: unknown[] };
      const serialized = JSON.stringify(chunk.queryChunks ?? []);
      // ISO 8601 fingerprint
      expect(serialized).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("rejects unsafe explorationId", async () => {
      const { db } = makeFakeDb();
      const wb = new DrizzlePreviewWriteback(db);
      await expect(
        wb.recordFailure({
          explorationId: "exp\nINJECTED",
          candidateId: "cand-1",
          message: "boom",
        }),
      ).rejects.toThrow(/explorationId.*unsafe/);
    });
  });

  it("safe ids accepted: UUIDs, alphanumeric, dashes, underscores", async () => {
    const { db } = makeFakeDb();
    const wb = new DrizzlePreviewWriteback(db);
    // UUID-shaped + dashed + underscored — all should pass validation.
    await wb.recordSuccess({
      explorationId: "12345678-1234-1234-1234-123456789012",
      candidateId: "A_b-1",
      storageKey: "previews/x/y.mp4",
    });
    // Spy on calls implicitly via lack of throw.
  });

  it("rejects empty ids", async () => {
    const { db } = makeFakeDb();
    const wb = new DrizzlePreviewWriteback(db);
    await expect(
      wb.recordSuccess({
        explorationId: "",
        candidateId: "cand-1",
        storageKey: "previews/x/y.mp4",
      }),
    ).rejects.toThrow(/explorationId.*unsafe/);
  });
});
