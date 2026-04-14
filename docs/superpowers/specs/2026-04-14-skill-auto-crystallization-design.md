# Skill Auto-Crystallization Design Spec

## Overview

Wire the existing PatternObserver into the agent session lifecycle to enable automatic skill crystallization — the system detects repeated editing patterns from accumulated memories, generates draft skills, silently injects them into future sessions, and promotes/demotes them based on observed outcomes.

## Architecture

```
Session End (debounced post-response trigger)
    ↓ async, non-blocking
PatternObserver.runAnalysis({ brand, series? })
    ↓ 5+ high-confidence memories, 2+ shared tags
crystallizeSkill() → R2 write draft skill .md (via existing MemoryStore)
    ↓
Next Session Start
    ↓
SkillLoader loads draft skills (+ new activation_scope filter)
    ↓
Injected into system prompt (user unaware)
    ↓
Session behavior observed
    ↓ MemoryExtractor monitors approve/reject
SkillValidator evaluates performance (persisted to DB)
    ↓
approve rate up → "validated" | reject rate up → "deprecated"
```

## Components

### 1. Session End Trigger

**Location**: `apps/agent/src/server.ts` — `createMessageHandler()`

**Mechanism**: After each successful handler response, debounced trigger runs PatternObserver analysis asynchronously. NOT a true session-end detector — just a debounced post-response hook.

```ts
// In createMessageHandler deps, add:
patternObserver?: PatternObserver;
lastAnalysisAt?: Map<string, number>;

// After successful response, debounced trigger:
const ANALYSIS_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const scopeKey = `${brand}:${series ?? ""}`;
const lastAt = lastAnalysisAt.get(scopeKey) ?? 0;
if (Date.now() - lastAt > ANALYSIS_DEBOUNCE_MS) {
  lastAnalysisAt.set(scopeKey, Date.now());
  queueMicrotask(() => {
    patternObserver.runAnalysis({ brand, series }).catch(console.error);
  });
}
```

**Brand resolution**: Session has `projectId`. Need a `ProjectContextManager.getBrandForProject(projectId): { brand: string; series?: string }` method. If no brand mapping exists, skip analysis (no-op).

**Non-blocking**: Analysis runs after response is sent. Errors are logged, never propagated to user.

### 2. R2 Write Layer

**Uses existing `MemoryStore` class** at `apps/agent/src/memory/memory-store.ts`.

PatternObserver already accepts `MemoryStore` via constructor DI (line 34) and calls `this.memoryStore.writeMemory()` for crystallization. **No refactoring needed.**

**Missing method**: Add `deleteFile(path: string): Promise<void>` to existing `MemoryStore` class using `DeleteObjectCommand` from `@aws-sdk/client-s3` (already installed at `^3.800.0`).

**Skill write path**: `brands/{brandId}/_skills/skill-{skillId}.md`

**Local dev**: When `R2_ENDPOINT` env var is not set, `MemoryStore` can use a `LocalMemoryStore` adapter backed by `{projectRoot}/.local-memory/`. Implement as a constructor option on the existing class.

### 3. Draft Skill Auto-Loading

**Location**: `apps/agent/src/skills/loader.ts`

SkillLoader reads from R2 `_skills/` paths at three scope levels (global → brand → series). It already filters `skill_status !== "deprecated"`.

**Change needed**: Add draft skill scope filtering. Currently SkillLoader does NOT gate drafts by scope — all drafts are loaded regardless of context.

Note: `activation_scope` on `ParsedMemory` has fields `{project_id?, batch_id?, session_id?}` — no `brand/series`. For draft skill filtering, use the skill's `scope` field (`"brand:acme"`, `"brand:acme/series:weekly"`) which IS brand-aware, rather than `activation_scope`.

```ts
// In SkillLoader, after loading and filtering by status:
if (memory.skill_status === "draft" && memory.scope) {
  // Parse scope string: "brand:acme" or "brand:acme/series:weekly"
  const scopeParts = parseScope(memory.scope); // { brand?: string; series?: string }
  if (scopeParts.brand && scopeParts.brand !== currentBrand) continue;
  if (scopeParts.series && scopeParts.series !== currentSeries) continue;
}
```

This requires SkillLoader to receive current brand/series context. Add `brand?: string; series?: string` to the load options.

### 4. SkillValidator — Implicit Validation Engine

**Location**: `apps/agent/src/skills/skill-validator.ts` (new)

**Purpose**: Track draft skill performance across sessions and auto-promote/demote.

**Persistence**: Use PostgreSQL `skills` table — extend with performance counters rather than in-memory Map. This survives server restarts.

**Schema migration** — add columns to `skills` table:
```sql
ALTER TABLE skills ADD COLUMN approve_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN reject_count INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN sessions_seen INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN consecutive_rejects INTEGER DEFAULT 0;
ALTER TABLE skills ADD COLUMN created_session_id TEXT;
ALTER TABLE skills ADD COLUMN last_session_id TEXT;
```
In Drizzle ORM, add corresponding fields to `apps/agent/src/db/schema.ts` skills table definition.

```ts
// Extend SkillStore with new methods:
export class SkillStore {
  // Existing:
  save(skill): Promise<void>;
  search(filters): Promise<Skill[]>;
  incrementUsage(id): Promise<void>;
  
  // New for Phase 5:
  findById(id: string): Promise<Skill | null>;
  updateStatus(id: string, status: "draft" | "validated" | "deprecated"): Promise<void>;
  delete(id: string): Promise<void>;
  recordOutcome(id: string, sessionId: string, approved: boolean): Promise<void>;
  getPerformance(id: string): Promise<SkillPerformance>;
}
```

