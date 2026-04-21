import { Hono } from "hono";
import { cors } from "hono/cors";
import { createCommandsRouter } from "./routes/commands.js";
import { createProjectRouter } from "./routes/project.js";
import { createMediaRouter } from "./routes/media.js";
import { createExplorationRouter } from "./routes/exploration.js";
import { changeset } from "./routes/changeset.js";
import { SessionStore } from "./session/session-store.js";
import { SessionManager } from "./session/session-manager.js";
import {
	SessionCompactor,
	createAnthropicSummarizer,
	stringifyContent,
} from "./session/compactor.js";
import type { SessionMessage } from "./session/types.js";
import { TaskRegistry } from "./tasks/task-registry.js";
import { EventBus } from "./events/event-bus.js";
import { createChatRouter } from "./routes/chat.js";
import { createEventsRouter } from "./routes/events.js";
import { createStatusRouter } from "./routes/status.js";
import type { SkillContract } from "./skills/types.js";
import { createEventBusHook } from "./tools/hooks.js";
import type { ToolHook } from "./tools/hooks.js";
import type { MessageHandler } from "./routes/chat.js";
import { NativeAPIRuntime } from "./agents/runtime.js";
import { MasterAgent } from "./agents/master-agent.js";
import type { ProjectContextManager } from "./context/project-context.js";
import type { ProjectWriteLock } from "./context/write-lock.js";
import type { DispatchInput, DispatchOutput } from "./agents/types.js";
import type { ServerEditorCore } from "./services/server-editor-core.js";
import type { CoreRegistry } from "./services/core-registry.js";
import type { MutationDB } from "./services/commit-mutation.js";
import type { ObjectStorage } from "./services/object-storage.js";
import type { ChangesetManager } from "./changeset/changeset-manager.js";
import type { MemoryStore } from "./memory/memory-store.js";
import type { MemoryLoader } from "./memory/memory-loader.js";
import type { ContextSynchronizer } from "./context/context-sync.js";
import type { ExplorationEngine } from "./exploration/exploration-engine.js";
import type { ExplorationLookup } from "./services/exploration-lookup.js";

/** Optional infrastructure deps — wired when real backends are available. */
export interface InfrastructureDeps {
	serverEditorCore?: ServerEditorCore;
	contextManager?: ProjectContextManager;
	objectStorage?: ObjectStorage;
	/** Phase 2C-2: when both are present the /commands route routes through
	 *  commitMutation for any request that names a projectId. */
	coreRegistry?: CoreRegistry;
	mutationDB?: MutationDB;
	/** Phase 3 Stage E.3: when present, GET /exploration/.../preview/...
	 *  resolves storage keys + failure metadata from exploration_sessions
	 *  instead of returning 503. */
	explorationLookup?: ExplorationLookup;
}

export interface AppServices {
	sessionManager: SessionManager;
	taskRegistry: TaskRegistry;
	eventBus: EventBus;
	eventBusHook: ToolHook;
	skillContracts: SkillContract[];
}

/**
 * Create a session-aware MessageHandler that wires MasterAgent execution
 * with per-request session turn tracking and event emission.
 *
 * @param deps.afterTurn  Optional callback invoked after every successful
 *   handler completion. Used by the boot wiring to trigger
 *   PatternObserver runs (audit §B.PatternObserver). Errors are
 *   swallowed so post-turn telemetry can never fail a user turn.
 */
