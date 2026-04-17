import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import type { ParsedMemory } from "./types.js";
import { parseFrontmatter } from "../utils/frontmatter.js";

/**
 * Minimal interface for the ObjectStorage dependency so we can accept both
 * the real ObjectStorage class and a test double without importing the
 * concrete class (which drags in heavy AWS SDK construction side-effects).
 */
interface ObjectStorageLike {
  client: {
    send(command: unknown): Promise<unknown>;
  };
}

export class MemoryStore {
  private readonly storage: ObjectStorageLike;
  private readonly userPrefix: string;
  /**
   * Per-instance writer token. Held privately on construction and handed to
   * MasterAgent exactly once via grantWriterToken(). writeMemory checks this
   * token so writes can only originate from whoever holds it. Per spec §9.4,
   * that is MasterAgent — the sole memory writer.
   */
  private readonly writerToken = Symbol("memory-writer");
  private tokenGranted = false;

  constructor(storage: ObjectStorageLike, userId: string) {
    this.storage = storage;
    this.userPrefix = `chatcut-memory/${userId}`;
  }

  /**
   * Hand out the writer token. MUST only be called from MasterAgent
   * construction. Throws on repeat issuance so the token cannot be
   * re-granted to another holder. If a test needs a write-capable handle,
   * it should instantiate MasterAgent (or call this once and use the
   * returned symbol as a "master stand-in").
   */
  grantWriterToken(): symbol {
    if (this.tokenGranted) {
      throw new Error(
        "MemoryStore writer token already granted; MasterAgent is the sole writer " +
        "and only one grant is permitted per store instance.",
      );
    }
    this.tokenGranted = true;
    return this.writerToken;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Download raw text content from R2 at `userPrefix/path`. */
  async readFile(path: string): Promise<string> {
    const key = `${this.userPrefix}/${path}`;
    const command = new GetObjectCommand({
      Bucket: "memory", // bucket is embedded in the storage client config
      Key: key,
    });

    const response = (await this.storage.client.send(command)) as {
      Body: { transformToString(): Promise<string> };
    };

    return response.Body.transformToString();
  }

  /** Read file and parse YAML frontmatter + content body into a ParsedMemory. */
  async readParsed(path: string): Promise<ParsedMemory> {
    const raw = await this.readFile(path);
    return parseFrontmatter(raw);
  }

  /**
   * Serialize a ParsedMemory to markdown and upload to R2.
   *
   * Gated on the writer token: only the holder (MasterAgent, per spec §9.4)
   * may call this. Non-Master code paths should invoke MasterAgent.writeMemory
   * which internally supplies the correct token.
   */
  async writeMemory(token: symbol, path: string, memory: ParsedMemory): Promise<void> {
    if (token !== this.writerToken) {
      throw new Error(
        "MemoryStore.writeMemory denied: a valid writer token is required. " +
        "All writes must be routed through MasterAgent (spec §9.4 — sole memory writer).",
      );
    }

    const key = `${this.userPrefix}/${path}`;
    const markdown = this.serializeToMarkdown(memory);

    const command = new PutObjectCommand({
      Bucket: "memory",
      Key: key,
      Body: markdown,
      ContentType: "text/markdown",
    });

    await this.storage.client.send(command);
  }

  /** List object filenames (not full keys) under `userPrefix/path`. */
  async listDir(path: string): Promise<string[]> {
    const prefix = `${this.userPrefix}/${path}`;
    const command = new ListObjectsV2Command({
      Bucket: "memory",
      Prefix: prefix,
    });

    const response = (await this.storage.client.send(command)) as {
      Contents?: { Key: string }[];
    };

    if (!response.Contents) return [];

    return response.Contents.map((obj) => {
      // Strip the prefix to return just the filename
      return obj.Key.slice(prefix.length);
    }).filter((name) => name.length > 0);
  }

  /** Delete a file from R2 at `userPrefix/path`. */
  async deleteFile(path: string): Promise<void> {
    const key = `${this.userPrefix}/${path}`;
    const command = new DeleteObjectCommand({
      Bucket: "memory",
      Key: key,
    });
    await this.storage.client.send(command);
  }

  /** Return true if the file exists in R2, false otherwise. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.readFile(path);
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Serialize a ParsedMemory back to `---\nyaml\n---\ncontent` markdown format.
   * The `content` field is written as the body, not as a frontmatter key.
   */
  private serializeToMarkdown(memory: ParsedMemory): string {
    const { content, ...meta } = memory;

    const lines: string[] = [];
    for (const [key, value] of Object.entries(meta)) {
      if (value === undefined) continue;

      if (Array.isArray(value)) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else if (typeof value === "object" && value !== null) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    }

    return `---\n${lines.join("\n")}\n---\n${content}`;
  }
}
