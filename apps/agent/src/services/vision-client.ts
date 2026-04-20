export interface VideoAnalysis {
  scenes: Array<{ start: number; end: number; description: string; objects: string[] }>;
  characters: string[];
  mood: string;
  style: string;
}

/**
 * Progress callback shape (audit Phase 4 / tool-evolution §6). The client
 * emits progress at long-call milestones so the pipeline can forward
 * `tool.progress` events on the EventBus → SSE → web. Pipeline-side
 * wrappedProgress (tool-pipeline.ts:289) auto-injects toolName +
 * toolCallId, so clients only supply the abstract step/totalSteps/text.
 */
export type VisionProgressUpdate = { step: number; totalSteps?: number; text?: string };
export type VisionProgressCallback = (update: VisionProgressUpdate) => void;

export class VisionClient {
  private readonly apiKey: string;
  private readonly baseEndpoint: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.baseEndpoint =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent";
  }

  async analyzeVideo(
    videoUrl: string,
    focus?: string,
    onProgress?: VisionProgressCallback,
  ): Promise<VideoAnalysis> {
    const focusLine = focus ? `\nFocus on: ${focus}` : "";
    const prompt = `Analyze the following video and return a JSON object with this exact structure:
{
  "scenes": [{ "start": <number>, "end": <number>, "description": "<string>", "objects": ["<string>"] }],
  "characters": ["<string>"],
  "mood": "<string>",
  "style": "<string>"
}

Video URL: ${videoUrl}${focusLine}

Return only valid JSON, no markdown or extra text.`;

    const url = `${this.baseEndpoint}?key=${this.apiKey}`;
    onProgress?.({ step: 1, totalSteps: 3, text: "Sending analysis request to Gemini" });
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: prompt }],
          },
        ],
      }),
    });

    if (!response.ok) {
      throw new Error(
        `Gemini API request failed with status ${response.status}: ${response.statusText}`
      );
    }

    onProgress?.({ step: 2, totalSteps: 3, text: "Parsing Gemini response" });
    const data = await response.json() as Record<string, unknown>;

    if (
      !data.candidates ||
      !Array.isArray(data.candidates) ||
      data.candidates.length === 0
    ) {
      throw new Error(
        "Gemini API returned no candidates. The response may have been safety-filtered."
      );
    }

    const candidate = data.candidates[0] as Record<string, unknown>;
    const content = candidate?.content as Record<string, unknown> | undefined;
    const parts = content?.parts as Array<{ text?: string }> | undefined;

    if (!parts || parts.length === 0 || typeof parts[0].text !== "string") {
      throw new Error(
        "Gemini API candidate has no text content. The response may have been blocked or empty."
      );
    }

    const text = parts[0].text;

    try {
      const result = JSON.parse(text) as VideoAnalysis;
      onProgress?.({ step: 3, totalSteps: 3, text: "Analysis complete" });
      return result;
    } catch {
      throw new Error(
        `Failed to parse Gemini response as JSON: ${text.slice(0, 200)}`
      );
    }
  }

  locateScene(
    query: string,
    analysis: VideoAnalysis
  ): Array<{ start: number; end: number; description: string }> {
    const lowerQuery = query.toLowerCase();
    return analysis.scenes
      .filter((scene) => scene.description.toLowerCase().includes(lowerQuery))
      .map(({ start, end, description }) => ({ start, end, description }));
  }
}
