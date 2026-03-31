import { Hono } from "hono";
import { z } from "zod";

const changesetIdSchema = z.object({
  changesetId: z.string().min(1),
});

const changeset = new Hono();

changeset.post("/approve", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = changesetIdSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
  }

  return c.json({ status: "approved", changesetId: result.data.changesetId });
});

changeset.post("/reject", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = changesetIdSchema.safeParse(body);
  if (!result.success) {
    return c.json({ error: "Invalid request body", issues: result.error.issues }, 400);
  }

  return c.json({ status: "rejected", changesetId: result.data.changesetId });
});

changeset.get("/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ changesetId: id, status: "pending" });
});

export { changeset };
