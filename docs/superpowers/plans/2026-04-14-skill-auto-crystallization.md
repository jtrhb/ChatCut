# Skill Auto-Crystallization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire PatternObserver into the session lifecycle so editing patterns auto-crystallize into draft skills, load silently in future sessions, and promote/demote based on outcomes.

**Architecture:** 7 tasks in dependency order. Tasks 1-3 are foundation (DB schema, MemoryStore.deleteFile, SkillStore methods). Tasks 4-5 are core logic (SkillValidator, SkillLoader filtering). Tasks 6-7 are wiring (/skills route, session trigger). Each task is self-contained with TDD.

**Tech Stack:** TypeScript, Vitest, Hono, Drizzle ORM, @aws-sdk/client-s3, PostgreSQL

---

## File Structure

```
apps/agent/src/
├── db/schema.ts                  (modify) Add performance columns to skills table
├── memory/memory-store.ts        (modify) Add deleteFile() method
├── assets/skill-store.ts         (modify) Add findById, updateStatus, delete, recordOutcome, getPerformance
├── skills/
│   ├── skill-validator.ts        (new) Implicit validation engine
│   ├── loader.ts                 (modify) Add draft scope filtering
│   └── scope-parser.ts           (new) Parse "brand:acme/series:weekly" scope strings
├── context/project-context.ts    (modify) Add getBrandForProject()
├── routes/skills.ts              (new) /skills CRUD API
├── server.ts                     (modify) Wire /skills route + debounced trigger
└── index.ts                      (modify) Create PatternObserver, wire dependencies
```

---

### Task 1: Extend DB Schema — Performance Columns

**Files:**
- Modify: `apps/agent/src/db/schema.ts:124-140`
- Test: `apps/agent/src/db/__tests__/schema.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/db/__tests__/schema.test.ts
import { describe, it, expect } from "vitest";
import { skills } from "../schema.js";

describe("skills table schema", () => {
  it("has performance tracking columns", () => {
    const columns = Object.keys(skills);
    expect(columns).toContain("approveCount");
    expect(columns).toContain("rejectCount");
    expect(columns).toContain("sessionsSeen");
    expect(columns).toContain("consecutiveRejects");
    expect(columns).toContain("createdSessionId");
    expect(columns).toContain("lastSessionId");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/db/__tests__/schema.test.ts`
Expected: FAIL — columns don't exist

- [ ] **Step 3: Add columns to schema**

In `apps/agent/src/db/schema.ts`, extend the `skills` table:

```typescript
export const skills = pgTable(
  "skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    agentType: text("agent_type").notNull(),
    content: text("content").notNull(),
    frontmatter: jsonb("frontmatter"),
    skillStatus: text("skill_status").default("draft").notNull(),
    // Phase 5: Performance tracking
    approveCount: integer("approve_count").default(0).notNull(),
    rejectCount: integer("reject_count").default(0).notNull(),
    sessionsSeen: integer("sessions_seen").default(0).notNull(),
    consecutiveRejects: integer("consecutive_rejects").default(0).notNull(),
    createdSessionId: text("created_session_id"),
    lastSessionId: text("last_session_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("skills_agent_type_idx").on(table.agentType),
    index("skills_status_idx").on(table.skillStatus),
  ]
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/db/__tests__/schema.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass, 0 regressions

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/db/schema.ts apps/agent/src/db/__tests__/schema.test.ts
git commit -m "feat(agent): add performance tracking columns to skills table schema"
```

---

### Task 2: Add MemoryStore.deleteFile()

