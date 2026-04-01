import { Hono } from "hono";
import { cors } from "hono/cors";
import { commands } from "./routes/commands.js";
import { project } from "./routes/project.js";
import { media } from "./routes/media.js";
import { changeset } from "./routes/changeset.js";
import { SessionStore } from "./session/session-store.js";
import { SessionManager } from "./session/session-manager.js";
import { TaskRegistry } from "./tasks/task-registry.js";
import { EventBus } from "./events/event-bus.js";
import { createChatRouter } from "./routes/chat.js";
import { createEventsRouter } from "./routes/events.js";
import { createStatusRouter } from "./routes/status.js";
import { SkillLoader } from "./skills/loader.js";
import type { SkillContract } from "./skills/types.js";

export function createApp(opts?: { skillContracts?: SkillContract[] }) {
  const app = new Hono();

  // Instantiate shared services
  const sessionStore = new SessionStore();
  const sessionManager = new SessionManager(sessionStore);
  const taskRegistry = new TaskRegistry();
  const eventBus = new EventBus();

  // Skill contracts can be injected or will be empty by default
  // Production usage: call SkillLoader.loadAllSkillContracts() before createApp()
  // and pass the result. The loader requires async I/O so it runs before app creation.
  const skillContracts = opts?.skillContracts ?? [];

  app.use("*", cors());
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Static routes (no DI needed)
  app.route("/commands", commands);
  app.route("/project", project);
  app.route("/media", media);
  app.route("/changeset", changeset);

  // DI-wired routes
  app.route("/chat", createChatRouter({ sessionManager }));
  app.route("/events", createEventsRouter({ eventBus }));
  app.route("/status", createStatusRouter({ sessionManager, taskRegistry }));

  return app;
}
