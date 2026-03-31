import { cn } from "@/utils/ui";
import type { AgentStatus } from "@/hooks/use-chat";

interface AgentStatusProps {
  status: AgentStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  AgentStatus,
  { label: string; dotClass: string; textClass: string }
> = {
  idle: {
    label: "Idle",
    dotClass: "bg-muted-foreground",
    textClass: "text-muted-foreground",
  },
  thinking: {
    label: "Thinking…",
    dotClass: "bg-yellow-400 animate-pulse",
    textClass: "text-yellow-500",
  },
  executing: {
    label: "Executing…",
    dotClass: "bg-blue-400 animate-pulse",
    textClass: "text-blue-500",
  },
  awaiting_approval: {
    label: "Awaiting approval",
    dotClass: "bg-orange-400 animate-pulse",
    textClass: "text-orange-500",
  },
};

export function AgentStatusIndicator({ status, className }: AgentStatusProps) {
  const config = STATUS_CONFIG[status];

  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <span className={cn("size-2 rounded-full shrink-0", config.dotClass)} />
      <span className={cn("text-xs", config.textClass)}>{config.label}</span>
    </div>
  );
}
