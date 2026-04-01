import { describe, it, expect } from "vitest";
import { classifyFailure } from "../failure-classifier.js";

describe("classifyFailure()", () => {
  it("classifies 'not authorized' as permission_denied, non-retryable", () => {
    const result = classifyFailure('Agent type "audio" is not authorized to use tool "apply_cut"');
    expect(result.type).toBe("permission_denied");
    expect(result.retryable).toBe(false);
  });

  it("classifies 'Validation' errors as validation_error, non-retryable", () => {
    const v = classifyFailure("Validation failed for field");
    expect(v.type).toBe("validation_error");
    expect(v.retryable).toBe(false);

    const r = classifyFailure("Required field missing");
    expect(r.type).toBe("validation_error");
    expect(r.retryable).toBe(false);

    const e = classifyFailure("Expected string, received number");
    expect(e.type).toBe("validation_error");
    expect(e.retryable).toBe(false);
  });

  it("classifies 'blocked by hook' as hook_blocked, non-retryable", () => {
    const result = classifyFailure("blocked by hook: rate limit exceeded");
    expect(result.type).toBe("hook_blocked");
    expect(result.retryable).toBe(false);
  });

  it("classifies 'timeout'/'TIMEOUT' as timeout, retryable", () => {
    const lower = classifyFailure("operation timeout after 5000ms");
    expect(lower.type).toBe("timeout");
    expect(lower.retryable).toBe(true);

    const upper = classifyFailure("TIMEOUT: request exceeded limit");
    expect(upper.type).toBe("timeout");
    expect(upper.retryable).toBe(true);
  });

  it("classifies 'idempotency' as idempotency_conflict, non-retryable", () => {
    const result = classifyFailure('idempotency conflict: key "k1" already used');
    expect(result.type).toBe("idempotency_conflict");
    expect(result.retryable).toBe(false);
  });

  it("defaults to execution_error, retryable for unknown messages", () => {
    const result = classifyFailure("something went wrong in the database");
    expect(result.type).toBe("execution_error");
    expect(result.retryable).toBe(true);
    expect(result.message).toBe("something went wrong in the database");
  });
});
