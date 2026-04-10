export type RuntimeEventType =
  | "session.created" | "session.resumed" | "session.completed"
  | "agent.turn_start" | "agent.turn_end"
  | "tool.called" | "tool.result" | "tool.progress"
  | "task.created" | "task.progress" | "task.completed" | "task.failed"
  | "changeset.proposed" | "changeset.approved" | "changeset.rejected"
  | "memory.injected"
  | "exploration.started" | "exploration.candidate_ready";

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: number;
  sessionId?: string;
  taskId?: string;
  data: Record<string, unknown>;
}
