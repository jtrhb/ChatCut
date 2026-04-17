# Plan: Tool System Evolution Finalization

## Source Spec
`.omc/specs/deep-interview-tool-evolution-clarification.md`

## RALPLAN-DR Summary

### Principles
1. **Server-first validation** — every decision validated against OpenCut's multi-session server architecture, not assumed from Claude Code
2. **Additive by default** — ToolDefinition changes are optional fields unless breaking change is justified
3. **Needed-or-cut** — each section gets a verdict; "premature" = defer, not delete from doc
4. **Testable outcomes** — every final decision has >= 3 acceptance criteria that can be verified by `bun test`
5. **Sub-agent awareness** — decisions must account for SubAgent's independent NativeAPIRuntime lifecycle
6. **Two-level concurrency** — writeLock guards inter-session project state; pipeline partitioning guards intra-turn tool parallelism. Both coexist. *(added per Architect R1)*

### Decision Drivers
1. **Context window protection** — the primary motivation; unbounded tool results eat agent context
2. **Latency sensitivity** — interactive video editor targets < 200ms for metadata ops, < 5s for compute ops
3. **Interface stability** — ~20 files consume ToolDefinition; churn has high blast radius

### Viable Options

**Option A: Incremental evolution (Recommended)**
Implement sections in dependency order (P0→P7), each section is a self-contained PR. Review findings accepted/modified individually. No section is cut entirely — each addresses a real current or near-future problem.
- Pros: Low risk per PR, easy to revert individual sections, testable incrementally
- Cons: Slower total delivery, some sections may feel premature until tool count grows

**Option B: Big-bang refactor**
Implement all 6 sections in a single PR with the final ToolDefinition interface.
- Pros: One migration, clean interface from day one
- Cons: High blast radius, hard to bisect regressions, review burden
- **Invalidated because:** 20+ files affected, pipeline is load-bearing, risk of cascading test failures

**Option C: Cut Sections 4 and 6**
Only implement sections 1-3 and 5. Defer deferred-loading and rendering entirely.
- Pros: Removes the two highest-risk, highest-effort sections
- Cons: Section 4 has real token cost now (~5K/dispatch for Editor), Section 6's onProgress extensibility point should be pre-designed even if not implemented

## Architect Review Revisions (Iteration 1)

The Architect returned **ITERATE** with 5 recommendations. All accepted and integrated:

| # | Architect Recommendation | Resolution |
|---|--------------------------|------------|
| A1 | Remove false dependencies P3→P5 and P4→P6 | Fixed — P5 depends on P0 (formatToolsForApi), P6 depends on NativeAPIRuntime loop |
| A2 | `accessMode` remains authoritative; `isReadOnly` is additive sugar | Fixed — `isReadOnly: true` forces `accessMode = "read"`, but `accessMode` stays the source of truth for pipeline checks |
| A3 | Don't remove writeLock; add pipeline partitioning as separate intra-turn concern | Fixed — two-level concurrency model added as Principle 6 |
| A4 | SubAgent needs ProjectContext for Sections 3 and 5 | Fixed — new Step 1.3 added: inject ProjectContext via SubAgentDeps |
| A5 | Consolidate formatToolsForApi changes from P0, P3, P5 | Fixed — P0 redesigns formatToolsForApi once; P3 and P5 extend it |

## Plan: Per-Section Debate & Finalization

### Phase 1: Foundation (P0-P1)

**Step 1.1: Section 3 — formatToolsForApi Redesign (P0)**
- Verdict decision: needed
- No review findings to debate (R3-1 is about isEnabled, handled separately)
- Deliverable: Redesign `formatToolsForApi` to support sorting + context parameter (future-proofing for P3/P5)
- **Callers to update (Critic C3)**: `MasterAgent.handleUserMessage()` (`master-agent.ts:137`), `SubAgent.dispatch()` (`sub-agent.ts:58`)
- Acceptance criteria:
  1. `formatToolsForApi(tools)` returns tools sorted by `name` alphabetically
  2. Given tools registered in any order, output order is deterministic and identical
  3. Two calls with the same tools produce identical JSON serialization (cache key stable)