export function createMessageHandler(deps: {
	masterAgent: MasterAgent;
	sessionManager: SessionManager;
	eventBus: EventBus;
	afterTurn?: (identity: {
		sessionId: string;
		projectId: string;
		userId?: string;
	}) => Promise<void> | void;
	/**
	 * Phase 5e: when wired, every turn checks whether session history exceeds
	 * the compactor's token threshold and folds older messages into a rolling
	 * summary. Optional so test paths and minimal boots can omit it; without it
	 * the handler runs the legacy "slice last 50" behavior.
	 */
	sessionCompactor?: SessionCompactor;
}): MessageHandler {
	// Per-handler flag for the "afterTurn wired but no projectId" warn-once
	// (reviewer MEDIUM #5). Per-handler — not module-level — so multiple
	// handlers in tests don't share state.
	let warnedOnAfterTurnSkip = false;
	// Phase 5e MED-3: per-session async mutex. Two concurrent requests on the
	// same sessionId would otherwise both observe the same pre-compaction
	// snapshot, both call Haiku (2x cost), and the second applyCompaction
	// would clobber the first along with any messages appended in between.
	// The lock chains promises per sessionId so only one turn at a time
	// executes the compaction read-modify-write window. Map entries are
	// cleared once their chain settles to avoid unbounded growth.
	const sessionLocks = new Map<string, Promise<void>>();
	const withSessionLock = async <T>(
		sid: string,
		fn: () => Promise<T>,
	): Promise<T> => {
		const prev = sessionLocks.get(sid) ?? Promise.resolve();
		let release!: () => void;
		const released = new Promise<void>((resolve) => {
			release = resolve;
		});
		// `tail` is the promise the next caller will wait on. Capture it once
		// so the cleanup-when-still-tail check below compares the same object.
		// NEW-1: pass a rejection handler too so a rejected `prev` doesn't poison
		// the chain. Without this, if any future code added inside fn() throws
		// outside the existing inner try/catch, `release()` never fires and the
		// session's mutex entry leaks forever — every subsequent turn on the
		// same sessionId would also reject. Treating prev-rejection as
		// equivalent to prev-resolution is the correct mutex semantics: the
		// next caller's critical section runs regardless of how the prior one
		// terminated.
		const tail = prev.then(
			() => released,
			() => released,
		);
		sessionLocks.set(sid, tail);
		await prev;
		try {
			return await fn();
		} finally {
			release();
			// Only delete if we're still the tail — otherwise a later request
			// has chained onto this sid and dropping the entry would orphan it.
			if (sessionLocks.get(sid) === tail) {
				sessionLocks.delete(sid);
			}
		}
	};
	return async (message, sessionId, identity) => {
		deps.eventBus.emit({
			type: "agent.turn_start",
			timestamp: Date.now(),
			sessionId,
			data: {
				message,
				userId: identity?.userId,
				projectId: identity?.projectId,
			},
		});

		// Retrieve conversation history for multi-turn context.
		// Cap at 50 messages to avoid exceeding model context window.
		// Phase 5e: when a compactor is wired, the cap becomes a runaway-safety
		// ceiling rather than the primary mechanism — compaction tries to fire
		// on token weight first.
		const MAX_HISTORY_MESSAGES = 50;
		let session = deps.sessionManager.getSession(sessionId);
		let sessionSummary: string | undefined = session?.summary;

		// Phase 5e: best-effort compaction. Errors here MUST NOT fail the user's
		// turn — we fall through to the legacy slice path if the summarizer
		// rejects (rate limit, transient, missing key in dev).
		// Wrapped in withSessionLock (MED-3) so concurrent turns on the same
		// sessionId can't both summarize the same snapshot or clobber each
		// other's writes mid-flight.
		if (deps.sessionCompactor) {
			await withSessionLock(sessionId, async () => {
				// Re-read inside the lock so we don't operate on a stale snapshot
				// from before another concurrent turn finished.
				const fresh = deps.sessionManager.getSession(sessionId);
				if (!fresh || !deps.sessionCompactor) return;

				const allMsgs = fresh.messages.filter(
					(m) => m.role === "user" || m.role === "assistant",
				);
				// MED-2: include the current user message in the threshold check
				// so the turn that crosses the budget actually triggers compaction
				// (chat.ts appends the user message AFTER this handler runs).
				if (
					!deps.sessionCompactor.shouldCompact(allMsgs, fresh.summary, message)
				) {
					return;
				}
				try {
					const result = await deps.sessionCompactor.compact(
						allMsgs,
						fresh.summary,
					);
					// MED-1: applyCompaction overwrites the entire messages array,
					// so we must hand it the COMPLETE desired post-compaction list —
					// not just the user/assistant slice. The compactor's retainedTail
					// items are the SAME object references as the corresponding
					// entries in fresh.messages (Array.filter + Array.slice preserve
					// element references), so indexOf finds the right index even
					// when seed data has identical content/timestamps. Slice from
					// that index so any interleaved non-user/assistant rows
					// (e.g. a future tool_result) are preserved verbatim.
					const firstRetained = result.retainedTail[0];
					let unfilteredTail: SessionMessage[];
					if (!firstRetained) {
						unfilteredTail = [];
					} else {
						const firstIdx = fresh.messages.indexOf(firstRetained);
						if (firstIdx >= 0) {
							unfilteredTail = fresh.messages.slice(firstIdx);
						} else {
							// NEW-3: this branch is unreachable today (compactor
							// preserves element references through filter+slice), but
							// if a future compactor change ever clones items, the
							// silent fallback would re-introduce the MED-1 bug it
							// was fixed to prevent — interleaved non-user/assistant
							// rows would be dropped. Surface the fallback so the
							// regression is visible in logs instead of silent.
							console.warn(
								`[messageHandler] retainedTail reference identity broken (sessionId=${sessionId}); falling back to filtered tail. This may drop interleaved non-user/assistant rows if persisted.`,
							);
							unfilteredTail = [...result.retainedTail];
						}
					}
					const previousCompactionAt = fresh.lastCompactedAt;
					deps.sessionManager.applyCompaction(sessionId, {
						summary: result.summary,
						retainedTail: unfilteredTail,
					});
					sessionSummary = result.summary;
					session = deps.sessionManager.getSession(sessionId);
					deps.eventBus.emit({
						type: "agent.session_compacted",
						timestamp: Date.now(),
						sessionId,
						data: {
							droppedCount: result.droppedCount,
							retainedCount: unfilteredTail.length,
							summaryChars: result.summary.length,
							// LOW-2: surface the prior compaction time so observability
							// can compute compaction cadence per session.
							previousCompactionAt: previousCompactionAt ?? null,
						},
					});
				} catch (err) {
					// LOW-4: include sessionId + size context + full Error (stack)
					// so a recurring failure is one-line searchable in logs.
					const messageCount = allMsgs.length;
					const estimatedTokens = deps.sessionCompactor.estimateTokens(
						allMsgs,
						fresh.summary,
						message,
					);
					console.warn(
						`[messageHandler] session compaction failed (sessionId=${sessionId}, messages=${messageCount}, estimatedTokens=${estimatedTokens}); continuing without compaction:`,
						err instanceof Error ? (err.stack ?? err.message) : err,
					);
				}
			});
		}

		const history =
			session?.messages
				?.filter((m) => m.role === "user" || m.role === "assistant")
				.slice(-MAX_HISTORY_MESSAGES)
				// LOW-1: use the same stringifyContent helper the compactor uses
				// so non-string content doesn't degrade to "[object Object]".
				.map((m) => ({ role: m.role, content: stringifyContent(m.content) })) ??
			[];

		const { text: response, tokensUsed } =
			await deps.masterAgent.handleUserMessage(
				message,
				history,
				identity
					? {
							userId: identity.userId,
							sessionId: identity.sessionId,
							projectId: identity.projectId,
						}
					: undefined,
				sessionSummary,
			);

		// Track turn on the per-request session (not a fixed default session)
		deps.sessionManager.incrementTurn(sessionId, tokensUsed);

		deps.eventBus.emit({
			type: "agent.turn_end",
			timestamp: Date.now(),
			sessionId,
			data: { responseLength: response.length },
		});

		// Best-effort post-turn callback (PatternObserver scheduling, etc.).
		// Errors here MUST NOT propagate — the user's turn already succeeded.
		if (deps.afterTurn) {
			if (identity?.projectId) {
				try {
					await deps.afterTurn({
						sessionId,
						projectId: identity.projectId,
						userId: identity.userId,
					});
				} catch {
					// swallow — telemetry / observers are not load-bearing
				}
			} else if (!warnedOnAfterTurnSkip) {
				// Reviewer MEDIUM #5: silent skip used to make
				// "PatternObserver never fired in prod" a recurring
				// debug expedition. Warn exactly once per handler so the
				// log isn't spammy but the operator gets a clear signal.
				warnedOnAfterTurnSkip = true;
				console.warn(
					"[messageHandler] afterTurn wired but the request carries no projectId — observer will not fire until identity is propagated.",
				);
			}
		}

		return response;
	};
}

