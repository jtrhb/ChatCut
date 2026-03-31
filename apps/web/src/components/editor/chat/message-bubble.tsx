import { cn } from "@/utils/ui";
import type { Message } from "@/hooks/use-chat";

interface MessageBubbleProps {
  message: Message;
}

export function MessageBubble({ message }: MessageBubbleProps) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";

  if (isSystem) {
    return (
      <div className="flex justify-center px-3 py-1">
        <span className="text-xs text-muted-foreground italic">
          {message.content}
        </span>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex w-full",
        isUser ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[80%] rounded-xl px-3 py-2 text-sm leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        {message.content}
      </div>
    </div>
  );
}
