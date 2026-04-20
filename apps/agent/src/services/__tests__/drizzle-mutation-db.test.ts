import { describe, it, expect, vi } from "vitest";
import { DrizzleMutationDB } from "../drizzle-mutation-db.js";
import type { NewChangeLogEntry } from "../commit-mutation.js";

function makeTx(opts: {
  insertedId?: string;
  nextSequence?: number;
} = {}): {
  tx: any;
  insertValuesSpy: ReturnType<typeof vi.fn>;
  updateSetSpy: ReturnType<typeof vi.fn>;
  selectFromSpy: ReturnType<typeof vi.fn>;
} {
  const insertedId = opts.insertedId ?? "ch-1";
  const nextSequence = opts.nextSequence ?? 1;

  // .insert(table).values(row).returning() → [{ id }]
  const returningSpy = vi.fn().mockResolvedValue([{ id: insertedId }]);
  const insertValuesSpy = vi.fn(() => ({ returning: returningSpy }));
  const insertSpy = vi.fn(() => ({ values: insertValuesSpy }));

  // .update(table).set(values).where(cond) → resolves
  const whereSpyU = vi.fn().mockResolvedValue(undefined);
  const updateSetSpy = vi.fn(() => ({ where: whereSpyU }));
  const updateSpy = vi.fn(() => ({ set: updateSetSpy }));

  // .select({ max: ... }).from(changeLog).where(...) → [{ max: nextSequence-1 }]
  const whereSelectSpy = vi.fn().mockResolvedValue([{ max: nextSequence - 1 }]);
  const fromSpy = vi.fn(() => ({ where: whereSelectSpy }));
  const selectFromSpy = vi.fn(() => ({ from: fromSpy }));

  const tx = {
    insert: insertSpy,
    update: updateSpy,
    select: selectFromSpy,
  };
  return { tx, insertValuesSpy, updateSetSpy, selectFromSpy };
}

function makeDb(tx: any): { db: any; transactionSpy: ReturnType<typeof vi.fn> } {
  const transactionSpy = vi.fn(async (fn: (tx: any) => Promise<unknown>) => fn(tx));
  return { db: { transaction: transactionSpy }, transactionSpy };
}

const baseEntry: NewChangeLogEntry = {
  projectId: "proj-A",
  source: "agent",
  agentId: "agent-1",
  actionType: "stub",
  targetType: "track",
  targetId: "t1",
};

const sampleSnapshot = { project: null, scenes: [], activeSceneId: null };

describe("DrizzleMutationDB", () => {
  it("transaction() invokes the callback once and resolves with its return value", async () => {
    const { tx } = makeTx();
    const { db, transactionSpy } = makeDb(tx);
    const mdb = new DrizzleMutationDB(db);

    const result = await mdb.transaction(async (mtx) => {
      const inserted = await mtx.insertChangeLogEntry(baseEntry);
      return inserted.id;
    });

    expect(transactionSpy).toHaveBeenCalledTimes(1);
    expect(result).toBe("ch-1");
  });

  it("insertChangeLogEntry forwards the entry, computes the next sequence, and returns the inserted id", async () => {
    const { tx, insertValuesSpy, selectFromSpy } = makeTx({
      insertedId: "ch-99",
      nextSequence: 5,
    });
    const { db } = makeDb(tx);
    const mdb = new DrizzleMutationDB(db);

    const out = await mdb.transaction(async (mtx) => mtx.insertChangeLogEntry(baseEntry));

    expect(out.id).toBe("ch-99");
    // select(max(sequence)).from(change_log).where(projectId=...) was called
    expect(selectFromSpy).toHaveBeenCalledTimes(1);
    // insert(change_log).values(row-with-sequence-5) was called
    expect(insertValuesSpy).toHaveBeenCalledTimes(1);
    const insertedRow = insertValuesSpy.mock.calls[0][0];
    expect(insertedRow.projectId).toBe("proj-A");
    expect(insertedRow.source).toBe("agent");
    expect(insertedRow.agentId).toBe("agent-1");
    expect(insertedRow.actionType).toBe("stub");
    expect(insertedRow.targetType).toBe("track");
    expect(insertedRow.targetId).toBe("t1");
    expect(insertedRow.sequence).toBe(5);
  });

  it("first changeLog row for a project gets sequence 1 (max returns null)", async () => {
    const { tx, insertValuesSpy } = makeTx();
    // Override: select returns a row where max is null (no prior rows)
    tx.select = vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue([{ max: null }]),
      })),
    }));
    const { db } = makeDb(tx);
    const mdb = new DrizzleMutationDB(db);

    await mdb.transaction(async (mtx) => mtx.insertChangeLogEntry(baseEntry));

    expect(insertValuesSpy.mock.calls[0][0].sequence).toBe(1);
  });

  it("updateProjectSnapshot writes snapshot + version + lastCommittedChangeId + updatedAt", async () => {
    const { tx, updateSetSpy } = makeTx();
    const { db } = makeDb(tx);
    const mdb = new DrizzleMutationDB(db);

    await mdb.transaction(async (mtx) => {
      await mtx.updateProjectSnapshot("proj-A", {
        snapshot: sampleSnapshot,
        snapshotVersion: 13,
        lastCommittedChangeId: "ch-77",
      });
    });

    expect(updateSetSpy).toHaveBeenCalledTimes(1);
    const setArg = updateSetSpy.mock.calls[0][0];
    expect(setArg.timelineSnapshot).toEqual(sampleSnapshot);
    expect(setArg.snapshotVersion).toBe(13);
    expect(setArg.lastCommittedChangeId).toBe("ch-77");
    expect(setArg.updatedAt).toBeInstanceOf(Date);
  });

  it("propagates rejections from the underlying tx callback", async () => {
    const { tx } = makeTx();
    const { db } = makeDb(tx);
    const mdb = new DrizzleMutationDB(db);

    await expect(
      mdb.transaction(async () => {
        throw new Error("user code blew up");
      }),
    ).rejects.toThrowError("user code blew up");
  });
});
