# Deep Interview Spec: Tool System Evolution Clarification

## Metadata
- Interview ID: di-tool-evolution-001
- Rounds: 6
- Final Ambiguity Score: 19%
- Type: brownfield
- Generated: 2026-04-03
- Threshold: 20%
- Status: PASSED

## Clarity Breakdown
| Dimension | Score | Weight | Weighted |
|-----------|-------|--------|----------|
| Goal Clarity | 0.90 | 35% | 0.315 |
| Constraint Clarity | 0.75 | 25% | 0.188 |
| Success Criteria | 0.85 | 25% | 0.213 |
| Context Clarity | 0.65 | 15% | 0.098 |
| **Total Clarity** | | | **0.813** |
| **Ambiguity** | | | **18.7%** |

## Goal

Finalize all 6 sections of `docs/chatcut-tool-system-evolution.md` into an implementable specification. Each section receives a verdict (needed / premature / cut), a final decision on every review finding, and testable acceptance criteria.

## Constraints

- **Interface changes:** Additive (new optional fields) preferred. Breaking changes (type changes, signature changes) require explicit justification showing architectural benefit that additive cannot achieve.
- **Scope:** All 6 sections are in scope. "Don't do this at all" is a valid outcome for any section.
- **Architecture premise:** Solutions must be validated against OpenCut's server-side multi-agent architecture, not assumed valid because Claude Code uses them.

## Non-Goals

- No implementation code in this spec — decisions and acceptance tests only
- No timeline estimates or sprint planning
- No UI/UX design work (Section 6 covers agent-side only, Ghost/rendering design stays in chatcut-ux-design.md)

## Acceptance Criteria

- [ ] Each of the 6 sections has a verdict: needed / premature / cut
- [ ] Each of the 15 review findings (R1-1 through R6-4) has a resolution: accept / reject / modify
- [ ] Each "needed" section has >= 3 testable acceptance criteria
- [ ] Each accepted review finding has an updated decision that replaces the original
- [ ] Final ToolDefinition interface is specified (showing all new fields, all additive unless justified)
- [ ] Breaking changes (if any) have explicit justification
- [ ] Document updated in-place with final decisions

## Assumptions Exposed & Resolved

| Assumption | Challenge | Resolution |
|------------|-----------|------------|
| Claude Code patterns transfer to server agents | Contrarian mode (Round 5) | Evaluate per-section; some may be premature |
| All 6 sections are needed | Contrarian mode (Round 5) | Each section gets needed/premature/cut verdict |
| Breaking interface changes are acceptable | Round 6 | Additive preferred; breaking needs justification |
| Review findings are mostly correct | Round 4 | Each finding debated individually |

## Technical Context

**Codebase explored:**
- `apps/agent/src/tools/types.ts` — current ToolDefinition (6 fields: name, description, inputSchema, agentTypes, accessMode)
- `apps/agent/src/tools/tool-pipeline.ts` — 288-line pipeline with stage machine, idempotency, hooks, traces
- `apps/agent/src/tools/format-for-api.ts` — simple Zod→JSON Schema conversion, no sorting
- `apps/agent/src/tools/master-tools.ts` — 9 master tool definitions
- `apps/agent/src/tools/editor-tools.ts` — 16 editor tool definitions + EditorToolExecutor (939 lines)
- `apps/agent/src/agents/master-agent.ts` — MasterAgent with writeLock, skill resolution, tool filtering
- `apps/agent/src/agents/sub-agent.ts` — SubAgent with standalone NativeAPIRuntime per dispatch
- `apps/agent/src/tools/hooks.ts` — ToolHook system (pre/post/onFailure)

**Key architectural facts:**
- MasterAgent already has `writeLock` for write/read_write dispatch operations
- SubAgent creates independent NativeAPIRuntime instances — no shared state or memory access
- formatToolsForApi does NO sorting — cache instability is real
- ToolPipeline has NO progress/streaming support
- Tool count: ~50 total (9 master + 16 editor + 6 audio + etc.)