**Step 1.2: Section 2 — Fail-Closed Defaults (P1, without parallel execution)**
- Verdict decision: needed
- Findings to debate: none (R2-1/R2-2/R2-3 apply to parallel execution, handled in P4)
- Deliverable: Add `isReadOnly?: boolean` and `isConcurrencySafe?: boolean | ((input) => boolean)` to ToolDefinition
- **Additive constraint**: `accessMode` remains the authoritative field. `isReadOnly` is convenience sugar. Pipeline checks continue to use `accessMode`. No behavioral change to existing code.
- **Conflict resolution (Critic C1)**: If a tool declares both `isReadOnly: true` AND `accessMode: "read_write"`, registration throws a validation error. No silent override — fail-closed.
- Acceptance criteria:
  1. ToolDefinition without `isReadOnly` defaults to `isReadOnly = false` (fail-closed)
  2. ToolDefinition without `isConcurrencySafe` defaults to `isConcurrencySafe = false` (fail-closed)
  3. `isReadOnly: true` sets `accessMode` to `"read"` at registration; explicit `accessMode` declaration is no longer required for read-only tools
  4. Existing tools without new fields continue to work identically (zero behavioral change)
  5. Declaring `isReadOnly: true` with `accessMode: "read_write"` or `"write"` throws a validation error at registration (Critic C1)

**Step 1.3: SubAgent ProjectContext Injection (P1, new)**
- Deliverable: Add optional `projectContext?: Readonly<ProjectContext>` to `SubAgentDeps`
- Rationale: Sections 3 (isEnabled) and 5 (descriptionSuffix) both need ProjectContext in SubAgent. Inject once, use in both.
- Acceptance criteria:
  1. SubAgent receives ProjectContext via deps when provided
  2. SubAgent without ProjectContext continues to work (backward compatible)
  3. ProjectContext is passed as `Readonly<>` — SubAgent cannot mutate it

### Phase 2: Core Capabilities (P2-P3)

**Step 2.1: Section 1 — Result Budget Control (P2)**
- Verdict decision: needed
- Findings to debate: R1-1 (R2 vs session Map), R1-2 (timeline 100K contradiction), R1-3 (sub-agent access), R1-4 (preview strategy)
- Key decision: overflow target (R2 Memory vs session-scoped Map vs tool-specific summarize())
- Acceptance criteria:
  1. Tool results exceeding `maxResultSizeChars` (default 30K) are stored in overflow and a preview + reference returned
  2. Overflow storage is scoped to session lifetime — cleared when session ends
  3. Each tool can declare a custom `summarize(result): string` method for preview generation; tools without it get truncated JSON with structure preservation

**Step 2.2: Section 3 — isEnabled Runtime Filtering (P3)**
- Verdict decision: needed
- Finding to debate: R3-1 (stale check problem)
- Key decision: `isEnabled` only for stable environmental conditions (API keys, feature flags), NOT dynamic runtime state
- Depends on: P0 (formatToolsForApi context parameter), P1.3 (SubAgent ProjectContext)
- Acceptance criteria:
  1. Tool with `isEnabled` returning false is absent from the formatted tool list — model cannot see or call it
  2. `isEnabled` receives `ToolFilterContext` with `projectContext`, `session`, `env`
  3. `ToolFilterContext` is available in both MasterAgent and SubAgent (via Step 1.3)

### Phase 3: Concurrency (P4)

**Step 3.1: Section 2 — Parallel Execution (Intra-Turn)**
- Findings to debate: R2-1 (dual locking), R2-2 (TOCTOU race), R2-3 (Phase model too coarse)
- Key decision: **Two-level model** — writeLock (inter-session) STAYS, pipeline partitioning (intra-turn) ADDED
- Depends on: P1 (needs isConcurrencySafe declarations)
- Acceptance criteria:
  1. When API returns multiple tool_use blocks, concurrency-safe tools execute in parallel (Promise.all)
  2. Non-concurrent-safe tools execute sequentially after all concurrent tools complete
  3. writeLock in MasterAgent.handleDispatch() is NOT removed — it continues to guard inter-session writes
  4. Pipeline partitioning and writeLock do not deadlock (writeLock is acquired per-dispatch, partitioning is per-turn)

### Phase 4: Optimization (P5-P6)

