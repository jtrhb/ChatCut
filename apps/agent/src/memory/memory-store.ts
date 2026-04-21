import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { createHash } from "crypto";
import type { ParsedMemory, ConflictMarker } from "./types.js";
import { parseFrontmatter, parseConflictMarker } from "../utils/frontmatter.js";

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
  // Phase 5c — Conflict markers
  // ---------------------------------------------------------------------------

  /**
   * Phase 5c: write a `_conflicts/{ISO-ts}-{actionType}-{shortHash}.md` marker.
   *
   * Same writer-token gate as writeMemory — only MasterAgent (per spec §9.4)
   * may persist. MemoryExtractor reaches this via a master-bound callback so
   * it never touches the store directly.
   *
   * Filename includes an ISO timestamp so `listDir("_conflicts/")` returns
   * markers in natural chronological order. The shortHash dedupe helps avoid
   * filename collisions when several markers fire in the same millisecond.
   */
  async writeConflictMarker(
    token: symbol,
    params: {
      actionType: string;
      target?: string;
      severity: ConflictMarker["severity"];
      conflictsWith?: string[];
      reason: string;
    },
  ): Promise<{ path: string; marker: ConflictMarker }> {
    if (token !== this.writerToken) {
      throw new Error(
        "MemoryStore.writeConflictMarker denied: a valid writer token is required. " +
        "All writes must be routed through MasterAgent (spec §9.4 — sole memory writer).",
      );
    }

    const now = new Date().toISOString();
    const target = params.target ?? "*";
    // Short content-hash for filename uniqueness when ISO timestamps collide.
    const shortHash = createHash("sha256")
      .update(`${params.actionType}|${target}|${params.reason}|${now}`)
      .digest("hex")
      .slice(0, 8);
    const safeActionType = params.actionType.replace(/[^a-zA-Z0-9_-]/g, "_");
    // Filesystem-safe ISO: replace `:` with `-` (Windows + S3 path safety).
    const safeIso = now.replace(/:/g, "-");
    const filename = `${safeIso}-${safeActionType}-${shortHash}.md`;
    const path = `_conflicts/${filename}`;

    const marker: ConflictMarker = {
      marker_id: `conflict-${shortHash}`,
      action_type: params.actionType,
      target,
      severity: params.severity,
      conflicts_with: params.conflictsWith ?? [],
      first_seen_at: now,
      last_seen_at: now,
      reason: params.reason,
    };

    const markdown = this.serializeConflictMarker(marker);
    const command = new PutObjectCommand({
      Bucket: "memory",
      Key: `${this.userPrefix}/${path}`,
      Body: markdown,
      ContentType: "text/markdown",
    });
    await this.storage.client.send(command);

    return { path, marker };
  }

  /**
   * Read a single conflict marker file and parse it. Errors propagate so the
   * caller (typically MemoryLoader.loadConflictMarkers, which handles the
   * skip-on-error policy) decides whether to drop or surface.
   */
  async readConflictMarker(path: string): Promise<ConflictMarker> {
    const raw = await this.readFile(path);
    return parseConflictMarker(raw);
  }

  /** List conflict marker filenames (not full paths) under `_conflicts/`. */
  async listConflictMarkers(): Promise<string[]> {
    return this.listDir("_conflicts/");
  }

  /**
   * Serialize a ConflictMarker to the same `---\nyaml\n---\nbody` format used
   * by ParsedMemory, with the reason as the body. Mirrors serializeToMarkdown
   * but kept separate so the field shapes don't get muddled.
   */
  private serializeConflictMarker(marker: ConflictMarker): string {
    const lines: string[] = [
      `marker_id: ${marker.marker_id}`,
      `action_type: ${marker.action_type}`,
      `target: ${marker.target}`,
      `severity: ${marker.severity}`,
      `conflicts_with: ${JSON.stringify(marker.conflicts_with)}`,
      `first_seen_at: ${marker.first_seen_at}`,
      `last_seen_at: ${marker.last_seen_at}`,
    ];
    return `---\n${lines.join("\n")}\n---\n${marker.reason}`;
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
