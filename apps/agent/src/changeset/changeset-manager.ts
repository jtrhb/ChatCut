import { nanoid } from "nanoid";
import type { ChangeLog } from "@opencut/core";
import type { ServerEditorCore } from "../services/server-editor-core.js";
import type { PendingChangeset } from "./changeset-types.js";

interface ProposeParams {
  summary: string;
  affectedElements: string[];
  projectId?: string;
}

interface Modification {
  type: string;
  targetId: string;
  details: Record<string, unknown>;
}

export class ChangesetManager {
  private readonly changeLog: ChangeLog;
  private readonly serverCore: ServerEditorCore;
  private readonly changesets = new Map<string, PendingChangeset>();
  private currentPendingId: string | null = null;

  constructor(deps: { changeLog: ChangeLog; serverCore: ServerEditorCore }) {
    this.changeLog = deps.changeLog;
    this.serverCore = deps.serverCore;
  }

  async propose(params: ProposeParams): Promise<PendingChangeset> {
    // Record boundary cursor (length - 1, or -1 if empty)
    const boundaryCursor = this.changeLog.length - 1;

    const changeset: PendingChangeset = {
      changesetId: nanoid(),
      projectId: params.projectId ?? "default",
      boundaryCursor,
      status: "pending",
      summary: params.summary,
      fingerprint: {
        elementIds: params.affectedElements,
        trackIds: [],
        timeRanges: [],
      },
      injectedMemoryIds: [],
      injectedSkillIds: [],
      createdAt: Date.now(),
    };

    this.changesets.set(changeset.changesetId, changeset);
    this.currentPendingId = changeset.changesetId;
    return changeset;
  }

  async approve(changesetId: string): Promise<void> {
    const changeset = this.changesets.get(changesetId);
    if (!changeset) {
      throw new Error(`Changeset not found: ${changesetId}`);
    }
    if (changeset.status !== "pending") {
      throw new Error(
        `Cannot approve changeset with status "${changeset.status}"`
      );
    }

    this.changeLog.emitDecision({
      type: "changeset_committed",
      changesetId,
      timestamp: Date.now(),
    });

    changeset.status = "approved";
    changeset.decidedAt = Date.now();

    if (this.currentPendingId === changesetId) {
      this.currentPendingId = null;
    }
  }

  async reject(changesetId: string): Promise<void> {
    const changeset = this.changesets.get(changesetId);
    if (!changeset) {
      throw new Error(`Changeset not found: ${changesetId}`);
    }
    if (changeset.status !== "pending") {
      throw new Error(
        `Cannot reject changeset with status "${changeset.status}"`
      );
    }

    this.changeLog.emitDecision({
      type: "changeset_rejected",
      changesetId,
      timestamp: Date.now(),
    });

    changeset.status = "rejected";
    changeset.decidedAt = Date.now();

    if (this.currentPendingId === changesetId) {
      this.currentPendingId = null;
    }
  }

  async approveWithMods(
    changesetId: string,
    modifications: Modification[]
  ): Promise<void> {
    // Record each human modification to the changeLog
    for (const mod of modifications) {
      this.changeLog.record({
        source: "human",
        changesetId,
        action: {
          type: "update",
          targetType: "element",
          targetId: mod.targetId,
          details: { modificationType: mod.type, ...mod.details },
        },
        summary: `Human modification: ${mod.type} on ${mod.targetId}`,
      });
    }

    // Then approve the changeset
    await this.approve(changesetId);
  }

  getPending(): PendingChangeset | null {
    if (this.currentPendingId === null) return null;
    const cs = this.changesets.get(this.currentPendingId);
    return cs && cs.status === "pending" ? cs : null;
  }

  getChangeset(changesetId: string): PendingChangeset | undefined {
    return this.changesets.get(changesetId);
  }
}