```ts
export class SkillValidator {
  constructor(private skillStore: SkillStore, private memoryStore: MemoryStore) {}
  
  // Called by MemoryExtractor on approve/reject
  async recordOutcome(skillId: string, sessionId: string, approved: boolean): Promise<void>;
  
  // Check and apply promotion/demotion
  async evaluateAndApply(skillId: string): Promise<"promoted" | "deprecated" | "unchanged">;
}
```

**Promotion rules**:
- `promoted to "validated"`: 3+ positive reinforcements across 2+ distinct sessions
- `deprecated`: 3 consecutive rejects of the skill's associated operation type in any session
- **Session gate**: Cannot promote within the same session that created the draft

**Dual-write**: When status changes, update both R2 (skill .md frontmatter) and PostgreSQL (`skills.skillStatus`).

**Active skill tracking**: SkillLoader returns loaded draft skill IDs. Pass these to `createMessageHandler` so MemoryExtractor can correlate approve/reject events with active draft skills.

### 5. /skills API Route

**Location**: `apps/agent/src/routes/skills.ts` (new)

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| GET | /skills | List skills. Query params: `?status=draft&scope=brand:acme` |
| GET | /skills/:id | Get skill detail (content + frontmatter + performance stats) |
| POST | /skills/:id/approve | Manual promote: draft → validated |
| POST | /skills/:id/deprecate | Manual demote: any → deprecated |
| DELETE | /skills/:id | Delete skill: `SkillStore.delete(id)` (DB) + `MemoryStore.deleteFile(skill.r2Path)` (R2). R2 path resolved from DB record's scope + skillId. |

**Response shape**:
```ts
{
  skillId: string;
  name: string;
  status: "draft" | "validated" | "deprecated";
  scope: string;
  createdAt: string;
  performance?: {
    sessionsSeen: number;
    approveRate: number;
    rejectRate: number;
  };
  content: string;
  frontmatter: Record<string, unknown>;
}
```

**Wire into**: `apps/agent/src/server.ts` and `apps/agent/src/index.ts`.

## Dependencies

| Dependency | Status | Action |
|-----------|--------|--------|
| PatternObserver | Implemented (already uses MemoryStore DI) | Wire into session trigger in server.ts |
| SkillLoader | Implemented | Add activation_scope filtering + brand/series context |
| MemoryExtractor | Implemented | Add SkillValidator hook for approve/reject |
| SkillStore (DB) | Implemented (save/search/incrementUsage) | Add findById, updateStatus, delete, recordOutcome, getPerformance |
| MemoryStore (R2) | Implemented | Add deleteFile() method |
| R2 bucket | Available (user has admin) | Create bucket, configure env vars |
| @aws-sdk/client-s3 | Installed (^3.800.0) | No action needed |
| ProjectContextManager | Implemented | Add getBrandForProject() method |

## Environment Variables

```
R2_ACCOUNT_ID=<cloudflare account>
R2_ACCESS_KEY_ID=<r2 access key>
R2_SECRET_ACCESS_KEY=<r2 secret>
R2_BUCKET_NAME=opencut-memory
R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
```

## Acceptance Tests

### Unit Tests
1. SkillValidator promotes draft after 3+ reinforcements across 2+ sessions
2. SkillValidator deprecates after 3 consecutive rejects
3. SkillValidator refuses same-session promotion (session gate)
4. SkillStore.findById/updateStatus/delete/recordOutcome round-trip
5. MemoryStore.deleteFile removes file from R2
6. SkillLoader filters draft skills by scope field (matching brand/series)
7. SkillLoader loads drafts without scope unconditionally
8. ProjectContextManager.getBrandForProject returns brand mapping

### Integration Tests
9. End-to-end: create 5+ high-confidence memories → runAnalysis → draft skill appears in R2
10. End-to-end: draft skill in R2 → SkillLoader picks it up → appears in system prompt
11. /skills API: list, approve, deprecate, delete operations with dual-write (R2 + DB)
12. Debounced trigger fires after response, skips if within 10 min window

### Edge Cases
13. Duplicate crystallization: runAnalysis overwrites existing skill at same path (intentional, no versioning)
14. Concurrent runAnalysis calls for same brand: last-write-wins (R2 is eventually consistent)
15. Server restart: SkillValidator performance data survives (PostgreSQL-backed)
16. Brand not mapped: analysis is no-op, no error

## Non-Goals

- No UI for skill editing (API-only for now)
- No multi-modal skill content (text-only markdown)
- No skill versioning (overwrite on re-crystallization is intentional)
- No cross-brand skill sharing (each brand scope is independent)
- No real-time notification of new draft skills (discovered on next session load)

## File Structure

```
apps/agent/src/
├── memory/
│   ├── memory-store.ts           (modify) Add deleteFile() method
│   └── pattern-observer.ts       (no change) Already uses MemoryStore DI
├── skills/
│   ├── skill-validator.ts        (new) Implicit validation engine
│   └── loader.ts                 (modify) Add activation_scope filter + brand/series context
├── assets/
│   └── skill-store.ts            (modify) Add findById, updateStatus, delete, recordOutcome
├── context/
│   └── project-context.ts        (modify) Add getBrandForProject()
├── routes/
│   └── skills.ts                 (new) /skills API route
├── server.ts                     (modify) Wire trigger + route + PatternObserver
└── index.ts                      (modify) Create PatternObserver, wire dependencies
```
