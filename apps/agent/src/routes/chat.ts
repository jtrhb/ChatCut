import { Hono } from "hono";
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
 * Message handler function — decouples routing from agent execution.
 * In production, this wraps MasterAgent.handleUserMessage().
 * `identity` is optional during B1 migration; handlers wired after B1.b
 * may rely on it for tenant-scoped execution.
 */
export type MessageHandler = (
  message: string,
  sessionId: string,
  identity?: RequestIdentity,
) => Promise<string>;

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

function createChatRouter(deps: {
  sessionManager: SessionManager;
  eventBus?: EventBus;
  messageHandler?: MessageHandler;
}): Hono {
  const { sessionManager, eventBus, messageHandler } = deps;
  const router = new Hono();

  router.post("/", async (c) => {
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

    const { projectId, message, sessionId: incomingSessionId } = result.data;

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
      const response = await messageHandler(message, session.sessionId, identity);

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
