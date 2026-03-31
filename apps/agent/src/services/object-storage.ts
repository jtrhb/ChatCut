import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { randomUUID } from "crypto";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { join, extname } from "path";
import { tmpdir } from "os";
import type { Readable } from "stream";

export interface ObjectStorageConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface UploadOptions {
  contentType: string;
  prefix: string;
  extension?: string;
}

const CONTENT_TYPE_MAP: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-msvideo": ".avi",
  "video/mpeg": ".mpeg",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/flac": ".flac",
  "audio/aac": ".aac",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "application/json": ".json",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/html": ".html",
  "text/css": ".css",
  "application/javascript": ".js",
};

export class ObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ObjectStorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  /**
   * Map a MIME content type to a file extension (including leading dot).
   * Returns empty string for unknown types.
   */
  guessExtension(contentType: string): string {
    return CONTENT_TYPE_MAP[contentType] ?? "";
  }

  /**
   * Upload data (Buffer or Readable stream) to R2.
   * Returns the immutable storage key, e.g. `media/uuid.mp4`.
   */
  async upload(
    data: Buffer | Readable,
    options: UploadOptions
  ): Promise<string> {
    const ext =
      options.extension !== undefined
        ? options.extension
        : this.guessExtension(options.contentType);

    const key = `${options.prefix}/${randomUUID()}${ext}`;

    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: options.contentType,
      })
    );

    return key;
  }

  /**
   * Generate a time-limited pre-signed URL for the given key.
   * Defaults to 3600 seconds (1 hour).
   */
  async getSignedUrl(key: string, expiresIn = 3600): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    return getSignedUrl(this.client, command, { expiresIn });
  }

  /**
   * Download an object from R2, streaming it to a temp file.
   * Returns the absolute path of the written temp file.
   * Uses streaming to avoid loading the entire file into memory.
   */
  async downloadToTempFile(key: string): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
    });

    const response = await this.client.send(command);

    if (!response.Body) {
      throw new Error(`No body returned for key: ${key}`);
    }

    const ext = extname(key);
    const tmpPath = join(tmpdir(), `${randomUUID()}${ext}`);
    const writeStream = createWriteStream(tmpPath);

    await pipeline(response.Body as Readable, writeStream);

    return tmpPath;
  }

  /**
   * Delete an object from R2 by key.
   */
  async delete(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      })
    );
  }
}
