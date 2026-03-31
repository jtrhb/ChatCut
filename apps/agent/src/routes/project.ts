import { Hono } from "hono";

const project = new Hono();

project.get("/:id", (c) => {
  const id = c.req.param("id");
  return c.json({ projectId: id, snapshotVersion: 0, timeline: null });
});

export { project };
