import { Hono } from "hono";

const status = new Hono();

status.get("/", (c) => {
  return c.json({ agentStatus: "idle", activeChangesets: 0 });
});

export { status };
