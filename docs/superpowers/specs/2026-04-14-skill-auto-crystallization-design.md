# Skill Auto-Crystallization Design Spec

## Overview

Wire the existing PatternObserver into the agent session lifecycle to enable automatic skill crystallization — the system detects repeated editing patterns from accumulated memories, generates draft skills, silently injects them into future sessions, and promotes/demotes them based on observed outcomes.

## Architecture

```
Session End (idle timeout / explicit close)
    ↓ async, non-blocking
PatternObserver.runAnalysis(scope)
    ↓ 5+ high-confidence memories, 2+ shared tags
crystallizeSkill() → R2 write draft skill .md
    ↓
Next Session Start
    ↓
SkillLoader loads draft skills (activation_scope filtered)
    ↓
Injected into system prompt (user unaware)
    ↓
Session behavior observed
    ↓ MemoryExtractor monitors approve/reject
SkillValidator evaluates performance
    ↓
approve rate up → "validated" | reject rate up → "deprecated"
```

## Components

### 1. Session End Trigger

**Location**: `apps/agent/src/server.ts` — `createMessageHandler()`

**Mechanism**: After each successful handler response, check if enough time has passed since last analysis (debounce). On session idle timeout (30 min, reuse OverflowStore idle timer concept) or when a new session replaces the current one for the same project, trigger analysis asynchronously.

```ts
// In createMessageHandler, after successful response:
queueMicrotask(() => {
  patternObserver.runAnalysis(session.projectId, scope).catch(console.error);
});
```

**Debounce**: Don't re-analyze if less than 10 minutes since last analysis for this scope. Track via `lastAnalysisAt: Map<string, number>`.

**Non-blocking**: Analysis runs after response is sent. Errors are logged, never propagated to user.

### 2. R2 Write Layer

**Location**: `apps/agent/src/memory/r2-client.ts` (new)

**Interface**:
```ts
export interface MemoryStore {
  read(path: string): Promise<string | null>;
  write(path: string, content: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  delete(path: string): Promise<void>;
}

export class R2MemoryStore implements MemoryStore {
  constructor(private bucket: R2Bucket | S3Client, private bucketName: string) {}
  // S3-compatible implementation using @aws-sdk/client-s3
}

export class LocalMemoryStore implements MemoryStore {
  constructor(private basePath: string) {}
  // Local filesystem implementation for development
}
```

**Skill write path**: `brands/{brandId}/_skills/skill-{skillId}.md`

**PatternObserver integration**: Replace direct R2 calls in `crystallizeSkill()` with injected `MemoryStore` interface. Currently PatternObserver has a hardcoded write — refactor to accept `MemoryStore` via constructor.

### 3. Draft Skill Auto-Loading

**Already implemented** in `apps/agent/src/skills/loader.ts`.

SkillLoader reads from R2 `_skills/` paths at three scope levels (global → brand → series). Draft skills with `skill_status: "draft"` are loaded but gated by `activation_scope` — only injected if the current session matches the scope's project/brand/series constraints.

**No changes needed** — verify via integration test that a draft skill written by PatternObserver is picked up by SkillLoader in the next session.

### 4. SkillValidator — Implicit Validation Engine

**Location**: `apps/agent/src/skills/skill-validator.ts` (new)

**Purpose**: Track draft skill performance across sessions and auto-promote/demote.

```ts
export interface SkillPerformance {
  skillId: string;
  sessionsSeen: number;        // sessions where this skill was active
  approveCount: number;        // changesets approved while skill active
  rejectCount: number;         // changesets rejected while skill active
  distinctSessions: Set<string>; // session IDs for cross-session validation
}

export class SkillValidator {
  private performances = new Map<string, SkillPerformance>();
  
  // Called by MemoryExtractor on approve/reject
  recordOutcome(skillId: string, sessionId: string, approved: boolean): void;
  
  // Check if any draft skill should be promoted or deprecated
  evaluate(skillId: string): "promote" | "deprecate" | "keep";
  
  // Apply the evaluation — update skill_status in R2
  async applyEvaluation(skillId: string, memoryStore: MemoryStore): Promise<void>;
}
```