/**
 * Create a MasterAgent with full production wiring: EventBus hook on
 * pipeline, sub-agent dispatchers with shared hooks.
 *
 * Session turn tracking is handled per-request in createMessageHandler,
 * not bound to a fixed session here.
 */
export function createWiredMasterAgent(deps: {
	apiKey: string;
	contextManager: ProjectContextManager;
	writeLock: ProjectWriteLock;
	eventBusHook: ToolHook;
	skillContracts: SkillContract[];
	subAgentDispatchers: Map<
		string,
		(input: DispatchInput) => Promise<DispatchOutput>
	>;
	changesetManager?: ChangesetManager;
	taskRegistry?: TaskRegistry;
	serverCore?: ServerEditorCore;
	/** Optional memory infrastructure — when provided, MasterAgent claims
	 *  the writer token and loadMemoriesFor injects per-turn memory into
	 *  the system prompt. */
	memoryStore?: MemoryStore;
	memoryLoader?: MemoryLoader;
	/** Optional context synchronizer — when provided, runTurn prepends
	 *  Change Log deltas to the user message (audit §A.8). */
	contextSynchronizer?: ContextSynchronizer;
	/** Optional fan-out engine — when provided, the explore_options master
	 *  tool is functional instead of returning "not configured". */
	explorationEngine?: ExplorationEngine;
}): MasterAgent {
	const runtime = new NativeAPIRuntime(deps.apiKey);

	return new MasterAgent({
		runtime,
		contextManager: deps.contextManager,
		writeLock: deps.writeLock,
		subAgentDispatchers: deps.subAgentDispatchers,
		hooks: [deps.eventBusHook],
		skillContracts: deps.skillContracts,
		changesetManager: deps.changesetManager,
		taskRegistry: deps.taskRegistry,
		serverCore: deps.serverCore,
		memoryStore: deps.memoryStore,
		memoryLoader: deps.memoryLoader,
		contextSynchronizer: deps.contextSynchronizer,
		explorationEngine: deps.explorationEngine,
	});
}

