import { serve } from "@hono/node-server";
import { createApp, createServices, createWiredMasterAgent, createMessageHandler } from "./server.js";
import { SkillLoader } from "./skills/loader.js";
import { ProjectContextManager } from "./context/project-context.js";
import { ProjectWriteLock } from "./context/write-lock.js";
import { EditorAgent } from "./agents/editor-agent.js";
import { CreatorAgent } from "./agents/creator-agent.js";
import { AudioAgent } from "./agents/audio-agent.js";
import { VisionAgent } from "./agents/vision-agent.js";
import { AssetAgent } from "./agents/asset-agent.js";
import { VerificationAgent } from "./agents/verification-agent.js";
import { masterToolDefinitions } from "./tools/master-tools.js";
import type { DispatchInput, DispatchOutput } from "./agents/types.js";
import { ServerEditorCore } from "./services/server-editor-core.js";
import { EditorToolExecutor } from "./tools/editor-tools.js";
import { AssetToolExecutor } from "./tools/asset-tool-executor.js";
import { EmbeddingClient } from "./services/embedding-client.js";
import { CharacterStore } from "./assets/character-store.js";
import { ChangesetManager } from "./changeset/changeset-manager.js";
import { ChangeLog } from "@opencut/core";
import { PatternObserver } from "./memory/pattern-observer.js";
import type { SkillValidator } from "./skills/skill-validator.js";

// Debounce window for pattern analysis triggers (10 minutes)
const ANALYSIS_DEBOUNCE_MS = 10 * 60 * 1000;
const lastAnalysisAt = new Map<string, number>();

/**
 * Conditionally trigger pattern analysis if enough time has elapsed
 * since the last analysis for this brand/series.
 */
export function maybeTriggerAnalysis(
  patternObserver: PatternObserver,
  brand: string,
  series?: string,
): void {
  const key = `${brand}:${series ?? ""}`;
  const lastAt = lastAnalysisAt.get(key) ?? 0;
  if (Date.now() - lastAt > ANALYSIS_DEBOUNCE_MS) {
    lastAnalysisAt.set(key, Date.now());
    patternObserver.runAnalysis({ brand, series }).catch(() => {
      // Analysis failure is non-fatal — log and continue
    });
  }
}

