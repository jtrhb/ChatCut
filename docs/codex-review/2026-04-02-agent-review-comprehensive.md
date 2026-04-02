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

## 第二轮修复（commit `07dd9eac`）

以下问题在第二轮中全部修复。

### 设计文档偏离 — 已修复

| # | 问题 | 修复 |
|---|---|---|
| D1 | `NativeAPIRuntime` 无对话历史持久化 | 添加 `setSessionCallbacks` + `onMessage` 回调，user/assistant/tool_result 三路消息持久化 |
| D2 | `videoAnalysis` 无版本化字段，`scenes: any[]` | 添加 `sourceStorageKey`/`analyzedAtSnapshotVersion`/`lastAnalyzedAt`，scenes 改为强类型 |
| D3 | `memory-extractor` 不写因果追踪字段 | `created_session_id`/`last_reinforced_session_id` 在 create/reinforce 时写入 |
| D4 | `ExplorationEngine` 无状态机，commands 被丢弃 | 8 状态生命周期 + commands 应用到 clone + 5 个生命周期方法 + 15 新测试 |
| D5 | `downloadToTempFile` 全量读入内存 | 改为流式 pipe (`Readable.fromWeb` → `createWriteStream`) |

### Phase 4-5 stubs — 已接入真实服务

| 模块 | 修复 |
|---|---|
| Asset stores | 3 个 Drizzle schema 表 (assets, brandKits, skills) + stores 改用真实 Drizzle API |
| Routes: commands, project, media | 转为 DI factory 模式，接入 ServerEditorCore/ContextManager/ObjectStorage |
| MasterAgent: propose_changes | 接入 ChangesetManager.propose()（optional dep，无依赖时保留 stub） |
| MasterAgent: explore_options | 接入 ExplorationEngine.explore() |
| MasterAgent: export_video | 接入 TaskRegistry.createTask() |
| ExplorationEngine | 状态机 + commands 物化（见 D4） |

### packages/core — 已修复

| # | 修复 |
|---|---|
| C1 | `change-log.ts` 改用 `generateUUID()`，移除 `nanoid` 依赖 |
| C2 | 已记录需更新的 web 文件（需先添加 `@opencut/core` 为 web 依赖） |
| C3 | 提取 `apps/agent/src/utils/frontmatter.ts`，memory-store 和 loader 共用 |

## 仍存在的已知问题

### 预存在的测试问题

| 问题 | 影响 |
|---|---|
| `vi.mock` 不兼容 bun test runner | `sub-agents.test.ts`、`verification-agent.test.ts`、`runtime.test.ts`、`master-agent.test.ts` 无法在 bun 中运行 |
| Hono CORS middleware 在 bun 中返回 status 0 | `routes.test.ts` 全部失败 |
| `vi.clearAllMocks` 不兼容 bun | `vision-cache.test.ts` 失败 |
| ChangesetManager error-case 测试 | 2 个 approve/reject 状态互斥测试失败 |

## 仍未落地

| 项目 | 说明 |
|---|---|
| C2 完整落地 | `apps/web` 需添加 `@opencut/core` 依赖后，将 `capitalizeFirstLetter` 等导入切到 core |
| Content editing pipeline | `content-editor.ts`/`generation-client.ts` 存在但未接入 agent 链路（Phase 3 范围） |
| Sandbox + Preview 渲染 | ExplorationEngine 有状态机但 Daytona sandbox 和 Playwright 渲染未实现 |

## 新增测试清单

本次 review 共新增 **42 个测试**：

第一轮（24 个）：
- `memory-selector.test.ts`: 5 个（activation_scope 组合、confidence/source/updated 单独决胜）
- `tool-pipeline.test.ts`: 8 个（pre/post-hook failure → onFailure、key reserve/release/commit、async await）
- `loader.test.ts`: 6 个（agent_type 数组匹配、store/preset 双路径）
- `change-log.test.ts`: 2 个修复（bun 兼容）
- `event-bus.test.ts`: 1 个修复（bun 兼容）
- `sub-agents.test.ts` + `verification-agent.test.ts`: 2 个修复（apiKey 构造参数）

第二轮（18 个）：
- `exploration-engine.test.ts`: 15 个（状态机生命周期、commands 应用、select/apply/cancel）
- `project-context.test.ts`: 2 个（updateVideoAnalysis 版本化字段）
- `memory-extractor.test.ts`: 3 个（因果追踪字段写入 + bun 兼容修复）
