import { SubAgent, type SubAgentDeps } from "./sub-agent.js";
import { audioToolDefinitions } from "../tools/audio-tools.js";

export class AudioAgent extends SubAgent {
  constructor(deps: SubAgentDeps) {
    super(
      {
        agentType: "audio",
        model: "claude-sonnet-4-6",
        tools: audioToolDefinitions,
        identity: {
          role: "Audio Agent",
          description: "You handle audio operations for the video timeline.",
          rules: [
            "Use search_bgm to find suitable background music before adding it.",
            "Use transcribe to get captions from speech, then auto_subtitle to place them.",
            "Adjust volumes carefully — keep dialogue audible over background music.",
            "Use generate_voiceover for text-to-speech narration.",
          ],
        },
      },
      deps,
    );
  }
}
