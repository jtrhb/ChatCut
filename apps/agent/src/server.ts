import { Hono } from "hono";
import { cors } from "hono/cors";
import { createCommandsRouter } from "./routes/commands.js";
import { createProjectRouter } from "./routes/project.js";
import { createMediaRouter } from "./routes/media.js";
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
import type { ObjectStorage } from "./services/object-storage.js";
import type { ChangesetManager } from "./changeset/changeset-manager.js";

/** Optional infrastructure deps — wired when real backends are available. */
export interface InfrastructureDeps {
  serverEditorCore?: ServerEditorCore;
  contextManager?: ProjectContextManager;
  objectStorage?: ObjectStorage;
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
 */
export function createMessageHandler(deps: {
  masterAgent: MasterAgent;
  sessionManager: SessionManager;
  eventBus: EventBus;
}): MessageHandler {
  return async (message: string, sessionId: string) => {
    deps.eventBus.emit({
      type: "agent.turn_start",
      timestamp: Date.now(),
      sessionId,
      data: { message },
    });

    // Retrieve conversation history for multi-turn context.
    // Cap at 50 messages to avoid exceeding model context window.
    const MAX_HISTORY_MESSAGES = 50;
    const session = deps.sessionManager.getSession(sessionId);
    const history = session?.messages
      ?.filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => ({ role: m.role, content: String(m.content) }))
      ?? [];

    const { text: response, tokensUsed } = await deps.masterAgent.handleUserMessage(message, history);

    // Track turn on the per-request session (not a fixed default session)
    deps.sessionManager.incrementTurn(sessionId, tokensUsed);

    deps.eventBus.emit({
      type: "agent.turn_end",
      timestamp: Date.now(),
      sessionId,
      data: { responseLength: response.length },
    });

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
  subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
  changesetManager?: ChangesetManager;
  taskRegistry?: TaskRegistry;
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
  return { sessionManager, taskRegistry, eventBus, eventBusHook, skillContracts: skillContracts ?? [] };
}

export function createApp(opts?: {
  services?: AppServices;
  infrastructure?: InfrastructureDeps;
  skillContracts?: SkillContract[];
  messageHandler?: MessageHandler;
  skillsRouter?: Hono;
}) {
  const app = new Hono();

  // Use provided services or create new ones (tests may omit services)
  const services = opts?.services ?? createServices(opts?.skillContracts);
  const { sessionManager, taskRegistry, eventBus, eventBusHook, skillContracts } = services;

  app.use("*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  // DI-ready routes — accept optional infrastructure deps.
  // Without deps they return stub responses; with deps they hit real services.
  const infra = opts?.infrastructure ?? {};
  app.route("/commands", createCommandsRouter({ serverEditorCore: infra.serverEditorCore }));
  app.route("/project", createProjectRouter({ contextManager: infra.contextManager }));
  app.route("/media", createMediaRouter({ objectStorage: infra.objectStorage }));
  app.route("/changeset", changeset);

  // DI-wired routes
  app.route("/chat", createChatRouter({
    sessionManager,
    eventBus,
    messageHandler: opts?.messageHandler,
  }));
  app.route("/events", createEventsRouter({ eventBus }));
  app.route("/status", createStatusRouter({ sessionManager, taskRegistry }));

  // Optional /skills route — wired when skill infrastructure is available
  if (opts?.skillsRouter) {
    app.route("/skills", opts.skillsRouter);
  }

  // Expose services for external wiring
  return Object.assign(app, { services });
}
