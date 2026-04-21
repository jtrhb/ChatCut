/**
 * GPU service client (Phase 3 Stage C.3).
 *
 * HTTP client wrapping the Modal-deployed `services/gpu` endpoints. The
 * agent's preview-render worker uses this for all preview rendering.
 *
 * Wire shape (matches services/gpu/modal_app.py):
 *   POST /render_preview  body: { explorationId, candidateId, snapshotStorageKey }
 *                         200:  { jobId }
 *   GET  /status?job_id=  200:  { job_id, state, progress, result?, error? }
 *
 * Auth: every request carries an `X-API-Key` header. Errors come back
 * wrapped in FastAPI's `{"detail": ...}` envelope; we unwrap that on
 * the way out so callers see clean GpuServiceError instances.
 */

export interface EnqueueRenderArgs {
  explorationId: string;
  candidateId: string;
  snapshotStorageKey: string;
}

export interface EnqueueRenderResult {
  jobId: string;
}

export type JobState = "queued" | "running" | "done" | "failed";

/**
 * Discriminated union: the `state` field narrows the rest of the shape.
 * `done` always carries `result.storage_key`; `failed` always carries
 * `error`; in-progress variants carry neither. Reviewer Stage C MED #5.
 */
export interface JobStatusInProgress {
  job_id: string;
  state: "queued" | "running";
  progress: number;
}

export interface JobStatusDone {
  job_id: string;
  state: "done";
  progress: number;
  result: { storage_key: string };
}

export interface JobStatusFailed {
  job_id: string;
  state: "failed";
  progress: number;
  error: string;
  /** True for client-synthesized failures (e.g. polling timeout, GPU may still be running). */
  synthesized?: boolean;
}

export type JobStatusResult = JobStatusInProgress | JobStatusDone | JobStatusFailed;

/** The two terminal states pollUntilTerminal can return. */
export type TerminalJobStatus = JobStatusDone | JobStatusFailed;

/**
 * Thrown for any non-2xx response. Carries the HTTP status, a unwrapped
 * message, the raw FastAPI `detail` value, and (for stub 501s) the
 * `phase` field that names the future stage that will implement the
 * endpoint.
 */
export class GpuServiceError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail?: unknown,
    public readonly phase?: string,
  ) {
    super(message);
    this.name = "GpuServiceError";
  }
}

export interface GpuServiceClientDeps {
  baseUrl: string;
  apiKey: string;
  /** Injected for tests; defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
}

export class GpuServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(deps: GpuServiceClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, "");
    this.apiKey = deps.apiKey;
    this._fetch = deps.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async enqueueRender(args: EnqueueRenderArgs): Promise<EnqueueRenderResult> {
    const response = await this._fetch(`${this.baseUrl}/render_preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": this.apiKey,
      },
      body: JSON.stringify({
        explorationId: args.explorationId,
        candidateId: args.candidateId,
        snapshotStorageKey: args.snapshotStorageKey,
      }),
    });
    return await this._unwrap<EnqueueRenderResult>(response, "render_preview");
  }

  async getJobStatus(jobId: string): Promise<JobStatusResult> {
    const url = `${this.baseUrl}/status?job_id=${encodeURIComponent(jobId)}`;
    const response = await this._fetch(url, {
      method: "GET",
      headers: { "X-API-Key": this.apiKey },
    });
    return await this._unwrap<JobStatusResult>(response, "status");
  }

  private async _unwrap<T>(response: Response, op: string): Promise<T> {
    if (response.ok) {
      // Reviewer Stage C MED #7: a 200 with malformed JSON should
      // throw a clean GpuServiceError, not a raw SyntaxError.
      try {
        return (await response.json()) as T;
      } catch (parseErr) {
        throw new GpuServiceError(
          response.status,
          `${op} succeeded (HTTP ${response.status}) but body was not valid JSON: ${
            parseErr instanceof Error ? parseErr.message : String(parseErr)
          }`,
        );
      }
    }
    // FastAPI's HTTPException wraps the body under {"detail": ...}.
    // detail can be a string OR an object (e.g. our 501 stub returns
    // {error, phase}); unwrap both shapes into a clean GpuServiceError.
    // Read body once as text — failed JSON parse can't replay a fetch
    // body (it's a one-shot stream). Wrap the text() call too: a
    // mid-body connection drop should surface as GpuServiceError, not
    // a bare TypeError (reviewer Stage C MED #7).
    let text: string;
    try {
      text = await response.text();
    } catch (readErr) {
      throw new GpuServiceError(
        response.status,
        `${op} failed (HTTP ${response.status}); body unreadable: ${
          readErr instanceof Error ? readErr.message : String(readErr)
        }`,
      );
    }
    let body: { detail?: unknown } = { detail: text };
    if (text) {
      try {
        body = JSON.parse(text) as { detail?: unknown };
      } catch {
        // non-JSON (e.g. gateway HTML) — keep text as detail
      }
    }
    const detail = body?.detail;
    let message: string;
    let phase: string | undefined;
    if (detail && typeof detail === "object") {
      const d = detail as { error?: string; phase?: string };
      message = d.error ?? `${op} failed (HTTP ${response.status})`;
      phase = d.phase;
    } else if (typeof detail === "string" && detail.length > 0) {
      message = detail;
    } else {
      message = `${op} failed (HTTP ${response.status})`;
    }
    throw new GpuServiceError(response.status, message, detail, phase);
  }
}
