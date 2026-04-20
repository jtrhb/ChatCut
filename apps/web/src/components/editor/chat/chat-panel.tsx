"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/utils/ui";
import { useChat } from "@/hooks/use-chat";
import { AgentStatusIndicator } from "./agent-status";
import { MessageBubble } from "./message-bubble";
import { ChangesetReview } from "./changeset-review";
import { CandidateCards } from "./candidate-cards";

interface ChatPanelProps {
  projectId: string;
  className?: string;
}

export function ChatPanel({ projectId, className }: ChatPanelProps) {
  const {
    messages,
    isLoading,
    agentStatus,
    progressText,
    sendMessage,
    approveChangeset,
    rejectChangeset,
    selectCandidate,
  } = useChat(projectId);

  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || isLoading) return;
    sendMessage(trimmed);
    setInput("");
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleSend();
    }
  };

  const handleInput = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(event.target.value);
    // Auto-resize textarea
    const el = event.target;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  return (
    <div
      className={cn(
        "flex flex-col bg-background border rounded-sm overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b shrink-0">
        <span className="text-sm font-medium">Chat</span>
        <AgentStatusIndicator status={agentStatus} />
      </div>

      {/* Progress line (Phase 4 tool.progress SSE events). Only renders
          when a long-call has emitted at least one update — clears on
          assistant message arrival or status→idle. */}
      {progressText && (
        <div className="px-3 py-1.5 border-b shrink-0 text-xs text-muted-foreground bg-muted/40">
          {progressText}
        </div>
      )}

      {/* Message list */}
      <div className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-3 min-h-0">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center px-4">
            <p className="text-sm text-muted-foreground">
              Describe what you&apos;d like to do with your video.
            </p>
            <p className="text-xs text-muted-foreground">
              e.g. &quot;Trim the first 5 seconds&quot; or &quot;Add a fade in&quot;
            </p>
          </div>
        )}

        {messages.map((message) => (
          <div key={message.id} className="flex flex-col gap-1.5">
            <MessageBubble message={message} />

            {message.changeset && (
              <div
                className={cn(
                  message.role === "user" ? "self-end" : "self-start",
                  "w-full max-w-[90%]",
                )}
              >
                <ChangesetReview
                  changeset={message.changeset}
                  onApprove={approveChangeset}
                  onReject={rejectChangeset}
                />
              </div>
            )}

            {message.exploration && (
              <CandidateCards
                exploration={message.exploration}
                onSelect={selectCandidate}
              />
            )}
          </div>
        ))}

        {isLoading && agentStatus === "idle" && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-xl rounded-bl-sm px-3 py-2 flex gap-1 items-center">
              <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:0ms]" />
              <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:150ms]" />
              <span className="size-1.5 rounded-full bg-muted-foreground animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t px-3 py-2 flex items-end gap-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Message the agent…"
          rows={1}
          className={cn(
            "flex-1 resize-none rounded-md border bg-background px-3 py-2",
            "text-sm placeholder:text-muted-foreground",
            "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "min-h-[2.25rem] max-h-[7.5rem] overflow-y-auto",
          )}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!input.trim() || isLoading}
          className={cn(
            "shrink-0 rounded-md px-3 py-2 text-sm font-medium transition-colors",
            "bg-primary text-primary-foreground hover:bg-primary/90",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            "h-[2.25rem]",
          )}
        >
          Send
        </button>
      </div>
    </div>
  );
}
