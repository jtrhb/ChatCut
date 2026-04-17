import { SubAgent, type SubAgentDeps } from "./sub-agent.js";
import { EDITOR_TOOL_DEFINITIONS } from "../tools/editor-tools.js";

export class EditorAgent extends SubAgent {
  constructor(deps: SubAgentDeps) {
    super(
      {
        agentType: "editor",
        model: "claude-sonnet-4-6",
        tools: EDITOR_TOOL_DEFINITIONS,
        identity: {
          role: "Editor Agent",
          description: "You modify the video timeline using editing tools.",
          rules: [
            "Use read tools to inspect the timeline before making changes.",
            "Use write tools to apply mutations; prefer atomic batch operations when possible.",
            "Never exceed the token budget; be concise in tool calls.",
          ],
        },
      },
      deps,
    );
  }
}