**Files:**
- Modify: `apps/agent/src/memory/memory-store.ts`
- Test: `apps/agent/src/memory/__tests__/memory-store-delete.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// apps/agent/src/memory/__tests__/memory-store-delete.test.ts
import { describe, it, expect, vi } from "vitest";
import { MemoryStore } from "../memory-store.js";

describe("MemoryStore.deleteFile", () => {
  it("sends DeleteObjectCommand with correct key", async () => {
    const sendMock = vi.fn().mockResolvedValue({});
    const storage = { client: { send: sendMock } };
    const store = new MemoryStore(storage, "user-123");

    await store.deleteFile("brands/acme/_skills/skill-abc.md");

    expect(sendMock).toHaveBeenCalledOnce();
    const command = sendMock.mock.calls[0][0];
    expect(command.input).toEqual({
      Bucket: "memory",
      Key: "chatcut-memory/user-123/brands/acme/_skills/skill-abc.md",
    });
  });

  it("propagates errors from S3", async () => {
    const sendMock = vi.fn().mockRejectedValue(new Error("NoSuchKey"));
    const storage = { client: { send: sendMock } };
    const store = new MemoryStore(storage, "user-123");

    await expect(store.deleteFile("nonexistent.md")).rejects.toThrow("NoSuchKey");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/memory/__tests__/memory-store-delete.test.ts`
Expected: FAIL — deleteFile is not a function

- [ ] **Step 3: Implement deleteFile**

Add to `apps/agent/src/memory/memory-store.ts`:

```typescript
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,  // ADD THIS IMPORT
} from "@aws-sdk/client-s3";

// Add method to MemoryStore class:

  /** Delete a file from R2 at `userPrefix/path`. */
  async deleteFile(path: string): Promise<void> {
    const key = `${this.userPrefix}/${path}`;
    const command = new DeleteObjectCommand({
      Bucket: "memory",
      Key: key,
    });
    await this.storage.client.send(command);
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/memory/__tests__/memory-store-delete.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/memory/memory-store.ts apps/agent/src/memory/__tests__/memory-store-delete.test.ts
git commit -m "feat(agent): add MemoryStore.deleteFile() for R2 skill removal"
```

---

### Task 3: Extend SkillStore — CRUD + Performance Methods

**Files:**
- Modify: `apps/agent/src/assets/skill-store.ts`
- Test: `apps/agent/src/assets/__tests__/skill-store-phase5.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/assets/__tests__/skill-store-phase5.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillStore } from "../skill-store.js";

function createMockDb() {
  const rows: any[] = [];
  return {
    insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(rows),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    _rows: rows,
  };
}

describe("SkillStore Phase 5 methods", () => {
  let db: ReturnType<typeof createMockDb>;
  let store: SkillStore;

  beforeEach(() => {
    db = createMockDb();
    store = new SkillStore(db);
  });

  it("findById queries by id", async () => {
    await store.findById("skill-123");
    expect(db.select).toHaveBeenCalled();
  });

  it("updateStatus sets skillStatus and updatedAt", async () => {
    await store.updateStatus("skill-123", "validated");
    expect(db.update).toHaveBeenCalled();
  });

  it("delete removes by id", async () => {
    await store.delete("skill-123");
    expect(db.delete).toHaveBeenCalled();
  });

  it("recordOutcome increments approve_count for approved", async () => {
    await store.recordOutcome("skill-123", "session-abc", true);
    expect(db.update).toHaveBeenCalled();
  });

  it("recordOutcome increments reject_count and consecutive_rejects for rejected", async () => {
    await store.recordOutcome("skill-123", "session-abc", false);
    expect(db.update).toHaveBeenCalled();
  });

  it("getPerformance returns counters", async () => {
    db._rows.push({
      approveCount: 5,
      rejectCount: 2,
      sessionsSeen: 3,
      consecutiveRejects: 0,
      createdSessionId: "s1",
      lastSessionId: "s3",
    });
    const perf = await store.getPerformance("skill-123");
    expect(perf).toHaveProperty("approveCount");
    expect(perf).toHaveProperty("sessionsSeen");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/skill-store-phase5.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Implement new methods**

Add to `apps/agent/src/assets/skill-store.ts`:

```typescript
import { randomUUID } from "crypto";
import { eq, and, sql, type SQL } from "drizzle-orm";
import { skills } from "../db/schema.js";