/**
 * Create shared services. Call once, pass the result to createApp
 * and createWiredMasterAgent to avoid split-brain duplicates.
 */
export function createServices(skillContracts?: SkillContract[]): AppServices {
	const sessionStore = new SessionStore();
	const sessionManager = new SessionManager(sessionStore);
	const taskRegistry = new TaskRegistry();
	const eventBus = new EventBus();
	const eventBusHook = createEventBusHook(eventBus);
	return {
		sessionManager,
		taskRegistry,
		eventBus,
		eventBusHook,
		skillContracts: skillContracts ?? [],
	};
}

export function createApp(opts?: {
	services?: AppServices;
	infrastructure?: InfrastructureDeps;
	skillContracts?: SkillContract[];
	messageHandler?: MessageHandler;
	skillsRouter?: Hono;
	changesetRouter?: Hono;
}) {
	const app = new Hono();

	// Use provided services or create new ones (tests may omit services)
	const services = opts?.services ?? createServices(opts?.skillContracts);
	const {
		sessionManager,
		taskRegistry,
		eventBus,
		eventBusHook,
		skillContracts,
	} = services;

	app.use("*", cors());
	app.get("/health", (c) => c.json({ status: "ok" }));

	// DI-ready routes — accept optional infrastructure deps.
	// Without deps they return stub responses; with deps they hit real services.
	const infra = opts?.infrastructure ?? {};
	app.route(
		"/commands",
		createCommandsRouter({
			serverEditorCore: infra.serverEditorCore,
			coreRegistry: infra.coreRegistry,
			mutationDB: infra.mutationDB,
		}),
	);
	app.route(
		"/project",
		createProjectRouter({
			contextManager: infra.contextManager,
			coreRegistry: infra.coreRegistry,
		}),
	);
	app.route(
		"/media",
		createMediaRouter({ objectStorage: infra.objectStorage }),
	);
	// Phase 3 Stage E.4: per-candidate preview lookup. The route shows
	// 503 when either dep is missing — see createExplorationRouter.
	app.route(
		"/exploration",
		createExplorationRouter({
			objectStorage: infra.objectStorage,
			lookup: infra.explorationLookup,
		}),
	);
	app.route("/changeset", opts?.changesetRouter ?? changeset);

	// DI-wired routes
	app.route(
		"/chat",
		createChatRouter({
			sessionManager,
			eventBus,
			messageHandler: opts?.messageHandler,
		}),
	);
	app.route("/events", createEventsRouter({ eventBus }));
	app.route("/status", createStatusRouter({ sessionManager, taskRegistry }));

	// Optional /skills route — wired when skill infrastructure is available
	if (opts?.skillsRouter) {
		app.route("/skills", opts.skillsRouter);
	}

	// Expose services for external wiring
	return Object.assign(app, { services });
}
