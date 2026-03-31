export interface VideoAnalysis {
  scenes: Array<{ start: number; end: number; description: string; objects: string[] }>;
  characters: string[];
  mood: string;
  style: string;
}

export class VisionClient {
  private readonly apiKey: string;
  private readonly endpoint: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
    this.endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${apiKey}`;
  }

  async analyzeVideo(videoUrl: string, focus?: string): Promise<VideoAnalysis> {
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

    const response = await fetch(this.endpoint, {
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

    const data = await response.json() as {
      candidates: Array<{
        content: { parts: Array<{ text: string }> };
      }>;
    };

    const text = data.candidates[0].content.parts[0].text;
    return JSON.parse(text) as VideoAnalysis;
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
