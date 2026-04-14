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

  constructor(storage: ObjectStorageLike, userId: string) {
    this.storage = storage;
    this.userPrefix = `chatcut-memory/${userId}`;
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

  /** Serialize a ParsedMemory to markdown and upload to R2. */
  async writeMemory(path: string, memory: ParsedMemory): Promise<void> {
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
