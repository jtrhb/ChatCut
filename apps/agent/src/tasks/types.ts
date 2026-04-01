export type TaskType = "agent_dispatch" | "exploration" | "generation" | "render_preview" | "export" | "verification";
export type TaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface AgentTask {
  taskId: string;
  type: TaskType;
  status: TaskStatus;
  description: string;
  sessionId?: string;
  changesetId?: string;
  parentTaskId?: string;
  progress: number;
  result?: unknown;
  error?: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface CreateTaskParams {
  type: TaskType;
  description: string;
  sessionId?: string;
  changesetId?: string;
  parentTaskId?: string;
}
