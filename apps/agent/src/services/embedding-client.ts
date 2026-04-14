export class EmbeddingClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly defaultDimensions: number;

  constructor(apiUrl: string, apiKey: string, dimensions = 768) {
    this.apiUrl = apiUrl;
    this.apiKey = apiKey;
    this.defaultDimensions = dimensions;
  }

  async embed(input: string, dimensions?: number): Promise<number[]> {
    const result = await this.callApi(input, dimensions ?? this.defaultDimensions);
    return result.data[0].embedding;
  }

  async embedBatch(inputs: string[], dimensions?: number): Promise<number[][]> {
    const result = await this.callApi(inputs, dimensions ?? this.defaultDimensions);
    return result.data.map((d: { embedding: number[] }) => d.embedding);
  }

  private async callApi(
    input: string | string[],
    dimensions: number,
  ): Promise<{ data: Array<{ embedding: number[] }> }> {
    const response = await fetch(`${this.apiUrl}/v1/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: "gemini-embedding-2",
        input,
        dimensions,
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${text}`);
    }

    return response.json();
  }
}
