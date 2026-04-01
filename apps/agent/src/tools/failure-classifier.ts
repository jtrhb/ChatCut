export type FailureType =
  | "permission_denied"
  | "validation_error"
  | "hook_blocked"
  | "execution_error"
  | "timeout"
  | "idempotency_conflict"
  | "unknown";

export interface ClassifiedFailure {
  type: FailureType;
  retryable: boolean;
  message: string;
}

export function classifyFailure(error: string): ClassifiedFailure {
  if (error.includes("not authorized")) {
    return { type: "permission_denied", retryable: false, message: error };
  }
  if (
    error.includes("Validation") ||
    error.includes("Required") ||
    error.includes("Expected")
  ) {
    return { type: "validation_error", retryable: false, message: error };
  }
  if (error.includes("blocked by hook")) {
    return { type: "hook_blocked", retryable: false, message: error };
  }
  if (error.includes("idempotency")) {
    return { type: "idempotency_conflict", retryable: false, message: error };
  }
  if (error.includes("timeout") || error.includes("TIMEOUT")) {
    return { type: "timeout", retryable: true, message: error };
  }
  return { type: "execution_error", retryable: true, message: error };
}
