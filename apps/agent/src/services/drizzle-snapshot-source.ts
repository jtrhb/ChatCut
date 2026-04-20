import { eq } from "drizzle-orm";
import type { SerializedEditorState } from "@opencut/core";
import { projects } from "../db/schema.js";
import type { ProjectSnapshotRow, ProjectSnapshotSource } from "./core-registry.js";

/**
 * Drizzle-backed ProjectSnapshotSource. Adapts the `projects` table onto
 * the registry's lazy-load contract: SELECT-by-id, return the snapshot
 * + version + last committed changeId, or null when the row doesn't exist.
 *
 * A null `timeline_snapshot` (fresh project, no commits yet) is mapped
 * to a valid empty SerializedEditorState so EditorCore.deserialize never
 * sees malformed input.
 */
export class DrizzleSnapshotSource implements ProjectSnapshotSource {
  private readonly db: any;

  constructor(db: any) {
    this.db = db;
  }

  async loadSnapshot(projectId: string): Promise<ProjectSnapshotRow | null> {
    const rows = await this.db.select().from(projects).where(eq(projects.id, projectId));
    const row = rows[0];
    if (!row) return null;

    const snapshot: SerializedEditorState =
      (row.timelineSnapshot as SerializedEditorState | null) ?? {
        project: null,
        scenes: [],
        activeSceneId: null,
      };

    return {
      snapshot,
      snapshotVersion: row.snapshotVersion ?? 0,
      lastCommittedChangeId: row.lastCommittedChangeId ?? null,
    };
  }
}
