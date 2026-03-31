import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";
import * as path from "path";
import * as os from "os";

// Mock AWS SDK modules before importing ObjectStorage
vi.mock("@aws-sdk/client-s3", () => {
  const mockSend = vi.fn();
  const MockS3Client = vi.fn(() => ({ send: mockSend }));
  return {
    S3Client: MockS3Client,
    PutObjectCommand: vi.fn((input) => ({ ...input, _type: "PutObject" })),
    GetObjectCommand: vi.fn((input) => ({ ...input, _type: "GetObject" })),
    DeleteObjectCommand: vi.fn((input) => ({ ...input, _type: "DeleteObject" })),
    __mockSend: mockSend,
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

// Import after mocks
import { ObjectStorage } from "../object-storage.js";
import * as clientS3 from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Helper to get the mocked send function
function getMockSend() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (clientS3 as any).__mockSend as ReturnType<typeof vi.fn>;
}

const DEFAULT_CONFIG = {
  accountId: "test-account",
  accessKeyId: "test-key",
  secretAccessKey: "test-secret",
  bucket: "test-bucket",
};

describe("ObjectStorage", () => {
  let storage: ObjectStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new ObjectStorage(DEFAULT_CONFIG);
  });

  describe("constructor", () => {
    it("instantiates S3Client with R2 endpoint and auto region", () => {
      expect(clientS3.S3Client).toHaveBeenCalledWith({
        region: "auto",
        endpoint: `https://${DEFAULT_CONFIG.accountId}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: DEFAULT_CONFIG.accessKeyId,
          secretAccessKey: DEFAULT_CONFIG.secretAccessKey,
        },
      });
    });
  });

  describe("upload", () => {
    it("returns a key matching prefix/uuid.extension pattern for Buffer input", async () => {
      getMockSend().mockResolvedValueOnce({});

      const buf = Buffer.from("test data");
      const key = await storage.upload(buf, {
        contentType: "video/mp4",
        prefix: "media",
        extension: ".mp4",
      });

      expect(key).toMatch(/^media\/[0-9a-f-]{36}\.mp4$/);
    });

    it("returns a key matching prefix/uuid.extension when extension is guessed from contentType", async () => {
      getMockSend().mockResolvedValueOnce({});

      const buf = Buffer.from("png data");
      const key = await storage.upload(buf, {
        contentType: "image/png",
        prefix: "images",
      });

      expect(key).toMatch(/^images\/[0-9a-f-]{36}\.png$/);
    });

    it("uses empty extension when content type is unknown and no extension provided", async () => {
      getMockSend().mockResolvedValueOnce({});

      const buf = Buffer.from("data");
      const key = await storage.upload(buf, {
        contentType: "application/octet-stream",
        prefix: "files",
      });

      // Should still be prefix/uuid (no extension or with fallback)
      expect(key).toMatch(/^files\/[0-9a-f-]{36}/);
    });

    it("calls PutObjectCommand with correct parameters", async () => {
      getMockSend().mockResolvedValueOnce({});

      const buf = Buffer.from("hello");
      await storage.upload(buf, {
        contentType: "video/mp4",
        prefix: "media",
        extension: ".mp4",
      });

      expect(clientS3.PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          Bucket: DEFAULT_CONFIG.bucket,
          ContentType: "video/mp4",
          Body: buf,
        })
      );
    });

    it("accepts a Readable stream as input", async () => {
      getMockSend().mockResolvedValueOnce({});

      const readable = Readable.from(["stream", " data"]);
      const key = await storage.upload(readable, {
        contentType: "video/webm",
        prefix: "media",
        extension: ".webm",
      });

      expect(key).toMatch(/^media\/[0-9a-f-]{36}\.webm$/);
    });
  });

  describe("getSignedUrl", () => {
    it("returns a URL string", async () => {
      const mockUrl = "https://r2.example.com/media/abc.mp4?signature=xyz";
      (getSignedUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockUrl);

      const url = await storage.getSignedUrl("media/abc.mp4");

      expect(url).toBe(mockUrl);
    });

    it("calls getSignedUrl with default expiry of 3600s", async () => {
      (getSignedUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        "https://example.com/signed"
      );

      await storage.getSignedUrl("media/abc.mp4");

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ expiresIn: 3600 })
      );
    });

    it("accepts a custom expiry", async () => {
      (getSignedUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        "https://example.com/signed"
      );

      await storage.getSignedUrl("media/abc.mp4", 7200);

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ expiresIn: 7200 })
      );
    });

    it("passes the correct bucket and key to GetObjectCommand", async () => {
      (getSignedUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        "https://example.com/signed"
      );

      await storage.getSignedUrl("media/test.mp4");

      expect(clientS3.GetObjectCommand).toHaveBeenCalledWith({
        Bucket: DEFAULT_CONFIG.bucket,
        Key: "media/test.mp4",
      });
    });
  });

  describe("downloadToTempFile", () => {
    it("returns a path inside os.tmpdir()", async () => {
      // Create a simple readable stream to simulate S3 Body
      const bodyStream = Readable.from(["chunk1", "chunk2"]);

      getMockSend().mockResolvedValueOnce({ Body: bodyStream });

      const filePath = await storage.downloadToTempFile("media/test.mp4");

      expect(filePath).toMatch(new RegExp(`^${os.tmpdir()}`));
    });

    it("returns a path ending with the correct extension from the key", async () => {
      const bodyStream = Readable.from(["data"]);
      getMockSend().mockResolvedValueOnce({ Body: bodyStream });

      const filePath = await storage.downloadToTempFile("media/test.mp4");

      expect(filePath).toMatch(/\.mp4$/);
    });

    it("returns a path ending with .png for a PNG key", async () => {
      const bodyStream = Readable.from(["png data"]);
      getMockSend().mockResolvedValueOnce({ Body: bodyStream });

      const filePath = await storage.downloadToTempFile("images/photo.png");

      expect(filePath).toMatch(/\.png$/);
    });

    it("calls GetObjectCommand with bucket and key", async () => {
      const bodyStream = Readable.from(["data"]);
      getMockSend().mockResolvedValueOnce({ Body: bodyStream });

      await storage.downloadToTempFile("media/file.mp4");

      expect(clientS3.GetObjectCommand).toHaveBeenCalledWith({
        Bucket: DEFAULT_CONFIG.bucket,
        Key: "media/file.mp4",
      });
    });
  });

  describe("delete", () => {
    it("resolves without error", async () => {
      getMockSend().mockResolvedValueOnce({});

      await expect(storage.delete("media/abc.mp4")).resolves.toBeUndefined();
    });

    it("calls DeleteObjectCommand with bucket and key", async () => {
      getMockSend().mockResolvedValueOnce({});

      await storage.delete("media/abc.mp4");

      expect(clientS3.DeleteObjectCommand).toHaveBeenCalledWith({
        Bucket: DEFAULT_CONFIG.bucket,
        Key: "media/abc.mp4",
      });
    });

    it("calls send once", async () => {
      getMockSend().mockResolvedValueOnce({});

      await storage.delete("media/abc.mp4");

      expect(getMockSend()).toHaveBeenCalledTimes(1);
    });
  });

  describe("guessExtension", () => {
    const cases: [string, string][] = [
      ["video/mp4", ".mp4"],
      ["video/webm", ".webm"],
      ["video/quicktime", ".mov"],
      ["audio/mpeg", ".mp3"],
      ["audio/wav", ".wav"],
      ["audio/ogg", ".ogg"],
      ["image/png", ".png"],
      ["image/jpeg", ".jpg"],
      ["image/gif", ".gif"],
      ["image/webp", ".webp"],
      ["application/json", ".json"],
      ["text/plain", ".txt"],
    ];

    it.each(cases)(
      "maps content-type %s → extension %s",
      async (contentType, expectedExt) => {
        getMockSend().mockResolvedValueOnce({});
        const key = await storage.upload(Buffer.from("x"), {
          contentType,
          prefix: "test",
        });
        expect(key).toMatch(new RegExp(`\\${expectedExt}$`));
      }
    );
  });
});
