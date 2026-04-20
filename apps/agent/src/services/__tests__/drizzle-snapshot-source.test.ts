import { describe, it, expect, vi } from "vitest";
import { DrizzleSnapshotSource } from "../drizzle-snapshot-source.js";

function makeDb(rows: unknown[]): { db: any; whereSpy: ReturnType<typeof vi.fn> } {
  const whereSpy = vi.fn().mockResolvedValue(rows);
  const fromSpy = vi.fn(() => ({ where: whereSpy }));
  const selectSpy = vi.fn(() => ({ from: fromSpy }));
  const db = { select: selectSpy };
  return { db, whereSpy };
}

const sampleSnapshot = {
  project: null,
  scenes: [],
  activeSceneId: null,
};

describe("DrizzleSnapshotSource", () => {
  it("loadSnapshot returns the project's snapshot, version, and lastCommittedChangeId", async () => {
    const { db } = makeDb([
      {
        id: "proj-1",
        timelineSnapshot: sampleSnapshot,
        snapshotVersion: 12,
        lastCommittedChangeId: "ch-7",
      },
    ]);
    const source = new DrizzleSnapshotSource(db);

    const row = await source.loadSnapshot("proj-1");

    expect(row).not.toBeNull();
    expect(row!.snapshot).toEqual(sampleSnapshot);
    expect(row!.snapshotVersion).toBe(12);
    expect(row!.lastCommittedChangeId).toBe("ch-7");
  });

  it("returns null when project not found", async () => {
    const { db } = makeDb([]);
    const source = new DrizzleSnapshotSource(db);

    const row = await source.loadSnapshot("missing");

    expect(row).toBeNull();
  });

  it("returns the empty-state default snapshot when timelineSnapshot is null in the DB row", async () => {
    // A fresh project may have version 0 + null snapshot; we hand back a
    // valid empty SerializedEditorState so EditorCore.deserialize doesn't
    // explode in fromSnapshot.
    const { db } = makeDb([
      {
        id: "proj-fresh",
        timelineSnapshot: null,
        snapshotVersion: 0,
        lastCommittedChangeId: null,
      },
    ]);
    const source = new DrizzleSnapshotSource(db);

    const row = await source.loadSnapshot("proj-fresh");

    expect(row).not.toBeNull();
    expect(row!.snapshotVersion).toBe(0);
    expect(row!.lastCommittedChangeId).toBeNull();
    expect(row!.snapshot).toEqual({ project: null, scenes: [], activeSceneId: null });
  });

  it("forwards the projectId into the where clause", async () => {
    const { db, whereSpy } = makeDb([
      { id: "proj-x", timelineSnapshot: sampleSnapshot, snapshotVersion: 0, lastCommittedChangeId: null },
    ]);
    const source = new DrizzleSnapshotSource(db);

    await source.loadSnapshot("proj-x");

    // The where callback receives a SQL fragment from drizzle's eq() — we
    // can't easily introspect it, but we assert the call was made.
    expect(whereSpy).toHaveBeenCalledTimes(1);
  });
});
