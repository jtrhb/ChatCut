"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSession } from "@/lib/auth/client";

const AGENT_URL = process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:4000";

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

/**
 * Typed shape of the `tool.progress` SSE event published by the agent
 * service (mirrors the agent-side `tool-pipeline.ts:298-309` emit). Lives
 * in this hook because it's the single SSE consumer; if a second
 * consumer ever needs it we'll move it to a shared module.
 */
interface ToolProgressSseEvent {
	type: "tool.progress";
	data: {
		toolName: string;
		toolCallId?: string;
		step: number;
		totalSteps?: number;
		text?: string;
		estimatedRemainingMs?: number;
	};
}

export interface UseChatReturn {
	messages: Message[];
	isLoading: boolean;
	agentStatus: AgentStatus;
	/** Free-form description of the tool currently mid-flight (from
	 *  tool.progress events). null when no long-call is active. */
	progressText: string | null;
	sendMessage: (content: string) => void;
	approveChangeset: (changesetId: string) => void;
	rejectChangeset: (changesetId: string) => void;
	selectCandidate: (explorationId: string, candidateId: string) => void;
}

export function useChat(projectId: string): UseChatReturn {
	const [messages, setMessages] = useState<Message[]>([]);
	const [isLoading, setIsLoading] = useState(false);
	const [agentStatus, setAgentStatus] = useState<AgentStatus>("idle");
	const [progressText, setProgressText] = useState<string | null>(null);
	// Session is created lazily by the agent on the first chat POST and
	// returned in the response body; we hold onto it for SSE filtering and
	// subsequent multi-turn requests.
	const [sessionId, setSessionId] = useState<string | null>(null);
	const esRef = useRef<EventSource | null>(null);

	const { data: authSession } = useSession();
	const userId = authSession?.user?.id;

	// Reset the session when the active project changes. This uses React's
	// canonical "reset state via render" pattern (React docs: "You Might
	// Not Need an Effect → Resetting all state when a prop changes")
	// instead of a useEffect, which biome flags as having an unused
	// dependency when the body doesn't read the dep.
	const [trackedProjectId, setTrackedProjectId] = useState(projectId);
	if (projectId !== trackedProjectId) {
		setTrackedProjectId(projectId);
		setSessionId(null);
	}

	// Connect to SSE for real-time updates. The agent service requires a
	// sessionId — opening with anything else returns 400 and leaks no
	// events. We can't connect until the first chat POST has yielded a
	// sessionId, so this effect is gated on `sessionId` rather than
	// `projectId`.
	useEffect(() => {
		if (!sessionId) return;

		const url = `${AGENT_URL}/events?sessionId=${encodeURIComponent(sessionId)}`;
		const es = new EventSource(url);
		esRef.current = es;

		es.onmessage = (event) => {
			try {
				const data = JSON.parse(event.data) as Record<string, unknown>;
				const type = data.type as string | undefined;

				if (type === "message") {
					const msg = data.message as Message;
					// A new assistant message means whatever long-call was
					// running has produced its result — clear the progress line
					// so it doesn't linger above stale work.
					if (msg.role === "assistant") setProgressText(null);
					setMessages((prev) => {
						const exists = prev.some((m) => m.id === msg.id);
						if (exists) {
							return prev.map((m) => (m.id === msg.id ? msg : m));
						}
						return [...prev, msg];
					});
				} else if (type === "status") {
					const next = (data.status as AgentStatus) ?? "idle";
					setAgentStatus(next);
					// Status transitions back to idle/awaiting_approval mean
					// no long-call is active; drop any stale progress line.
					if (next === "idle" || next === "awaiting_approval") {
						setProgressText(null);
					}
				} else if (type === "tool.progress") {
					// Phase 4 reviewer HIGH #2: surface long-call progress in
					// its OWN state, not by abusing the typed AgentStatus union
					// (the indicator's STATUS_CONFIG[status] would crash on a
					// free-form string). Fully typed against the agent-side
					// emit shape.
					const evt = data as unknown as ToolProgressSseEvent;
					const text = evt.data?.text;
					if (typeof text === "string" && text.length > 0) {
						setProgressText(text);
					}
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
	}, [sessionId]);

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

			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (userId) headers["x-user-id"] = userId;

			// Server schema: `{projectId, message, sessionId?}`. The previous
			// `content` field name failed Zod parse on every send. sessionId is
			// optional on the first turn; the response carries the canonical id
			// we then reuse for subsequent turns + the SSE subscription.
			const body: Record<string, unknown> = { projectId, message: content };
			if (sessionId) body.sessionId = sessionId;

			fetch(`${AGENT_URL}/chat`, {
				method: "POST",
				headers,
				body: JSON.stringify(body),
			})
				.then(async (res) => {
					if (!res.ok) return;
					try {
						const data = (await res.json()) as { sessionId?: string };
						if (data.sessionId && data.sessionId !== sessionId) {
							setSessionId(data.sessionId);
						}
					} catch {
						// non-JSON response — leave sessionId untouched
					}
				})
				.catch(() => {
					// errors will surface via SSE or can be handled here
				})
				.finally(() => {
					setIsLoading(false);
				});
		},
		[projectId, sessionId, userId],
	);

	const approveChangeset = useCallback(
		(changesetId: string) => {
			// /changeset/approve and /reject require x-user-id (B5 IDOR closure).
			// Without it the agent service returns 401 before parsing the body.
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (userId) headers["x-user-id"] = userId;

			fetch(`${AGENT_URL}/changeset/approve`, {
				method: "POST",
				headers,
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
		[projectId, userId],
	);

	const rejectChangeset = useCallback(
		(changesetId: string) => {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
			};
			if (userId) headers["x-user-id"] = userId;

			fetch(`${AGENT_URL}/changeset/reject`, {
				method: "POST",
				headers,
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
		[projectId, userId],
	);

	const selectCandidate = useCallback(
		(explorationId: string, candidateId: string) => {
			fetch(
				`${AGENT_URL}/exploration/${encodeURIComponent(explorationId)}/select`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ projectId, candidateId }),
				},
			).catch(() => {});
		},
		[projectId],
	);

	return {
		messages,
		isLoading,
		agentStatus,
		progressText,
		sendMessage,
		approveChangeset,
		rejectChangeset,
		selectCandidate,
	};
}
