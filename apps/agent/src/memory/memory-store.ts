import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { ParsedMemory } from "./types.js";

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
    return this.parseFrontmatter(raw);
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
   * Parse `---\nyaml\n---\ncontent` format into a ParsedMemory.
   * Handles strings, numbers, booleans, JSON arrays, and JSON objects.
   */
  private parseFrontmatter(raw: string): ParsedMemory {
    if (!raw.startsWith("---")) {
      throw new Error("Invalid memory file: missing frontmatter opening ---");
    }

    // Find the closing ---
    const afterOpen = raw.slice(3); // skip opening ---
    const closeIdx = afterOpen.indexOf("\n---");
    if (closeIdx === -1) {
      throw new Error("Invalid memory file: missing frontmatter closing ---");
    }

    const yamlBlock = afterOpen.slice(0, closeIdx).trim();
    // Content starts after the closing ---\n
    const content = afterOpen.slice(closeIdx + 4).trim(); // +4 for "\n---"

    const fields: Record<string, unknown> = {};

    for (const line of yamlBlock.split("\n")) {
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();

      fields[key] = this.parseYamlValue(rawValue);
    }

    // Build the ParsedMemory — required fields with safe fallbacks
    const mem: ParsedMemory = {
      memory_id: String(fields.memory_id ?? ""),
      type: (fields.type as ParsedMemory["type"]) ?? "knowledge",
      status: (fields.status as ParsedMemory["status"]) ?? "draft",
      confidence: (fields.confidence as ParsedMemory["confidence"]) ?? "low",
      source: (fields.source as ParsedMemory["source"]) ?? "implicit",
      created: String(fields.created ?? ""),
      updated: String(fields.updated ?? ""),
      reinforced_count: Number(fields.reinforced_count ?? 0),
      last_reinforced_at: String(fields.last_reinforced_at ?? ""),
      source_change_ids: (fields.source_change_ids as string[]) ?? [],
      used_in_changeset_ids: (fields.used_in_changeset_ids as string[]) ?? [],
      created_session_id: String(fields.created_session_id ?? ""),
      scope: String(fields.scope ?? "global"),
      scope_level: (fields.scope_level as ParsedMemory["scope_level"]) ?? "global",
      semantic_key: String(fields.semantic_key ?? ""),
      tags: (fields.tags as string[]) ?? [],
      content,
    };

    // Optional fields
    if (fields.last_used_at !== undefined) {
      mem.last_used_at = String(fields.last_used_at);
    }
    if (fields.last_reinforced_session_id !== undefined) {
      mem.last_reinforced_session_id = String(fields.last_reinforced_session_id);
    }
    if (fields.activation_scope !== undefined) {
      mem.activation_scope = fields.activation_scope as ParsedMemory["activation_scope"];
    }
    if (fields.skill_id !== undefined) {
      mem.skill_id = String(fields.skill_id);
    }
    if (fields.skill_status !== undefined) {
      mem.skill_status = fields.skill_status as ParsedMemory["skill_status"];
    }
    if (fields.agent_type !== undefined) {
      mem.agent_type = Array.isArray(fields.agent_type)
        ? (fields.agent_type as string[])
        : String(fields.agent_type);
    }
    if (fields.applies_to !== undefined) {
      mem.applies_to = fields.applies_to as string[];
    }

    return mem;
  }

  /** Parse a single YAML scalar value: number, boolean, JSON array/object, or string. */
  private parseYamlValue(raw: string): unknown {
    if (raw === "") return "";

    // JSON array
    if (raw.startsWith("[")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    // JSON object
    if (raw.startsWith("{")) {
      try {
        return JSON.parse(raw);
      } catch {
        return raw;
      }
    }

    // Boolean
    if (raw === "true") return true;
    if (raw === "false") return false;

    // Number (integer or float)
    const num = Number(raw);
    if (!isNaN(num) && raw !== "") return num;

    // Plain string
    return raw;
  }

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
