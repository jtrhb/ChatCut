import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared mock function references — declared before vi.mock so the factory closure captures them
const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockSend = vi.fn().mockResolvedValue("mock-job-id");
const mockWork = vi.fn().mockResolvedValue(undefined);

// Mock pg-boss entirely before importing JobQueue
vi.mock("pg-boss", () => {
  const MockPgBoss = vi.fn(() => ({
    start: mockStart,
    stop: mockStop,
    send: mockSend,
    work: mockWork,
  }));
  return { default: MockPgBoss };
});

// Import after mocks
import { JobQueue } from "../job-queue.js";
import PgBoss from "pg-boss";

const CONNECTION_STRING = "postgres://user:pass@localhost:5432/testdb";

describe("JobQueue", () => {
  let queue: JobQueue;

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default resolved values after clearAllMocks
    mockStart.mockResolvedValue(undefined);
    mockStop.mockResolvedValue(undefined);
    mockSend.mockResolvedValue("mock-job-id");
    mockWork.mockResolvedValue(undefined);

    queue = new JobQueue({ connectionString: CONNECTION_STRING });
  });

  describe("constructor", () => {
    it("creates a PgBoss instance with the provided connectionString", () => {
      expect(PgBoss).toHaveBeenCalledWith(CONNECTION_STRING);
    });

    it("creates exactly one PgBoss instance per JobQueue", () => {
      // One call from beforeEach
      expect(PgBoss).toHaveBeenCalledTimes(1);
    });
  });

  describe("start()", () => {
    it("calls boss.start()", async () => {
      await queue.start();
      expect(mockStart).toHaveBeenCalledTimes(1);
    });

    it("resolves without a value", async () => {
      mockStart.mockResolvedValueOnce(undefined);
      await expect(queue.start()).resolves.toBeUndefined();
    });
  });

  describe("stop()", () => {
    it("calls boss.stop()", async () => {
      await queue.stop();
      expect(mockStop).toHaveBeenCalledTimes(1);
    });

    it("resolves without a value", async () => {
      mockStop.mockResolvedValueOnce(undefined);
      await expect(queue.stop()).resolves.toBeUndefined();
    });
  });

  describe("enqueue()", () => {
    it("calls boss.send() with the job name and data", async () => {
      const data = { videoId: "abc-123" };
      await queue.enqueue("render-video", data);
      expect(mockSend).toHaveBeenCalledWith(
        "render-video",
        data,
        expect.any(Object)
      );
    });

    it("returns the job id string from boss.send()", async () => {
      mockSend.mockResolvedValueOnce("returned-job-id");
      const id = await queue.enqueue("render-video", { videoId: "abc" });
      expect(id).toBe("returned-job-id");
    });

    it("passes correct default retryLimit (2) and retryDelay (30)", async () => {
      await queue.enqueue("render-video", { videoId: "abc" });
      expect(mockSend).toHaveBeenCalledWith(
        "render-video",
        expect.anything(),
        expect.objectContaining({ retryLimit: 2, retryDelay: 30 })
      );
    });

    it("passes singletonKey when provided for idempotency", async () => {
      await queue.enqueue("render-video", { videoId: "abc" }, { singletonKey: "video-abc-123" });
      expect(mockSend).toHaveBeenCalledWith(
        "render-video",
        expect.anything(),
        expect.objectContaining({ singletonKey: "video-abc-123" })
      );
    });

    it("passes expireInMinutes when provided", async () => {
      await queue.enqueue("render-video", { videoId: "abc" }, { expireInMinutes: 60 });
      expect(mockSend).toHaveBeenCalledWith(
        "render-video",
        expect.anything(),
        expect.objectContaining({ expireInMinutes: 60 })
      );
    });

    it("allows overriding retryLimit and retryDelay via options", async () => {
      await queue.enqueue("render-video", { videoId: "abc" }, { retryLimit: 5, retryDelay: 60 });
      expect(mockSend).toHaveBeenCalledWith(
        "render-video",
        expect.anything(),
        expect.objectContaining({ retryLimit: 5, retryDelay: 60 })
      );
    });

    it("returns null when boss.send() returns null", async () => {
      mockSend.mockResolvedValueOnce(null);
      const id = await queue.enqueue("render-video", { videoId: "abc" });
      expect(id).toBeNull();
    });
  });

  describe("registerWorker()", () => {
    it("calls boss.work() with the job name and handler", () => {
      const handler = vi.fn();
      queue.registerWorker("render-video", handler);
      expect(mockWork).toHaveBeenCalledWith(
        "render-video",
        expect.any(Object),
        expect.any(Function)
      );
    });

    it("passes teamSize option to boss.work(), defaulting to 1", () => {
      const handler = vi.fn();
      queue.registerWorker("render-video", handler);
      expect(mockWork).toHaveBeenCalledWith(
        "render-video",
        expect.objectContaining({ teamSize: 1 }),
        expect.any(Function)
      );
    });

    it("passes custom teamSize when provided", () => {
      const handler = vi.fn();
      queue.registerWorker("render-video", handler, { teamSize: 4 });
      expect(mockWork).toHaveBeenCalledWith(
        "render-video",
        expect.objectContaining({ teamSize: 4 }),
        expect.any(Function)
      );
    });

    it("wraps the handler so it is called with the job", async () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      queue.registerWorker<{ videoId: string }>("render-video", handler);

      // Capture the wrapper passed to boss.work and invoke it
      const [, , wrapper] = mockWork.mock.calls[0] as [string, object, (job: object) => Promise<void>];
      const fakeJob = { id: "job-1", data: { videoId: "xyz" } };
      await wrapper(fakeJob);

      expect(handler).toHaveBeenCalledWith(fakeJob);
    });
  });
});
