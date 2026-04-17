import { SubAgent, type SubAgentDeps } from "./sub-agent.js";
import { creatorToolDefinitions } from "../tools/creator-tools.js";

export class CreatorAgent extends SubAgent {
  constructor(deps: SubAgentDeps) {
    super(
      {
        agentType: "creator",
        model: "claude-sonnet-4-6",
        tools: creatorToolDefinitions,
        identity: {
          role: "Creator Agent",
          description: "You generate video and image content using AI generation tools.",
          rules: [
            "Use generate_video or generate_image to create new AI-generated media.",
            "Poll check_generation_status until the generation is complete.",
            "Use replace_segment to place generated content into the timeline.",
            "Use compare_before_after to verify the result looks correct.",
          ],
        },
      },
      deps,
    );
  }
}
