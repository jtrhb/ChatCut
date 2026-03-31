import { Hono } from "hono";
import { cors } from "hono/cors";
import { commands } from "./routes/commands.js";
import { project } from "./routes/project.js";
import { events } from "./routes/events.js";
import { media } from "./routes/media.js";
import { status } from "./routes/status.js";

export function createApp() {
  const app = new Hono();

  app.use("*", cors());

  app.get("/health", (c) => c.json({ status: "ok" }));

  app.route("/commands", commands);
  app.route("/project", project);
  app.route("/events", events);
  app.route("/media", media);
  app.route("/status", status);

  return app;
}
