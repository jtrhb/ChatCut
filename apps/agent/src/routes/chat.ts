import { Hono } from "hono";
import { z } from "zod";
import type { SessionManager } from "../session/session-manager.js";

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

const chat = new Hono();

chat.post("/", async (c) => {
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

  return c.json({ status: "processing", sessionId: "placeholder" });
});

function createChatRouter(deps: { sessionManager: SessionManager }): Hono {
  const { sessionManager } = deps;
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
    if (incomingSessionId) {
      session = sessionManager.getSession(incomingSessionId);
      if (!session) {
        return c.json({ error: "Session not found" }, 404);
      }
    } else {
      session = sessionManager.createSession({ projectId });
    }

    sessionManager.appendMessage(session.sessionId, {
      role: "user",
      content: message,
      timestamp: Date.now(),
    });

    return c.json({ status: "processing", sessionId: session.sessionId });
  });

  return router;
}

export { chat, createChatRouter };
