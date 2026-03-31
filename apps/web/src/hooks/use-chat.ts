"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const AGENT_URL =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4000";

export interface ChangesetAttachment {
  changesetId: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
}

export interface CandidateMetrics {
  durationChange: string;
  affectedElements: number;
}

export interface Candidate {
  candidateId: string;
  label: string;
  summary: string;
  previewUrl?: string;
  metrics: CandidateMetrics;
}

export interface ExplorationAttachment {
  explorationId: string;
  candidates: Candidate[];
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
  changeset?: ChangesetAttachment;
  exploration?: ExplorationAttachment;
}

export type AgentStatus =
  | "idle"
  | "thinking"
  | "executing"
  | "awaiting_approval";

export interface UseChatReturn {
  messages: Message[];
  isLoading: boolean;
  agentStatus: AgentStatus;
  sendMessage: (content: string) => void;
  approveChangeset: (changesetId: string) => void;
  rejectChangeset: (changesetId: string) => void;
  selectCandidate: (explorationId: string, candidateId: string) => void;
}

export function useChat(projectId: string): UseChatReturn {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
  const esRef = useRef<EventSource | null>(null);

  // Connect to SSE for real-time updates
  useEffect(() => {
    if (!projectId) return;

    const url = `${AGENT_URL}/events?projectId=${encodeURIComponent(projectId)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as Record<string, unknown>;
        const type = data.type as string | undefined;

        if (type === "message") {
          const msg = data.message as Message;
          setMessages((prev) => {
            const exists = prev.some((m) => m.id === msg.id);
            if (exists) {
              return prev.map((m) => (m.id === msg.id ? msg : m));
            }
            return [...prev, msg];
          });
        } else if (type === "status") {
          setAgentStatus((data.status as AgentStatus) ?? "idle");
        } else if (type === "changeset_update") {
          const changesetId = data.changesetId as string;
          const status = data.status as ChangesetAttachment["status"];
          setMessages((prev) =>
            prev.map((m) =>
              m.changeset?.changesetId === changesetId
                ? {
                    ...m,
                    changeset: { ...m.changeset, status },
                  }
                : m,
            ),
          );
        }
      } catch {
        // ignore parse errors
      }
    };

    es.onerror = () => {
      // SSE will auto-reconnect; nothing to do
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [projectId]);

  const sendMessage = useCallback(
    (content: string) => {
      if (!content.trim()) return;

      const optimistic: Message = {
        id: `local-${Date.now()}`,
        role: "user",
        content,
        timestamp: Date.now(),
      };
      setMessages((prev) => [...prev, optimistic]);
      setIsLoading(true);

      fetch(`${AGENT_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, content }),
      })
        .catch(() => {
          // errors will surface via SSE or can be handled here
        })
        .finally(() => {
          setIsLoading(false);
        });
    },
    [projectId],
  );

  const approveChangeset = useCallback(
    (changesetId: string) => {
      fetch(`${AGENT_URL}/changeset/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, changesetId }),
      }).catch(() => {});

      setMessages((prev) =>
        prev.map((m) =>
          m.changeset?.changesetId === changesetId
            ? { ...m, changeset: { ...m.changeset!, status: "approved" } }
            : m,
        ),
      );
    },
    [projectId],
  );

  const rejectChangeset = useCallback(
    (changesetId: string) => {
      fetch(`${AGENT_URL}/changeset/reject`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, changesetId }),
      }).catch(() => {});

      setMessages((prev) =>
        prev.map((m) =>
          m.changeset?.changesetId === changesetId
            ? { ...m, changeset: { ...m.changeset!, status: "rejected" } }
            : m,
        ),
      );
    },
    [projectId],
  );

  const selectCandidate = useCallback(
    (explorationId: string, candidateId: string) => {
      fetch(`${AGENT_URL}/exploration/${encodeURIComponent(explorationId)}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, candidateId }),
      }).catch(() => {});
    },
    [projectId],
  );

  return {
    messages,
    isLoading,
    agentStatus,
    sendMessage,
    approveChangeset,
    rejectChangeset,
    selectCandidate,
  };
}