## Ontology (Key Entities)

| Entity | Type | Fields | Relationships |
|--------|------|--------|---------------|
| ToolDefinition | core domain | name, description, inputSchema, agentTypes, accessMode + proposed new fields | Used by ToolPipeline, formatToolsForApi |
| ToolPipeline | core domain | tools, hooks, traces, executor, idempotency | Consumes ToolDefinition, produces PipelineResult |
| EvolutionPlan | document | 6 sections, review findings, priority table | References ToolDefinition, ToolPipeline |
| AcceptanceTest | deliverable | testable statement per section | Validates EvolutionPlan decisions |
| ReviewFinding | deliverable | 15 findings (R1-1..R6-4), severity, resolution | Challenges EvolutionPlan decisions |

## Ontology Convergence

| Round | Entity Count | New | Changed | Stable | Stability Ratio |
|-------|-------------|-----|---------|--------|----------------|
| 1 | 3 | 3 | - | - | N/A |
| 2 | 3 | 0 | 0 | 3 | 100% |
| 3 | 4 | 1 | 0 | 3 | 75% |
| 4 | 5 | 1 | 0 | 4 | 80% |
| 5 | 5 | 0 | 0 | 5 | 100% |
| 6 | 5 | 0 | 0 | 5 | 100% |

## Process: Per-Section Debate

For each of the 6 sections, the following flow:

1. **Verdict:** needed / premature / cut
2. **Finding debate:** For each review finding in the section:
   - Present the finding
   - User gives position
   - Resolve: accept / reject / modify
3. **Final decision:** Updated decision reflecting resolved findings
4. **Acceptance tests:** 3+ testable statements

### Findings by Section

**Section 1 (Result Budgets):** R1-1, R1-2, R1-3, R1-4
**Section 2 (Fail-closed + Parallel):** R2-1, R2-2, R2-3
**Section 3 (Three-tier Filtering):** R3-1
**Section 4 (Deferred Loading):** R4-1 [Critical], R4-2 [Critical], R4-3, R4-4
**Section 5 (Dynamic Description):** R5-1, R5-2, R5-3
**Section 6 (Rendering):** R6-1 [Critical], R6-2, R6-3, R6-4

## Interview Transcript

<details>
<summary>Full Q&A (6 rounds)</summary>

### Round 1
**Q:** The doc has 6 evolution areas, all marked '已讨论', plus 15 review findings I just added. What's your goal with this clarification — what does 'done' look like?
**A:** Finalize for implementation
**Ambiguity:** 62% (Goal: 0.55, Constraints: 0.15, Criteria: 0.30, Context: 0.50)

### Round 2
**Q:** Are you finalizing ALL 6 sections into an implementable spec, or scoping to a subset?
**A:** All 6 sections
**Ambiguity:** 53% (Goal: 0.70, Constraints: 0.30, Criteria: 0.30, Context: 0.50)

### Round 3
**Q:** For a section to be 'finalized', what does it need?
**A:** Decision + acceptance tests
**Ambiguity:** 37% (Goal: 0.85, Constraints: 0.30, Criteria: 0.70, Context: 0.55)

### Round 4
**Q:** How do you want to handle the 15 review findings?
**A:** Debate each finding
**Ambiguity:** 33% (Goal: 0.90, Constraints: 0.35, Criteria: 0.75, Context: 0.55)

### Round 5 (Contrarian Mode)
**Q:** What if some sections should be cut entirely rather than adjusted?
**A:** Let's evaluate per-section
**Ambiguity:** 27% (Goal: 0.90, Constraints: 0.50, Criteria: 0.80, Context: 0.60)

### Round 6
**Q:** How much breaking change to the ToolDefinition interface is acceptable?
**A:** Additive preferred, breaking if justified
**Ambiguity:** 19% (Goal: 0.90, Constraints: 0.75, Criteria: 0.85, Context: 0.65)

</details>
</content>
</invoke>