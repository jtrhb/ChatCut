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

  // Create ChangesetManager for propose/approve/reject workflow
  const changeLog = new ChangeLog();
  const changesetManager = new ChangesetManager({ changeLog, serverCore: serverEditorCore });

  // Tool executor for sub-agents — routes to real implementations when available.
  const toolExecutor = async (name: string, input: unknown) => {
    if (editorToolExecutor.hasToolName(name)) {
      return editorToolExecutor.execute(name, input, { agentType: "editor", taskId: "default" });
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

  // Create app ONCE with shared services, messageHandler, and available infrastructure
  const app = createApp({
    services,
    messageHandler,
    infrastructure: { serverEditorCore, contextManager },
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