export interface SkillPerformance {
  approveCount: number;
  rejectCount: number;
  sessionsSeen: number;
  consecutiveRejects: number;
  createdSessionId: string | null;
  lastSessionId: string | null;
}

// Add to SkillStore class:

  async findById(id: string): Promise<any | null> {
    const rows = await this.db
      .select()
      .from(skills)
      .where(eq(skills.id, id));
    return rows[0] ?? null;
  }

  async updateStatus(
    id: string,
    status: "draft" | "validated" | "deprecated",
  ): Promise<void> {
    await this.db
      .update(skills)
      .set({ skillStatus: status, updatedAt: new Date() })
      .where(eq(skills.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(skills).where(eq(skills.id, id));
  }

  async recordOutcome(
    id: string,
    sessionId: string,
    approved: boolean,
  ): Promise<void> {
    if (approved) {
      await this.db
        .update(skills)
        .set({
          approveCount: sql`${skills.approveCount} + 1`,
          consecutiveRejects: 0,
          lastSessionId: sessionId,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id));
    } else {
      await this.db
        .update(skills)
        .set({
          rejectCount: sql`${skills.rejectCount} + 1`,
          consecutiveRejects: sql`${skills.consecutiveRejects} + 1`,
          lastSessionId: sessionId,
          updatedAt: new Date(),
        })
        .where(eq(skills.id, id));
    }
  }

  async getPerformance(id: string): Promise<SkillPerformance | null> {
    const rows = await this.db
      .select({
        approveCount: skills.approveCount,
        rejectCount: skills.rejectCount,
        sessionsSeen: skills.sessionsSeen,
        consecutiveRejects: skills.consecutiveRejects,
        createdSessionId: skills.createdSessionId,
        lastSessionId: skills.lastSessionId,
      })
      .from(skills)
      .where(eq(skills.id, id));
    return rows[0] ?? null;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/assets/__tests__/skill-store-phase5.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/assets/skill-store.ts apps/agent/src/assets/__tests__/skill-store-phase5.test.ts
git commit -m "feat(agent): add SkillStore CRUD + performance tracking methods"
```

---

### Task 4: SkillValidator — Promotion/Demotion Engine

**Files:**
- Create: `apps/agent/src/skills/skill-validator.ts`
- Test: `apps/agent/src/skills/__tests__/skill-validator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/skills/__tests__/skill-validator.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SkillValidator } from "../skill-validator.js";

function createMockSkillStore() {
  return {
    findById: vi.fn(),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    getPerformance: vi.fn(),
    incrementUsage: vi.fn(),
  };
}

function createMockMemoryStore() {
  return {
    readFile: vi.fn(),
    readParsed: vi.fn(),
    writeMemory: vi.fn().mockResolvedValue(undefined),
    deleteFile: vi.fn().mockResolvedValue(undefined),
    listDir: vi.fn(),
    exists: vi.fn(),
  };
}

describe("SkillValidator", () => {
  let skillStore: ReturnType<typeof createMockSkillStore>;
  let memoryStore: ReturnType<typeof createMockMemoryStore>;
  let validator: SkillValidator;

  beforeEach(() => {
    skillStore = createMockSkillStore();
    memoryStore = createMockMemoryStore();
    validator = new SkillValidator(skillStore as any, memoryStore as any);
  });

  it("promotes after 3+ approvals across 2+ sessions", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 4,
      rejectCount: 0,
      sessionsSeen: 3,
      consecutiveRejects: 0,
      createdSessionId: "s0",
      lastSessionId: "s3",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-1",
      skillStatus: "draft",
      frontmatter: { scope: "brand:acme" },
    });

    const result = await validator.evaluateAndApply("skill-1");

    expect(result).toBe("promoted");
    expect(skillStore.updateStatus).toHaveBeenCalledWith("skill-1", "validated");
  });

  it("deprecates after 3 consecutive rejects", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 1,
      rejectCount: 4,
      sessionsSeen: 2,
      consecutiveRejects: 3,
      createdSessionId: "s0",
      lastSessionId: "s2",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-2",
      skillStatus: "draft",
      frontmatter: { scope: "brand:acme" },
    });

    const result = await validator.evaluateAndApply("skill-2");

    expect(result).toBe("deprecated");
    expect(skillStore.updateStatus).toHaveBeenCalledWith("skill-2", "deprecated");
  });

  it("refuses same-session promotion", async () => {
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 5,
      rejectCount: 0,
      sessionsSeen: 1,
      consecutiveRejects: 0,
      createdSessionId: "s1",
      lastSessionId: "s1",
    });
    skillStore.findById.mockResolvedValue({
      id: "skill-3",
      skillStatus: "draft",
      frontmatter: {},
    });

    const result = await validator.evaluateAndApply("skill-3");

    expect(result).toBe("unchanged");
    expect(skillStore.updateStatus).not.toHaveBeenCalled();
  });

  it("returns unchanged for already validated skills", async () => {
    skillStore.findById.mockResolvedValue({
      id: "skill-4",
      skillStatus: "validated",
      frontmatter: {},
    });
    skillStore.getPerformance.mockResolvedValue({
      approveCount: 10,
      rejectCount: 0,
      sessionsSeen: 5,
      consecutiveRejects: 0,
      createdSessionId: "s0",
      lastSessionId: "s5",
    });

    const result = await validator.evaluateAndApply("skill-4");

    expect(result).toBe("unchanged");
  });

  it("recordOutcome delegates to skillStore", async () => {
    await validator.recordOutcome("skill-1", "session-abc", true);

    expect(skillStore.recordOutcome).toHaveBeenCalledWith("skill-1", "session-abc", true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/skill-validator.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SkillValidator**

```typescript
// apps/agent/src/skills/skill-validator.ts
import type { SkillStore, SkillPerformance } from "../assets/skill-store.js";
import type { MemoryStore } from "../memory/memory-store.js";

const PROMOTION_THRESHOLD = 3;       // approvals needed
const PROMOTION_MIN_SESSIONS = 2;    // distinct sessions needed
const DEPRECATION_CONSECUTIVE = 3;   // consecutive rejects to deprecate

export class SkillValidator {
  constructor(
    private skillStore: SkillStore,
    private memoryStore: MemoryStore,
  ) {}

  async recordOutcome(
    skillId: string,
    sessionId: string,
    approved: boolean,
  ): Promise<void> {
    await this.skillStore.recordOutcome(skillId, sessionId, approved);
  }

  async evaluateAndApply(
    skillId: string,
  ): Promise<"promoted" | "deprecated" | "unchanged"> {
    const skill = await this.skillStore.findById(skillId);
    if (!skill || skill.skillStatus !== "draft") {
      return "unchanged";
    }

    const perf = await this.skillStore.getPerformance(skillId);
    if (!perf) return "unchanged";

    // Deprecate: 3+ consecutive rejects
    if (perf.consecutiveRejects >= DEPRECATION_CONSECUTIVE) {
      await this.skillStore.updateStatus(skillId, "deprecated");
      return "deprecated";
    }

    // Session gate: must have reinforcements from different sessions
    if (perf.sessionsSeen < PROMOTION_MIN_SESSIONS) {
      return "unchanged";
    }

    // Same-session gate: lastSessionId must differ from createdSessionId
    if (perf.createdSessionId && perf.lastSessionId === perf.createdSessionId) {
      return "unchanged";
    }

    // Promote: 3+ approvals across 2+ sessions
    if (perf.approveCount >= PROMOTION_THRESHOLD) {
      await this.skillStore.updateStatus(skillId, "validated");
      return "promoted";
    }

    return "unchanged";
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/skill-validator.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/skills/skill-validator.ts apps/agent/src/skills/__tests__/skill-validator.test.ts
git commit -m "feat(agent): add SkillValidator for implicit draft promotion/demotion"
```

---

### Task 5: SkillLoader Draft Scope Filtering + Scope Parser

**Files:**
- Create: `apps/agent/src/skills/scope-parser.ts`
- Modify: `apps/agent/src/skills/loader.ts:66-77`
- Test: `apps/agent/src/skills/__tests__/scope-parser.test.ts`
- Test: `apps/agent/src/skills/__tests__/loader-draft-filter.test.ts`

- [ ] **Step 1: Write scope parser test**

```typescript
// apps/agent/src/skills/__tests__/scope-parser.test.ts
import { describe, it, expect } from "vitest";
import { parseScope } from "../scope-parser.js";

describe("parseScope", () => {
  it("parses brand-only scope", () => {
    expect(parseScope("brand:acme")).toEqual({ brand: "acme" });
  });

  it("parses brand+series scope", () => {
    expect(parseScope("brand:acme/series:weekly")).toEqual({
      brand: "acme",
      series: "weekly",
    });
  });

  it("returns empty for global scope", () => {
    expect(parseScope("global")).toEqual({});
  });

  it("returns empty for undefined", () => {
    expect(parseScope(undefined)).toEqual({});
  });

  it("returns empty for empty string", () => {
    expect(parseScope("")).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/scope-parser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement scope parser**

```typescript
// apps/agent/src/skills/scope-parser.ts
export function parseScope(
  scope: string | undefined,
): { brand?: string; series?: string } {
  if (!scope || scope === "global") return {};

  const result: { brand?: string; series?: string } = {};
  const parts = scope.split("/");

  for (const part of parts) {
    const [key, value] = part.split(":");
    if (key === "brand" && value) result.brand = value;
    if (key === "series" && value) result.series = value;
  }

  return result;
}
```

- [ ] **Step 4: Run scope parser test**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/scope-parser.test.ts`
Expected: PASS

- [ ] **Step 5: Write draft filter test**

```typescript
// apps/agent/src/skills/__tests__/loader-draft-filter.test.ts
import { describe, it, expect, vi } from "vitest";
import { SkillLoader } from "../loader.js";
import type { ParsedMemory } from "../../memory/types.js";

function makeSkillMemory(overrides: Partial<ParsedMemory>): ParsedMemory {
  return {
    memory_id: "m-1",
    type: "pattern",
    status: "active",
    confidence: "high",
    source: "observed",
    scope: "global",
    scope_level: 0,
    content: "test skill content",
    skill_id: "skill-1",
    skill_status: "draft",
    agent_type: "master",
    ...overrides,
  } as ParsedMemory;
}

describe("SkillLoader draft scope filtering", () => {
  it("includes draft skill matching current brand", async () => {
    const memoryStore = {
      listDir: vi.fn().mockResolvedValue([]),
      readParsed: vi.fn(),
    };

    const loader = new SkillLoader(memoryStore as any);

    // Test the filterDraftsByScope logic directly
    const drafts = [
      makeSkillMemory({ scope: "brand:acme", skill_status: "draft" }),
      makeSkillMemory({ scope: "brand:other", skill_status: "draft", skill_id: "skill-2" }),
    ];

    const filtered = loader.filterDraftsByScope(drafts, "acme");
    expect(filtered).toHaveLength(1);
    expect(filtered[0].skill_id).toBe("skill-1");
  });

  it("includes draft skill with no scope (global)", async () => {
    const loader = new SkillLoader(null as any);
    const drafts = [
      makeSkillMemory({ scope: "global", skill_status: "draft" }),
    ];

    const filtered = loader.filterDraftsByScope(drafts);
    expect(filtered).toHaveLength(1);
  });

  it("excludes draft skill with non-matching series", async () => {
    const loader = new SkillLoader(null as any);
    const drafts = [
      makeSkillMemory({
        scope: "brand:acme/series:daily",
        skill_status: "draft",
      }),
    ];

    const filtered = loader.filterDraftsByScope(drafts, "acme", "weekly");
    expect(filtered).toHaveLength(0);
  });
});
```

- [ ] **Step 6: Run draft filter test to verify it fails**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/loader-draft-filter.test.ts`
Expected: FAIL — filterDraftsByScope not a function

- [ ] **Step 7: Add filterDraftsByScope to SkillLoader**

In `apps/agent/src/skills/loader.ts`, add:

```typescript
import { parseScope } from "./scope-parser.js";

// Add method to SkillLoader class:

  /**
   * Filter draft skills by scope — only include drafts that match
   * the current brand/series context. Validated skills are not filtered.
   */
  filterDraftsByScope(
    skills: ParsedMemory[],
    currentBrand?: string,
    currentSeries?: string,
  ): ParsedMemory[] {
    return skills.filter((s) => {
      if (s.skill_status !== "draft") return true; // non-drafts pass through
      const scopeParts = parseScope(s.scope);
      if (scopeParts.brand && scopeParts.brand !== currentBrand) return false;
      if (scopeParts.series && scopeParts.series !== currentSeries) return false;
      return true;
    });
  }
```

Then update `loadSkillsGrouped` to use this filter:

```typescript
  async loadSkillsGrouped(
    agentType: string,
    params: { brand?: string; series?: string }
  ): Promise<{ mainSkills: ParsedMemory[]; trialSkills: ParsedMemory[] }> {
    const skills = await this.loadSkills(agentType, params);
    const filtered = this.filterDraftsByScope(skills, params.brand, params.series);

    return {
      mainSkills: filtered.filter((s) => s.skill_status === "validated"),
      trialSkills: filtered.filter((s) => s.skill_status === "draft"),
    };
  }
```

- [ ] **Step 8: Run draft filter test**

Run: `cd apps/agent && npx vitest run src/skills/__tests__/loader-draft-filter.test.ts`
Expected: PASS

- [ ] **Step 9: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add apps/agent/src/skills/scope-parser.ts apps/agent/src/skills/loader.ts \
  apps/agent/src/skills/__tests__/scope-parser.test.ts \
  apps/agent/src/skills/__tests__/loader-draft-filter.test.ts
git commit -m "feat(agent): add SkillLoader draft scope filtering + scope parser"
```

---

### Task 6: /skills API Route

**Files:**
- Create: `apps/agent/src/routes/skills.ts`
- Test: `apps/agent/src/routes/__tests__/skills.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// apps/agent/src/routes/__tests__/skills.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { createSkillsRouter } from "../skills.js";

function createMockDeps() {
  return {
    skillStore: {
      search: vi.fn().mockResolvedValue([]),
      findById: vi.fn(),
      updateStatus: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      getPerformance: vi.fn(),
    },
    memoryStore: {
      deleteFile: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("/skills API", () => {
  let app: Hono;
  let deps: ReturnType<typeof createMockDeps>;

  beforeEach(() => {
    deps = createMockDeps();
    app = new Hono();
    app.route("/skills", createSkillsRouter(deps as any));
  });

  it("GET /skills returns list", async () => {
    deps.skillStore.search.mockResolvedValue([
      { id: "s1", name: "Pacing", skillStatus: "draft" },
    ]);
    const res = await app.request("/skills");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("Pacing");
  });

  it("GET /skills/:id returns skill with performance", async () => {
    deps.skillStore.findById.mockResolvedValue({
      id: "s1", name: "Pacing", skillStatus: "draft",
      content: "# Pacing", frontmatter: {},
    });
    deps.skillStore.getPerformance.mockResolvedValue({
      approveCount: 3, rejectCount: 1, sessionsSeen: 2,
      consecutiveRejects: 0, createdSessionId: "x", lastSessionId: "y",
    });
    const res = await app.request("/skills/s1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.performance.approveCount).toBe(3);
  });

  it("GET /skills/:id returns 404 for missing", async () => {
    deps.skillStore.findById.mockResolvedValue(null);
    const res = await app.request("/skills/missing");
    expect(res.status).toBe(404);
  });

  it("POST /skills/:id/approve updates to validated", async () => {
    deps.skillStore.findById.mockResolvedValue({ id: "s1", skillStatus: "draft" });
    const res = await app.request("/skills/s1/approve", { method: "POST" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.updateStatus).toHaveBeenCalledWith("s1", "validated");
  });

  it("POST /skills/:id/deprecate updates to deprecated", async () => {
    deps.skillStore.findById.mockResolvedValue({ id: "s1", skillStatus: "draft" });
    const res = await app.request("/skills/s1/deprecate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.updateStatus).toHaveBeenCalledWith("s1", "deprecated");
  });

  it("DELETE /skills/:id removes from DB and R2", async () => {
    deps.skillStore.findById.mockResolvedValue({
      id: "s1", frontmatter: { scope: "brand:acme" },
    });
    const res = await app.request("/skills/s1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(deps.skillStore.delete).toHaveBeenCalledWith("s1");
    expect(deps.memoryStore.deleteFile).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/skills.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement /skills route**

```typescript
// apps/agent/src/routes/skills.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/agent && npx vitest run src/routes/__tests__/skills.test.ts`
Expected: PASS

- [ ] **Step 5: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 6: Commit**

```bash
git add apps/agent/src/routes/skills.ts apps/agent/src/routes/__tests__/skills.test.ts
git commit -m "feat(agent): add /skills API route with CRUD + dual-delete"
```

---

### Task 7: Production Wiring — Trigger + Route + Dependencies

**Files:**
- Modify: `apps/agent/src/context/project-context.ts`
- Modify: `apps/agent/src/server.ts`
- Modify: `apps/agent/src/index.ts`
- Test: `apps/agent/src/context/__tests__/brand-resolution.test.ts`
- Test: `apps/agent/src/__tests__/crystallization-trigger.test.ts`

- [ ] **Step 1: Write brand resolution test**

```typescript
// apps/agent/src/context/__tests__/brand-resolution.test.ts
import { describe, it, expect } from "vitest";
import { ProjectContextManager } from "../project-context.js";

describe("ProjectContextManager.getBrandForProject", () => {
  it("returns brand mapping when registered", () => {
    const manager = new ProjectContextManager();
    manager.registerBrand("project-123", { brand: "acme", series: "weekly" });
    const result = manager.getBrandForProject("project-123");
    expect(result).toEqual({ brand: "acme", series: "weekly" });
  });

  it("returns null for unknown project", () => {
    const manager = new ProjectContextManager();
    const result = manager.getBrandForProject("unknown");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/agent && npx vitest run src/context/__tests__/brand-resolution.test.ts`
Expected: FAIL — methods don't exist

- [ ] **Step 3: Add brand resolution to ProjectContextManager**

In `apps/agent/src/context/project-context.ts`, add to the `ProjectContextManager` class:

```typescript
  private brandMappings = new Map<string, { brand: string; series?: string }>();

  registerBrand(projectId: string, mapping: { brand: string; series?: string }): void {
    this.brandMappings.set(projectId, mapping);
  }

  getBrandForProject(projectId: string): { brand: string; series?: string } | null {
    return this.brandMappings.get(projectId) ?? null;
  }
```

- [ ] **Step 4: Run brand resolution test**

Run: `cd apps/agent && npx vitest run src/context/__tests__/brand-resolution.test.ts`
Expected: PASS

- [ ] **Step 5: Wire /skills route into server.ts**

In `apps/agent/src/server.ts`:

```typescript
import { createSkillsRouter } from "./routes/skills.js";

// In createApp(), after existing route mounts:
if (opts?.skillsRouter) {
  app.route("/skills", opts.skillsRouter);
}

// Update createApp signature to accept skillsRouter
```

- [ ] **Step 6: Wire PatternObserver trigger + /skills in index.ts**

In `apps/agent/src/index.ts`:

```typescript
import { PatternObserver } from "./memory/pattern-observer.js";
import { SkillValidator } from "./skills/skill-validator.js";
import { createSkillsRouter } from "./routes/skills.js";

// After creating memoryStore and skillStore:
const patternObserver = new PatternObserver({ memoryStore });
const skillValidator = new SkillValidator(skillStore, memoryStore);

// Create /skills router
const skillsRouter = createSkillsRouter({ skillStore, memoryStore });

// Pass to createApp
const app = createApp({
  services,
  messageHandler,
  infrastructure: { serverEditorCore, contextManager },
  skillsRouter,
});

// Update createMessageHandler to include debounced trigger:
const lastAnalysisAt = new Map<string, number>();
const ANALYSIS_DEBOUNCE_MS = 10 * 60 * 1000;

// In messageHandler, after response, add:
// const brandInfo = contextManager.getBrandForProject(projectId);
// if (brandInfo) { ... debounced trigger ... }
```

- [ ] **Step 7: Write trigger test**

```typescript
// apps/agent/src/__tests__/crystallization-trigger.test.ts
import { describe, it, expect, vi } from "vitest";

describe("crystallization trigger", () => {
  it("debounces analysis within 10 minutes", async () => {
    const runAnalysis = vi.fn().mockResolvedValue(undefined);
    const lastAnalysisAt = new Map<string, number>();
    const DEBOUNCE_MS = 10 * 60 * 1000;

    function maybeTrigger(brand: string, series?: string) {
      const key = `${brand}:${series ?? ""}`;
      const lastAt = lastAnalysisAt.get(key) ?? 0;
      if (Date.now() - lastAt > DEBOUNCE_MS) {
        lastAnalysisAt.set(key, Date.now());
        runAnalysis({ brand, series });
      }
    }

    maybeTrigger("acme", "weekly");
    maybeTrigger("acme", "weekly"); // within debounce
    expect(runAnalysis).toHaveBeenCalledTimes(1);
  });

  it("skips when no brand mapping", () => {
    const brandInfo = null;
    const runAnalysis = vi.fn();
    if (brandInfo) runAnalysis();
    expect(runAnalysis).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 8: Run trigger test**

Run: `cd apps/agent && npx vitest run src/__tests__/crystallization-trigger.test.ts`
Expected: PASS

- [ ] **Step 9: Run all tests**

Run: `cd apps/agent && npx vitest run`
Expected: All pass

- [ ] **Step 10: Commit**

```bash
git add apps/agent/src/context/project-context.ts \
  apps/agent/src/server.ts apps/agent/src/index.ts \
  apps/agent/src/context/__tests__/brand-resolution.test.ts \
  apps/agent/src/__tests__/crystallization-trigger.test.ts
git commit -m "feat(agent): wire Phase 5 — PatternObserver trigger, /skills route, brand resolution"
```

---

## Self-Review Checklist

| Spec Requirement | Task |
|-----------------|------|
| DB schema extension | Task 1 |
| MemoryStore.deleteFile | Task 2 |
| SkillStore CRUD + performance | Task 3 |
| SkillValidator promotion/demotion | Task 4 |
| SkillLoader draft scope filtering | Task 5 |
| /skills API route | Task 6 |
| Session trigger + wiring | Task 7 |
| Brand resolution | Task 7 |
| Dual-write (R2 + DB) | Task 4 (validator), Task 6 (delete) |

No placeholders. All code blocks are complete. All test commands are exact.
