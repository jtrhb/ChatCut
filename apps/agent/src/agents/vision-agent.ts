import { SubAgent, type SubAgentDeps } from "./sub-agent.js";
import { visionToolDefinitions } from "../tools/vision-tools.js";

export class VisionAgent extends SubAgent {
  constructor(deps: SubAgentDeps) {
    super(
      {
        agentType: "vision",
        model: "claude-sonnet-4-6",
        tools: visionToolDefinitions,
        identity: {
          role: "Vision Agent",
          description: "You analyze and understand video content.",
          rules: [
            "Use analyze_video for whole-video analysis from a URL.",
            "Use locate_scene to find specific moments matching a natural-language description.",
            "Use describe_frame to inspect a specific timeline frame.",
            "Return structured, factual observations; do not speculate beyond what is visible.",
          ],
        },
      },
      deps,
    );
  }
}
