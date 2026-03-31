import { Hono } from "hono";
import { z } from "zod";

const commandSchema = z.object({
  type: z.string(),
  params: z.record(z.string(), z.unknown()),
  baseSnapshotVersion: z.number(),
});

const commands = new Hono();

commands.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = commandSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
  }

  return c.json({ success: true, snapshotVersion: 1 });
});

export { commands };
