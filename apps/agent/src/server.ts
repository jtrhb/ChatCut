import { Hono } from "hono";
import { cors } from "hono/cors";
import { createCommandsRouter } from "./routes/commands.js";
import { createProjectRouter } from "./routes/project.js";
import { createMediaRouter } from "./routes/media.js";
import { createExplorationRouter } from "./routes/exploration.js";
import { changeset } from "./routes/changeset.js";
import { SessionStore } from "./session/session-store.js";
import { SessionManager } from "./session/session-manager.js";
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
}): MessageHandler {
	// Per-handler flag for the "afterTurn wired but no projectId" warn-once
	// (reviewer MEDIUM #5). Per-handler — not module-level — so multiple
	// handlers in tests don't share state.
	let warnedOnAfterTurnSkip = false;
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
		const MAX_HISTORY_MESSAGES = 50;
		const session = deps.sessionManager.getSession(sessionId);
		const history =
			session?.messages
				?.filter((m) => m.role === "user" || m.role === "assistant")
				.slice(-MAX_HISTORY_MESSAGES)
				.map((m) => ({ role: m.role, content: String(m.content) })) ?? [];

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
