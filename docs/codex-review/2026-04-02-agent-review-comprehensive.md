# Agent Comprehensive Review

日期：2026-04-02

范围：`apps/agent/src/`、`packages/core/src/`，对照 `docs/` 设计文档和前 3 轮 Codex review。

测试情况：
- `packages/core`: 18 tests, 18 pass
- `apps/agent` (非 mock 测试): 148 tests, 148 pass

## 已修复的 Findings

以下问题在本次 review 中发现并已修复（commits: `6779746f`, `ef3ab52b`, `646471d4`）。

### Bug 修复

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| B1 | `apps/agent/package.json` | 缺失运行时依赖 `zod-to-json-schema` 和 `nanoid`，启动崩溃 | 添加到 dependencies |
| B2 | `apps/agent/src/db/index.ts` | `DATABASE_URL!` 模块级执行无守卫，未设时崩溃 | 添加守卫抛出明确错误 |
| B3 | `apps/agent/src/services/vision-client.ts` | API key 拼入 URL（泄露风险）+ `data.candidates[0]` 零防御 | key 改为请求时传入 + 完整错误处理 |
| B4 | `packages/core/src/commands/batch-command.ts` | `redo()` 调 `execute()` 而非 `redo()`，子命令覆盖被绕过 | 改为调 `command.redo()` |
| B5 | `packages/core/src/utils/track-utils.ts` | 公开 API 拼写 `canTracktHaveAudio`（多了 t） | 重命名 + deprecated alias + 全量消费者更新 |
| B6 | `packages/core/src/__tests__/change-log.test.ts` | `toHaveBeenCalledOnce`/`toHaveBeenCalledWith` 不兼容 bun | 替换为 `toHaveBeenCalledTimes(1)` + `mock.calls[0][0]` |

### Codex Review 遗留修复

| # | 来源 | 问题 | 修复 |
|---|------|------|------|
| CR1 | Review-1 #1 | `MemorySelector` activation_scope：代码已正确但测试覆盖不足 | 补充 5 个隔离测试（project_id+session_id 组合、confidence/source/updated 单独决胜） |
| CR2 | Review-1 #2 + Review-2 #1 | `ToolPipeline` 幂等 key 被 hook 失败永久污染 | 三阶段 key 生命周期（reserve/release/commit）+ onFailure 全路径触发 + 8 新测试 |
| CR3 | Review-2 #2 | `skill agent_type` 类型声明允许数组但运行时强制单值 | `ParsedMemory.agent_type` 改为 `string \| string[]`，loader/store/runtime 全链路支持 + 6 新测试 |

### Integration Wiring 修复

| # | 问题 | 修复 |
|---|------|------|
| W1 | 死代码：backward-compat route exports（chat/events/status standalone） | 删除 |
| W2 | Sub-agents 每次 dispatch 读 `process.env.ANTHROPIC_API_KEY ?? ""`，无校验 | API key 启动时校验，构造时注入 |
| W3 | `EventBusHook` 创建了但没注册到任何 pipeline | 注册到 MasterAgent + 所有 sub-agent pipeline |
| W4 | Chat 路由不执行 agent，永远返回 `"processing"` | `MessageHandler` 接口接入，执行后记录响应 |
| W5 | `runtime.onTurnComplete` → `sessionManager.incrementTurn` 未接线 | `createWiredMasterAgent()` 工厂接通 |
| W6 | `index.ts` 不创建 MasterAgent 和 sub-agents | 完整 agent 堆栈在启动时构建并接入 |
| W7 | `availableTools: []` 导致 skill 解析拿不到工具名 | 从 `masterToolDefinitions` 提取真实工具名 |

## 仍存在的已知问题（非本次修复范围）

### 设计文档与实现的偏离

| # | 设计文档要求 | 实际状态 | 优先级 |
|---|---|---|---|
| D1 | `chatcut-agent-system.md §2.2`: AgentRuntime 含 `saveSession`/`restoreSession` | `NativeAPIRuntime` 无对话历史持久化，会话间不保留上下文 | P1 |
| D2 | `chatcut-agent-system.md §3.2`: ProjectContext 含版本化 `videoAnalysis`（`analyzedAtSnapshotVersion`） | `scenes: any[]`，无版本化字段 | P1 |
| D3 | `chatcut-memory-layer.md §3.4`: Memory 含 `used_in_changeset_ids`、`created_session_id` | `memory-extractor.ts` 不写这些因果追踪字段 | P1 |
| D4 | `chatcut-fanout-exploration.md §2`: Exploration 状态机 | `exploration-engine.ts` 无状态机，`void skeleton.commands` 丢弃 commands | P1 |
| D5 | `chatcut-plan.md §3.2.1`: `downloadToTempFile` 流式落盘避免 OOM | 当前实现把整个 body 读入内存再写文件 | P2 |

### 半成品模块（Phase 4-5 计划内）

以下是设计文档中明确分阶段的未实现部分，不是 bug：

| 模块 | 当前状态 | 目标 Phase |
|---|---|---|
| Asset stores (asset/brand/skill) | DB API 不匹配 Drizzle，无对应 schema 表 | Phase 5 |
| Routes: commands, project, media | Stub 返回 hardcoded 值 | Phase 4 |
| MasterAgent: propose_changes, explore_options, export_video | Stub 返回 pending/queued | Phase 4 |
| ExplorationEngine | 未物化 commands，无 preview pipeline | Phase 4 |
| Content editing pipeline (extract→generate→replace) | 服务类存在，未接入 agent 链路 | Phase 3 |

### packages/core 问题

| # | 问题 | 优先级 |
|---|---|---|
| C1 | `change-log.ts` 用 nanoid，其余用 crypto.randomUUID — 两种 ID 格式共存 | P2 |
| C2 | core ↔ web 大量工具函数重复（track-utils, bookmarks, string, effects） | P2 |
| C3 | `parseFrontmatter` 在 memory-store 和 skills/loader 中重复实现 | P2 |

### 预存在的测试问题

| 问题 | 影响 |
|---|---|
| `vi.mock` 不兼容 bun test runner | `sub-agents.test.ts`、`verification-agent.test.ts`、`runtime.test.ts`、`master-agent.test.ts` 无法在 bun 中运行 |
| Hono CORS middleware 在 bun 中返回 status 0 | `routes.test.ts` 全部失败 |
| `vi.clearAllMocks` 不兼容 bun | `vision-cache.test.ts` 失败 |
| ChangesetManager error-case 测试 | 2 个 approve/reject 状态互斥测试失败 |

## 新增测试清单

本次 review 共新增 24 个测试：

- `memory-selector.test.ts`: 5 个（activation_scope 组合、confidence/source/updated 单独决胜）
- `tool-pipeline.test.ts`: 8 个（pre/post-hook failure → onFailure、key reserve/release/commit、async await）
- `loader.test.ts`: 6 个（agent_type 数组匹配、store/preset 双路径）
- `change-log.test.ts`: 2 个修复（bun 兼容）
- `event-bus.test.ts`: 1 个修复（bun 兼容）
- `sub-agents.test.ts` + `verification-agent.test.ts`: 2 个修复（apiKey 构造参数）
