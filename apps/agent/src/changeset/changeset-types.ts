export interface PendingChangeset {
  changesetId: string;
  projectId: string;
  /**
   * Owner of the changeset. Stored at propose time so approve/reject can
   * enforce that the caller matches before acting — closes security C3
   * (changeset IDOR: any user could decide any changeset by id).
   */
  userId: string;
  boundaryCursor: number; // ChangeLog index at changeset start
  /**
   * ServerEditorCore.snapshotVersion at propose time. Approve/reject
   * compare this against current snapshotVersion to detect that a human
   * (or another process) mutated the editor state during the review
   * window — if so, the decision is rejected with StaleStateError.
   */
  baseSnapshotVersion: number;
  /**
   * True while the changeset is open for user review. Set false when
   * approve/reject completes. Doubles as "is this still actionable" —
   * the manager refuses decisions on a !reviewLock record.
   */
  reviewLock: boolean;
  status: "pending" | "approved" | "rejected";
  summary: string;
  fingerprint: {
    elementIds: string[];
    trackIds: string[];
    timeRanges: Array<{ start: number; end: number }>;
  };
  injectedMemoryIds: string[];
  injectedSkillIds: string[];
  createdAt: number;
  decidedAt?: number;
}
