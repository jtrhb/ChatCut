import { Hono } from "hono";
import { z } from "zod";

const chatSchema = z.object({
  projectId: z.string().uuid(),
  message: z.string().min(1),
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

export { chat };
