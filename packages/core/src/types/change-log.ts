export interface ChangeEntry {
  id: string;
  timestamp: number;
  source: "human" | "agent" | "system";
  agentId?: string;
  changesetId?: string;
  action: {
    type:
      | "insert"
      | "delete"
      | "update"
      | "trim"
      | "split"
      | "move"
      | "batch"
      | "effect"
      | "keyframe"
      | "transition";
    targetType: "element" | "track" | "effect" | "keyframe" | "scene" | "project";
    targetId: string;
    details: Record<string, unknown>;
  };
  summary: string;
}

export type ChangesetDecisionEvent = {
  type: "changeset_committed" | "changeset_rejected";
  changesetId: string;
  timestamp: number;
};
