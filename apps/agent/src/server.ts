import { Hono } from "hono";
import { cors } from "hono/cors";
import { commands } from "./routes/commands.js";
import { project } from "./routes/project.js";
import { media } from "./routes/media.js";
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

export interface AppServices {
  sessionManager: SessionManager;
  taskRegistry: TaskRegistry;
  eventBus: EventBus;
  eventBusHook: ToolHook;
  skillContracts: SkillContract[];
}

/**
 * Create a session-aware MessageHandler that wires MasterAgent execution
 * with session turn tracking and event emission.
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

    const response = await deps.masterAgent.handleUserMessage(message);

    // incrementTurn is called within the runtime via onTurnComplete callback
    // but we also emit the event for SSE consumers
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
 * Create a MasterAgent with full production wiring: session-aware runtime,
 * EventBus hook on pipeline, sub-agent dispatchers with shared hooks.
 */
export function createWiredMasterAgent(deps: {
  apiKey: string;
  contextManager: ProjectContextManager;
  writeLock: ProjectWriteLock;
  sessionManager: SessionManager;
  sessionId: string;
  eventBusHook: ToolHook;
  skillContracts: SkillContract[];
  subAgentDispatchers: Map<string, (input: DispatchInput) => Promise<DispatchOutput>>;
}): MasterAgent {
  const runtime = new NativeAPIRuntime(deps.apiKey);

  // Wire session turn tracking into the runtime
  runtime.setOnTurnComplete((tokens) => {
    deps.sessionManager.incrementTurn(deps.sessionId, tokens);
  });

  return new MasterAgent({
    runtime,
    contextManager: deps.contextManager,
    writeLock: deps.writeLock,
    subAgentDispatchers: deps.subAgentDispatchers,
    hooks: [deps.eventBusHook],
    skillContracts: deps.skillContracts,
  });
}

export function createApp(opts?: {
  skillContracts?: SkillContract[];
  messageHandler?: MessageHandler;
}) {
  const app = new Hono();

  // Instantiate shared services
  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore);
  const taskRegistry = new TaskRegistry();
  const eventBus = new EventBus();

  // Create EventBus hook for tool pipeline emissions
  const eventBusHook = createEventBusHook(eventBus);

  // Skill contracts can be injected or will be empty by default
  const skillContracts = opts?.skillContracts ?? [];

  app.use("*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Static routes (no DI needed)
  app.route("/commands", commands);
  app.route("/project", project);
  app.route("/media", media);
  app.route("/changeset", changeset);

  // DI-wired routes
  app.route("/chat", createChatRouter({
    sessionManager,
    eventBus,
    messageHandler: opts?.messageHandler,
  }));
  app.route("/events", createEventsRouter({ eventBus }));
  app.route("/status", createStatusRouter({ sessionManager, taskRegistry }));

  // Expose services for external wiring
  return Object.assign(app, {
    services: { sessionManager, taskRegistry, eventBus, eventBusHook, skillContracts } as AppServices,
  });
}
