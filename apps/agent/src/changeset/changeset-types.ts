export interface PendingChangeset {
  changesetId: string;
  projectId: string;
  boundaryCursor: number; // ChangeLog index at changeset start
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
