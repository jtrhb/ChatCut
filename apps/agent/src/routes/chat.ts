import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { SessionManager } from "../session/session-manager.js";
import type { EventBus } from "../events/event-bus.js";

/**
 * Identity context for an authenticated request. Added for B1 tenant isolation.
 * `userId` will become required once the auth middleware lands; currently read
 * from `x-user-id` header for incremental migration. All downstream tool /
 * store calls should prefer `identity.userId` over hardcoded placeholders.
 */
export interface RequestIdentity {
  userId?: string;
  sessionId: string;
  projectId: string;
}

/**
 * Phase 5d: spatial annotation rectangle in 0..1 normalized coords against
 * the preview canvas (Q4 — resolution-independent so server-side handling
 * doesn't break across viewport changes).
 */
export const SpatialAnnotationSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
  w: z.number().min(0).max(1),
  h: z.number().min(0).max(1),
  /** Optional free-text label scribbled next to the box ("this", "remove"). */
  label: z.string().max(200).optional(),
});

/**
 * Phase 5d: temporal window the user wants the agent to focus on.
 *
 * LOW-2 fix: enforce `endSec > startSec` at the schema layer. Without this,
 * a buggy client could ship an inverted (`endSec < startSec`) or zero-
 * duration (`endSec === startSec`) window that the formatter would render
 * verbatim, producing prompts like "Temporal: 5.00s → 3.00s" that are
 * incoherent to the model. Reject at the gate so the operator gets a
 * clear 400 instead of a silent semantic failure downstream.
 */
export const TemporalAnnotationSchema = z
  .object({
    startSec: z.number().min(0),
    endSec: z.number().min(0),
  })
  .refine((t) => t.endSec > t.startSec, {
    message: "endSec must be strictly greater than startSec",
  });

/**
 * Phase 5d (Q3): schema supports 1..N spatial + 0..N temporal even though
 * the v1 UI is single-shot. Lets a future multi-select UX land without a
 * schema migration.
 */
export const AnnotationsSchema = z
  .object({
    spatial: z.array(SpatialAnnotationSchema).optional(),
    temporal: TemporalAnnotationSchema.optional(),
    /** Reference to a previously-emitted ghost element ("apply this to ghost-X"). */
    ghostRef: z.object({ ghostId: z.string() }).optional(),
  })
  .optional();

/**
 * Phase 5d (Q1=d): the annotated frame — overlay drawn on the captured
 * preview frame BEFORE base64 encoding. Carries the "I mean THIS one"
 * signal directly. Anthropic vision blocks accept png/jpeg/webp/gif.
 *
 * LOW-3 clarification: `12_000_000` caps the base64 STRING length, which
 * is ~9MB of decoded image bytes (base64 is 4/3 inflation). The
 * effective ceiling is also bounded by:
 *   - Anthropic's per-image limit (currently ~5MB decoded; check current
 *     SDK docs as it can change)
 *   - The route-level body limit middleware in createChatRouter
 *     (CHAT_BODY_LIMIT below) which gates total request size
 * The 12MB schema cap is a final defensive layer; the body-limit
 * middleware catches oversized payloads BEFORE JSON.parse allocates them.
 */
export const AnnotatedFrameSchema = z
  .object({
    mediaType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]),
    /** Raw base64 (NO `data:image/...;base64,` prefix). */
    base64: z.string().min(1).max(12_000_000),
  })
  .optional();

/**
 * Phase 5d LOW-4: total chat request body cap. The annotatedFrame field
 * raised legitimate payload sizes from KB to multi-MB; without a body
 * limit at the route, c.req.json() at line 165 would parse an arbitrarily
 * large payload into memory before the schema runs. 16MB leaves room for
 * the 12MB base64 frame + reasonable message text + envelope overhead.
 */
export const CHAT_BODY_LIMIT = 16 * 1024 * 1024;

export type SpatialAnnotation = z.infer<typeof SpatialAnnotationSchema>;
export type TemporalAnnotation = z.infer<typeof TemporalAnnotationSchema>;
export type Annotations = z.infer<typeof AnnotationsSchema>;
export type AnnotatedFrame = z.infer<typeof AnnotatedFrameSchema>;