async function main() {
  // Validate API key at startup — fail fast instead of opaque 401s per dispatch
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY environment variable is required");
  }

  // Collect available tool names for skill resolution
  const availableToolNames = masterToolDefinitions.map((t) => t.name);

  // Load skill contracts before creating the app (requires async I/O)
  const skillLoader = new SkillLoader(null); // null = preset-only mode for now
  const skillContracts = await skillLoader.loadAllSkillContracts(
    "master",
    {},
    { availableTools: availableToolNames, defaultModel: "claude-opus-4-6" },
  );

  // Create shared services ONCE — avoids split-brain duplicates (B2 fix)
  const services = createServices(skillContracts);
  const { sessionManager, eventBus, eventBusHook } = services;

  // Create shared project infrastructure
  const contextManager = new ProjectContextManager();
  const writeLock = new ProjectWriteLock();

  // Create a default ServerEditorCore with empty timeline.
  // Multi-project support will create per-project cores later.
  const serverEditorCore = ServerEditorCore.fromSnapshot({
    project: null,
    scenes: [{
      id: "default",
      name: "Scene 1",
      isMain: true,
      tracks: [],
      bookmarks: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    }],
    activeSceneId: "default",
  });

  // Create EditorToolExecutor backed by real ServerEditorCore
  const editorToolExecutor = new EditorToolExecutor(serverEditorCore);

  // Create AssetToolExecutor when embedding credentials are available
  const embeddingClient = process.env.EMBEDDING_API_URL
    ? new EmbeddingClient(process.env.EMBEDDING_API_URL, process.env.EMBEDDING_API_KEY ?? "")
    : null;

  const assetToolExecutor = embeddingClient
    ? new AssetToolExecutor({
        assetStore: {} as any,    // DB placeholder — wired when connection is available
        brandStore: {} as any,
        characterStore: new CharacterStore(null as any),
        objectStorage: {} as any,
        embeddingClient,
      })
    : null;

  // Create ChangesetManager for propose/approve/reject workflow
  const changeLog = new ChangeLog();
  const changesetManager = new ChangesetManager({ changeLog, serverCore: serverEditorCore });

  // Tool executor for sub-agents — routes to real implementations when available.
  // Accepts optional ToolContext from the pipeline so identity (sessionId/userId)
  // reaches the underlying executor for tenant-scoped operations.
  const toolExecutor = async (name: string, input: unknown, context?: { agentType?: string; taskId?: string; sessionId?: string; userId?: string }) => {
    if (editorToolExecutor.hasToolName(name)) {
      return editorToolExecutor.execute(name, input, {
        agentType: (context?.agentType as any) ?? "editor",
        taskId: context?.taskId ?? "default",
        sessionId: context?.sessionId,
        userId: context?.userId,
      });
    }
    if (assetToolExecutor?.hasToolName(name)) {
      return assetToolExecutor.execute(name, input, {
        agentType: (context?.agentType as any) ?? "asset",
        taskId: context?.taskId ?? "default",
        sessionId: context?.sessionId,
        userId: context?.userId,
      });
    }
    return { success: false, error: `Tool "${name}" has no registered executor` };
  };

  // Build sub-agent dispatchers
  const sharedAgentDeps = { apiKey, toolExecutor, hooks: [eventBusHook] };
  const editorAgent = new EditorAgent(sharedAgentDeps);
  const creatorAgent = new CreatorAgent(sharedAgentDeps);
  const audioAgent = new AudioAgent(sharedAgentDeps);
  const visionAgent = new VisionAgent(sharedAgentDeps);
  const assetAgent = new AssetAgent(sharedAgentDeps);
  const verificationAgent = new VerificationAgent({ toolExecutor, apiKey });

  const subAgentDispatchers = new Map<string, (input: DispatchInput) => Promise<DispatchOutput>>([
    ["editor", (input) => editorAgent.dispatch(input)],
    ["creator", (input) => creatorAgent.dispatch(input)],
    ["audio", (input) => audioAgent.dispatch(input)],
    ["vision", (input) => visionAgent.dispatch(input)],
    ["asset", (input) => assetAgent.dispatch(input)],
    ["verification", (input) => verificationAgent.dispatch(input)],
  ]);

  // Wire MasterAgent — turn tracking is per-request in messageHandler (B3 fix)
  const { taskRegistry } = services;
  const masterAgent = createWiredMasterAgent({
    apiKey,
    contextManager,
    writeLock,
    eventBusHook,
    skillContracts,
    subAgentDispatchers,
    changesetManager,
    taskRegistry,
  });

  const messageHandler = createMessageHandler({
    masterAgent,
    sessionManager,
    eventBus,
  });

  // Create /skills route for Phase 5a
  const { createSkillsRouter } = await import("./routes/skills.js");
  const skillsRouter = createSkillsRouter({
    skillStore: {} as any, // DB placeholder — will be wired when DB connection is available
    memoryStore: {} as any,
  });

  // Create changeset router wired to real ChangesetManager
  const { createChangesetRouter } = await import("./routes/changeset.js");
  const changesetRouter = createChangesetRouter({ changesetManager });

  // Create app ONCE with shared services, messageHandler, and available infrastructure
  const app = createApp({
    services,
    messageHandler,
    infrastructure: { serverEditorCore, contextManager },
    skillsRouter,
    changesetRouter,
  });
  const port = parseInt(process.env.PORT || "4000");

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`ChatCut Agent Service running on http://localhost:${info.port}`);
    console.log(`  ${subAgentDispatchers.size} sub-agents registered`);
    if (skillContracts.length > 0) {
      console.log(`  ${skillContracts.length} skill contract(s) loaded`);
    }
    console.log(`  ${availableToolNames.length} master tools available`);
  });
}

main();
