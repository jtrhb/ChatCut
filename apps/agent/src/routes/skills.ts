import { Hono } from "hono";
import type { SkillStore } from "../assets/skill-store.js";
import type { MemoryStore } from "../memory/memory-store.js";

export function createSkillsRouter(deps: {
  skillStore: SkillStore;
  memoryStore: MemoryStore;
}): Hono {
  const { skillStore, memoryStore } = deps;
  const router = new Hono();

  // GET /skills — list with optional filters
  router.get("/", async (c) => {
    const status = c.req.query("status");
    const scope = c.req.query("scope");
    const filters: Record<string, string> = {};
    if (status) filters.skillStatus = status;
    if (scope) filters.scopeLevel = scope;
    const skills = await skillStore.search({ userId: "default", ...filters });
    return c.json(skills);
  });

  // GET /skills/:id — detail with performance
  router.get("/:id", async (c) => {
    const skill = await skillStore.findById(c.req.param("id"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    const performance = await skillStore.getPerformance(skill.id);
    return c.json({ ...skill, performance });
  });

  // POST /skills/:id/approve
  router.post("/:id/approve", async (c) => {
    const skill = await skillStore.findById(c.req.param("id"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    await skillStore.updateStatus(skill.id, "validated");
    return c.json({ status: "validated", skillId: skill.id });
  });

  // POST /skills/:id/deprecate
  router.post("/:id/deprecate", async (c) => {
    const skill = await skillStore.findById(c.req.param("id"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);
    await skillStore.updateStatus(skill.id, "deprecated");
    return c.json({ status: "deprecated", skillId: skill.id });
  });

  // DELETE /skills/:id — dual-delete from DB + R2
  router.delete("/:id", async (c) => {
    const skill = await skillStore.findById(c.req.param("id"));
    if (!skill) return c.json({ error: "Skill not found" }, 404);

    // Delete from DB
    await skillStore.delete(skill.id);

    // Delete from R2 — resolve path from scope + id
    const scope = (skill.frontmatter as Record<string, string>)?.scope ?? "global";
    const r2Path = scope === "global"
      ? `global/_skills/skill-${skill.id}.md`
      : `${scope.replace(":", "/")}/_skills/skill-${skill.id}.md`;
    try {
      await memoryStore.deleteFile(r2Path);
    } catch {
      // R2 file may not exist (manually created skills) — non-fatal
    }

    return c.json({ deleted: true, skillId: skill.id });
  });

  return router;
}
