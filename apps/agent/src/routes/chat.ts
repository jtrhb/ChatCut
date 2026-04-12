import { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../session/session-manager.js";
import type { EventBus } from "../events/event-bus.js";

/**
 * Message handler function — decouples routing from agent execution.
 * In production, this wraps MasterAgent.handleUserMessage().
 */
export type MessageHandler = (message: string, sessionId: string) => Promise<string>;

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
    } else {
      session = sessionManager.createSession({ projectId });
      isNewSession = true;
    }

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
      const response = await messageHandler(message, session.sessionId);

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