**Step 4.1: Section 5 — Dynamic Description (P5)**
- Findings to debate: R5-1 (union type vs suffix), R5-2 (context plumbing), R5-3 (cache conflict)
- Key decision: `descriptionSuffix?: (ctx) => string | undefined` (additive, no union type)
- Depends on: P0 (formatToolsForApi already accepts context)
- Acceptance criteria:
  1. `descriptionSuffix` is an optional field on ToolDefinition — tools without it are unaffected
  2. `formatToolsForApi` appends suffix to description when present and non-empty
  3. Suffix-only changes preserve the main description text — cache key changes are minimized to suffix content

**Step 4.2: Section 4 — Deferred Loading (P6)**
- Findings to debate: R4-1 [Critical] (batch_edit schema gap), R4-2 [Critical] (resolve_tools mechanism), R4-3 (latency), R4-4 (skill coupling)
- Key decision: Master-level only; sub-agent tools stay fully loaded
- Depends on: NativeAPIRuntime multi-turn loop support (independent of P4)
- Acceptance criteria:
  1. Deferred tools appear in system prompt as name + hint but NOT in `tools` parameter
  2. `resolve_tools` call returns full schema; runtime adds resolved tools to next API request's `tools` list
  3. Sub-agent tools are NEVER deferred — full schema always included
  4. `batch_edit` and all its operand schemas are in the same loading tier (all core or all deferred together)

### Phase 5: Rendering Foundation (P7)

**Step 5.1: Section 6 — onProgress + Extension Points**
- Findings to debate: R6-1 [Critical] (onProgress design gap), R6-2 (ghost ≠ changeset), R6-3 (SAM2 direction), R6-4 (forward dependency)
- Key decision: design onProgress interface now; implement when Chat UI is ready
- Depends on: P4 (executor signature)
- Acceptance criteria:
  1. `ToolPipeline.execute()` accepts optional `onProgress?: (event: ToolProgressEvent) => void` callback
  2. Tools without progress support ignore the callback — zero behavioral change
  3. `ToolCallResult` has optional `visualHints?: unknown` field for future ghost integration
  4. SAM2 is explicitly scoped as client-side concern — removed from agent-side evolution doc

### Phase 6: Final Assembly

**Step 6.1: Consolidate Final ToolDefinition Interface**
- Merge all accepted changes into one interface spec
- Verify all fields are additive (or justify breaking changes)
- Final interface should add: `isReadOnly?`, `isConcurrencySafe?`, `maxResultSizeChars?`, `summarize?`, `isEnabled?`, `descriptionSuffix?`, `shouldDefer?`, `searchHint?`
- `accessMode` remains — NOT deprecated, NOT derived. `isReadOnly` is sugar that sets it.

**Step 6.2: Update Evolution Document**
- Replace original decisions with finalized versions
- Add acceptance tests per section
- Archive resolved review findings (keep for historical context)
- **Fix writeLock contradiction (Critic C2)**: Evolution doc priority table P4 row currently says "去 writeLock，用 pipeline 分区". Must change to "保留 writeLock（inter-session）+ 添加 pipeline 分区（intra-turn）" to match the finalized two-level concurrency decision

## Dependency Graph (Revised per Architect)

```
P0 (sorting + formatToolsForApi redesign) ──┬──→ P3 (isEnabled)
                                             └──→ P5 (descriptionSuffix)

P1 (fail-closed defaults) ──→ P4 (parallel execution)

P1.3 (SubAgent ProjectContext) ──→ P3, P5

P2 (result budgets) — independent

P6 (deferred loading) — depends on NativeAPIRuntime loop, NOT on P4

P7 (onProgress) — depends on P4 (executor signature)
```

**Parallelizable**: P0+P1+P1.3+P2 can all run concurrently in Phase 1.

## Execution Format

Each step produces:
1. **Verdict**: needed / premature / cut
2. **Finding resolutions**: accept / reject / modify with one-line rationale
3. **Final decision**: the updated design decision
4. **Acceptance tests**: 3+ testable statements

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| Debate runs too long | Each finding gets max 2 exchanges (present → position → resolve) |
| Breaking change creep | Planner tracks all interface changes; Critic validates additive constraint |
| Forward dependency blind spots | Phase 5 explicitly checks Sections 1-5 for extension points |
| writeLock removal causes concurrency regression | writeLock is KEPT (Architect A3); pipeline partitioning is additive |
| SubAgent lacks context for isEnabled/suffix | Step 1.3 injects ProjectContext early (Architect A4) |
| formatToolsForApi touched 3 times | Consolidated redesign in P0 (Architect A5) |