/**
 * Message handler function — decouples routing from agent execution.
 * In production, this wraps MasterAgent.handleUserMessage().
 * `identity` is optional during B1 migration; handlers wired after B1.b
 * may rely on it for tenant-scoped execution.
 *
 * Phase 5d: gained optional `annotations` (coords + ghost refs) and
 * `annotatedFrame` (base64 image with the user's overlay drawn on it) so
 * the model can ground spatial intent on what the user actually circled.
 * Both optional — un-annotated messages cost nothing extra.
 */
export type MessageHandler = (
  message: string,
  sessionId: string,
  identity?: RequestIdentity,
  annotations?: Annotations,
  annotatedFrame?: AnnotatedFrame,
) => Promise<string>;

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
  sessionId: z.string().uuid().optional(),
  annotations: AnnotationsSchema,
  annotatedFrame: AnnotatedFrameSchema,
});

function createChatRouter(deps: {
  sessionManager: SessionManager;
  eventBus?: EventBus;
  messageHandler?: MessageHandler;
}): Hono {
  const { sessionManager, eventBus, messageHandler } = deps;
  const router = new Hono();

  // Phase 5d LOW-4: gate the body size BEFORE c.req.json() allocates it.
  // Without this, a misbehaving client uploading a 200MB payload would
  // pull the whole thing into memory before the schema cap can reject it.
  router.post(
    "/",
    bodyLimit({
      maxSize: CHAT_BODY_LIMIT,
      onError: (c) =>
        c.json(
          { error: "Request body too large", limit: CHAT_BODY_LIMIT },
          413,
        ),
    }),
    async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const result = chatSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
    }

    const {
      projectId,
      message,
      sessionId: incomingSessionId,
      annotations,
      annotatedFrame,
    } = result.data;

    // Read identity from header during B1 migration. Auth middleware will
    // replace this in a later phase (B1.b+). Missing userId is accepted for
    // backward compatibility with existing tests and unauthenticated dev mode.
    const userId = c.req.header("x-user-id") || undefined;

    let session;
    let isNewSession = false;
    if (incomingSessionId) {
      session = sessionManager.getSession(incomingSessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
      if (session.projectId !== projectId) {
        return c.json({ error: "Session does not belong to this project" }, 403);
      }
      // Reject cross-tenant session access once both session and request carry userId.
      if (session.userId && userId && session.userId !== userId) {
        return c.json({ error: "Session does not belong to this user" }, 403);
      }
    } else {
      session = sessionManager.createSession({ projectId, userId });
      isNewSession = true;
    }

    const identity: RequestIdentity = {
      userId: session.userId ?? userId,
      sessionId: session.sessionId,
      projectId,
    };

    eventBus?.emit({
      type: isNewSession ? "session.created" : "session.resumed",
      timestamp: Date.now(),
      sessionId: session.sessionId,
      data: { projectId },
    });

    // If no handler is wired, return processing (test/stub mode)
    if (!messageHandler) {
      sessionManager.appendMessage(session.sessionId, {
        role: "user",
        content: message,
        timestamp: Date.now(),
      });
      return c.json({ status: "processing", sessionId: session.sessionId });
    }

    // Execute through the agent and record the response
    // Append messages AFTER handler completes to avoid history duplication
    // (handler reads history, then runtime adds current message)
    try {
      const response = await messageHandler(
        message,
        session.sessionId,
        identity,
        annotations,
        annotatedFrame,
      );

      sessionManager.appendMessage(session.sessionId, {
        role: "user",
        content: message,
        timestamp: Date.now(),
      });
      sessionManager.appendMessage(session.sessionId, {
        role: "assistant",
        content: response,
        timestamp: Date.now(),
      });

      return c.json({ status: "completed", sessionId: session.sessionId, response });
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      sessionManager.updateStatus(session.sessionId, "failed");
      return c.json({ status: "error", sessionId: session.sessionId, error: errorMsg }, 500);
    }
  });

  return router;
}

export { createChatRouter };
