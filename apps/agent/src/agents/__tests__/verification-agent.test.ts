const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));

vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { create: mockCreate };
      constructor(_opts: unknown) {}
    },
  };
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VerificationAgent } from "../verification-agent.js";
import type { DispatchInput } from "../types.js";

function makeEndTurnResponse(text: string) {
  return {
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe("VerificationAgent", () => {
  let agent: VerificationAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    const toolExecutor = vi.fn(async () => "ok");
    agent = new VerificationAgent({ toolExecutor });
  });

  it("returns PASS verdict in result text", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse(JSON.stringify({
        verdict: "PASS",
        confidence: "high",
        issues: [],
        summary: "Edit matches user intent.",
      })),
    );
    const input: DispatchInput = {
      task: "Verify: user asked to trim intro to 3s.",
      accessMode: "read",
      context: { userIntent: "Trim the intro to 3 seconds" },
    };
    const result = await agent.dispatch(input);
    expect(result.result).toContain("PASS");
    expect(result.needsAssistance).toBeUndefined();
  });

  it("includes needsAssistance when verdict is FAIL", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse(JSON.stringify({
        verdict: "FAIL",
        confidence: "high",
        issues: ["Duration is 4s, not 3s"],
        summary: "Edit does not match user intent.",
      })),
    );
    const input: DispatchInput = {
      task: "Verify: user asked to trim intro to 3s.",
      accessMode: "read",
      context: { userIntent: "Trim the intro to 3 seconds" },
    };
    const result = await agent.dispatch(input);
    expect(result.result).toContain("FAIL");
    expect(result.needsAssistance).toBeDefined();
    expect(result.needsAssistance?.task).toContain("Duration is 4s");
  });

  it("uses claude-haiku-4-5 for cost efficiency", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse('{"verdict":"PASS","confidence":"high","issues":[],"summary":"OK"}'),
    );
    await agent.dispatch({ task: "Verify something", accessMode: "read" });
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: "claude-haiku-4-5" }),
    );
  });

  it("handles unparseable model output gracefully", async () => {
    mockCreate.mockResolvedValueOnce(
      makeEndTurnResponse("This is not JSON"),
    );
    const result = await agent.dispatch({ task: "Verify", accessMode: "read" });
    expect(result.result).toContain("PARTIAL");
  });
});
