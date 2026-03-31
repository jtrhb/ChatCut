import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { ToolExecutor } from "../executor.js";
import type { AgentType, ToolCallResult, ToolDefinition } from "../types.js";

// Concrete subclass for testing
class TestExecutor extends ToolExecutor {
  protected async executeImpl(
    toolName: string,
    input: unknown
  ): Promise<ToolCallResult> {
    return { success: true, data: { executed: toolName, input } };
  }
}

// Tool definitions used across tests
const readTool: ToolDefinition = {
  name: "read_timeline",
  description: "Read the current timeline",
  inputSchema: z.object({ sceneId: z.string() }),
  agentTypes: ["editor", "master"],
  accessMode: "read",
};

const writeTool: ToolDefinition = {
  name: "apply_cut",
  description: "Apply a cut to the timeline",
  inputSchema: z.object({ trackId: z.string(), position: z.number() }),
  agentTypes: ["editor"],
  accessMode: "write",
};

const readWriteTool: ToolDefinition = {
  name: "update_metadata",
  description: "Read and write project metadata",
  inputSchema: z.object({ key: z.string(), value: z.string() }),
  agentTypes: ["master", "creator"],
  accessMode: "read_write",
};

describe("ToolExecutor", () => {
  let executor: TestExecutor;

  beforeEach(() => {
    executor = new TestExecutor();
  });

  describe("register()", () => {
    it("adds a tool to the registry", () => {
      executor.register(readTool);
      const tools = executor.getToolDefinitions("editor");
      expect(tools.some((t) => t.name === "read_timeline")).toBe(true);
    });

    it("registers multiple tools independently", () => {
      executor.register(readTool);
      executor.register(writeTool);
      const tools = executor.getToolDefinitions("editor");
      expect(tools.length).toBe(2);
    });
  });

  describe("validatePermission()", () => {
    beforeEach(() => {
      executor.register(readTool);
      executor.register(writeTool);
    });

    it("passes for an authorized agent", () => {
      expect(() =>
        executor.validatePermission("read_timeline", "editor")
      ).not.toThrow();
    });

    it("passes for master agent which is also listed", () => {
      expect(() =>
        executor.validatePermission("read_timeline", "master")
      ).not.toThrow();
    });

    it("throws for an unauthorized agent", () => {
      expect(() =>
        executor.validatePermission("apply_cut", "audio")
      ).toThrow();
    });

    it("throws for an unknown tool", () => {
      expect(() =>
        executor.validatePermission("nonexistent_tool", "editor")
      ).toThrow();
    });
  });

  describe("isWriteOperation()", () => {
    beforeEach(() => {
      executor.register(readTool);
      executor.register(writeTool);
      executor.register(readWriteTool);
    });

    it("returns false for a read-only tool", () => {
      expect(executor.isWriteOperation("read_timeline")).toBe(false);
    });

    it("returns true for a write tool", () => {
      expect(executor.isWriteOperation("apply_cut")).toBe(true);
    });

    it("returns true for a read_write tool", () => {
      expect(executor.isWriteOperation("update_metadata")).toBe(true);
    });
  });

  describe("execute()", () => {
    beforeEach(() => {
      executor.register(readTool);
      executor.register(writeTool);
    });

    it("returns an error result when the tool is unknown", async () => {
      const result = await executor.execute("ghost_tool", {}, {
        agentType: "editor",
        taskId: "task-1",
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("returns an error result when Zod validation fails", async () => {
      // read_timeline requires { sceneId: string } — pass wrong shape
      const result = await executor.execute(
        "read_timeline",
        { sceneId: 99 }, // number instead of string
        { agentType: "editor", taskId: "task-2" }
      );
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it("calls executeImpl and returns its result on valid input", async () => {
      const result = await executor.execute(
        "read_timeline",
        { sceneId: "scene-1" },
        { agentType: "editor", taskId: "task-3" }
      );
      expect(result.success).toBe(true);
      expect((result.data as { executed: string }).executed).toBe(
        "read_timeline"
      );
    });

    it("logs a record to callLog after successful execution", async () => {
      await executor.execute(
        "read_timeline",
        { sceneId: "scene-42" },
        { agentType: "master", taskId: "task-4" }
      );
      const log = executor.getCallLog();
      expect(log.length).toBe(1);
      expect(log[0].toolName).toBe("read_timeline");
      expect(log[0].agentType).toBe("master");
      expect(log[0].taskId).toBe("task-4");
      expect(log[0].isWriteOp).toBe(false);
      expect(typeof log[0].timestamp).toBe("number");
    });

    it("logs a write-op record correctly", async () => {
      await executor.execute(
        "apply_cut",
        { trackId: "t1", position: 5 },
        { agentType: "editor", taskId: "task-5" }
      );
      const log = executor.getCallLog();
      expect(log[0].isWriteOp).toBe(true);
    });
  });

  describe("getToolDefinitions()", () => {
    beforeEach(() => {
      executor.register(readTool);      // agentTypes: ["editor", "master"]
      executor.register(writeTool);     // agentTypes: ["editor"]
      executor.register(readWriteTool); // agentTypes: ["master", "creator"]
    });

    it("returns only tools available to the given agent", () => {
      const editorTools = executor.getToolDefinitions("editor");
      expect(editorTools.map((t) => t.name).sort()).toEqual(
        ["apply_cut", "read_timeline"].sort()
      );
    });

    it("filters correctly for master agent", () => {
      const masterTools = executor.getToolDefinitions("master");
      expect(masterTools.map((t) => t.name).sort()).toEqual(
        ["read_timeline", "update_metadata"].sort()
      );
    });

    it("returns empty array for an agent with no matching tools", () => {
      const visionTools = executor.getToolDefinitions("vision");
      expect(visionTools).toHaveLength(0);
    });
  });

  describe("getCallLog()", () => {
    it("returns an empty readonly array initially", () => {
      const log = executor.getCallLog();
      expect(log).toHaveLength(0);
    });

    it("accumulates calls across multiple executions", async () => {
      executor.register(readTool);
      executor.register(writeTool);

      await executor.execute(
        "read_timeline",
        { sceneId: "s1" },
        { agentType: "editor", taskId: "t1" }
      );
      await executor.execute(
        "apply_cut",
        { trackId: "tr1", position: 2 },
        { agentType: "editor", taskId: "t2" }
      );

      expect(executor.getCallLog()).toHaveLength(2);
    });

    it("call log entry contains input and output", async () => {
      executor.register(readTool);
      const input = { sceneId: "s99" };
      await executor.execute("read_timeline", input, {
        agentType: "editor",
        taskId: "t-check",
      });
      const entry = executor.getCallLog()[0];
      expect(entry.input).toEqual(input);
      expect(entry.output.success).toBe(true);
    });
  });
});
