import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "../memory-store.js";

describe("MemoryStore.deleteFile", () => {
  it("sends DeleteObjectCommand with correct key", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const storage = { client: { send: sendMock } };
    const store = new MemoryStore(storage, "user-123");

    await store.deleteFile("brands/acme/_skills/skill-abc.md");

    expect(sendMock).toHaveBeenCalledOnce();
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toEqual({
      Bucket: "memory",
      Key: "chatcut-memory/user-123/brands/acme/_skills/skill-abc.md",
    });
  });

  it("propagates errors from S3", async () => {
    const sendMock = vi.fn().mockRejectedValue(new Error("NoSuchKey"));
    const storage = { client: { send: sendMock } };
    const store = new MemoryStore(storage, "user-123");

    await expect(store.deleteFile("nonexistent.md")).rejects.toThrow("NoSuchKey");
  });
});