**Promotion rules**:
- `promoted to "validated"`: 3+ positive reinforcements across 2+ distinct sessions
- `deprecated`: 3 consecutive rejects of the skill's associated operation type in any session
- **Session gate**: Cannot promote within the same session that created the draft (prevents self-reinforcement loop)

**Integration point**: MemoryExtractor already calls `handleApproval()` and `handleRejection()`. Add a hook that also notifies SkillValidator when a changeset is approved/rejected while a draft skill is active.

### 5. /skills API Route

**Location**: `apps/agent/src/routes/skills.ts` (new)

**Endpoints**:

| Method | Path | Description |
|--------|------|-------------|
| GET | /skills | List skills. Query params: `?status=draft&scope=brand:acme` |
| GET | /skills/:id | Get skill detail (content + frontmatter + performance stats) |
| POST | /skills/:id/approve | Manual promote: draft → validated |
| POST | /skills/:id/deprecate | Manual demote: any → deprecated |
| DELETE | /skills/:id | Delete skill from R2 + DB |

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
  content: string;  // markdown
  frontmatter: Record<string, unknown>;
}
```

**Wire into**: `apps/agent/src/server.ts` — `app.route("/skills", createSkillsRouter({ memoryStore, skillStore }))` and `apps/agent/src/index.ts`.

## Dependencies

| Dependency | Status | Action |
|-----------|--------|--------|
| PatternObserver | Implemented | Refactor to accept MemoryStore interface |
| SkillLoader | Implemented | No changes, verify via integration test |
| MemoryExtractor | Implemented | Add SkillValidator hook |
| SkillStore (DB) | Implemented | Use for metadata/search alongside R2 |
| R2 bucket | Available (user has admin) | Create bucket, configure env vars |
| @aws-sdk/client-s3 | Not installed | `bun add @aws-sdk/client-s3` |

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
1. PatternObserver with injected MemoryStore writes skill file to correct R2 path
2. SkillValidator promotes draft after 3+ reinforcements across 2+ sessions
3. SkillValidator deprecates after 3 consecutive rejects
4. SkillValidator refuses same-session promotion (session gate)
5. R2MemoryStore read/write/list/delete round-trip (against mock or local)
6. LocalMemoryStore file operations match R2MemoryStore interface

### Integration Tests
7. End-to-end: create 5+ high-confidence memories → runAnalysis → draft skill appears in R2
8. End-to-end: draft skill in R2 → SkillLoader picks it up → appears in system prompt
9. /skills API: list, approve, deprecate, delete operations
10. Session end trigger fires asynchronously after handler response

### Edge Cases
11. Duplicate crystallization prevention (same pattern already crystallized)
12. Concurrent session ends for same scope don't produce duplicate skills
13. Draft skill with activation_scope only loads in matching sessions
14. Debounce prevents re-analysis within 10 minutes

## Non-Goals

- No UI for skill editing (API-only for now)
- No multi-modal skill content (text-only markdown)
- No skill versioning (overwrite on re-crystallization)
- No cross-brand skill sharing (each brand scope is independent)

## File Structure

```
apps/agent/src/
├── memory/
│   ├── r2-client.ts              (new) MemoryStore interface + R2/Local implementations
│   └── pattern-observer.ts       (modify) Accept MemoryStore, refactor crystallizeSkill
├── skills/
│   ├── skill-validator.ts        (new) Implicit validation engine
│   └── loader.ts                 (verify) No changes expected
├── routes/
│   └── skills.ts                 (new) /skills API route
├── server.ts                     (modify) Wire trigger + route
└── index.ts                      (modify) Create R2 client, wire dependencies
```
