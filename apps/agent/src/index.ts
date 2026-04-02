import { serve } from "@hono/node-server";
import { createApp, createWiredMasterAgent, createMessageHandler } from "./server.js";
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

  // Create shared project infrastructure
  const contextManager = new ProjectContextManager();
  const writeLock = new ProjectWriteLock();

  // Create the app first to get shared services (EventBus, SessionManager, etc.)
  const app = createApp({ skillContracts });
  const { sessionManager, eventBus, eventBusHook } = app.services;

  // Stub tool executor for sub-agents (routes tool calls back to the pipeline)
  const toolExecutor = async (name: string, input: unknown) => {
    return { error: `Tool ${name} not yet wired to a real executor` };
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

  // Create a default session for the initial wiring
  // In production, per-request sessions are created by the chat route
  const defaultSession = sessionManager.createSession({ projectId: "default" });

  // Wire up the MasterAgent with full production plumbing
  const masterAgent = createWiredMasterAgent({
    apiKey,
    contextManager,
    writeLock,
    sessionManager,
    sessionId: defaultSession.sessionId,
    eventBusHook,
    skillContracts,
    subAgentDispatchers,
  });

  // Create the message handler and hot-wire it into the chat route
  const messageHandler = createMessageHandler({
    masterAgent,
    sessionManager,
    eventBus,
  });

  // Re-create app with messageHandler wired in
  const wiredApp = createApp({ skillContracts, messageHandler });
  const port = parseInt(process.env.PORT || "4000");

  serve({ fetch: wiredApp.fetch, port }, (info) => {
    console.log(`ChatCut Agent Service running on http://localhost:${info.port}`);
    console.log(`  ${subAgentDispatchers.size} sub-agents registered`);
    if (skillContracts.length > 0) {
      console.log(`  ${skillContracts.length} skill contract(s) loaded`);
    }
    console.log(`  ${availableToolNames.length} master tools available`);
  });
}

main();
