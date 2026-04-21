import { describe, it, expect, vi } from "vitest";
import { DrizzleExplorationLookup } from "../exploration-lookup.js";

function makeFakeDb(rows: Array<Record<string, unknown>>) {
  // Drizzle's chained .select().from().where().limit() — return the
  // final array. The cheapest mock is a builder where every step is
  // self-returning until limit() awaits the rows.
  const builder = {
    from: vi.fn(() => builder),
    where: vi.fn(() => builder),
    limit: vi.fn(async () => rows),
  };
  const db = {
    select: vi.fn(() => builder),
  };
  return { db: db as any, builder };
}

describe("DrizzleExplorationLookup", () => {
  it("returns null when no row matches", async () => {
    const { db } = makeFakeDb([]);
    const lookup = new DrizzleExplorationLookup(db);
    const result = await lookup.getPreviewState({ explorationId: "missing" });
    expect(result).toBeNull();
  });

  it("returns parsed jsonb maps when row exists", async () => {
    const { db } = makeFakeDb([
      {
        previewStorageKeys: { c1: "previews/e1/c1.mp4" },
        previewRenderFailures: { c2: { message: "boom", ts: "2026-04-21" } },
      },
    ]);
    const lookup = new DrizzleExplorationLookup(db);
    const result = await lookup.getPreviewState({ explorationId: "e1" });
    expect(result).toEqual({
      previewStorageKeys: { c1: "previews/e1/c1.mp4" },
      previewRenderFailures: { c2: { message: "boom", ts: "2026-04-21" } },
    });
  });

  it("normalizes nullable jsonb columns to null", async () => {
    const { db } = makeFakeDb([
      { previewStorageKeys: null, previewRenderFailures: null },
    ]);
    const lookup = new DrizzleExplorationLookup(db);
    const result = await lookup.getPreviewState({ explorationId: "e1" });
    expect(result).toEqual({
      previewStorageKeys: null,
      previewRenderFailures: null,
    });
  });

  it("propagates DB errors to caller", async () => {
    const builder = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    };
    const db = { select: vi.fn(() => builder) } as any;
    const lookup = new DrizzleExplorationLookup(db);
    await expect(
      lookup.getPreviewState({ explorationId: "e1" }),
    ).rejects.toThrow("connection refused");
  });
});
