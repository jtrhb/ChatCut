# 2026-04-02 Comprehensive Review & Implementation Changelog

## 概述

对 `apps/agent/`、`packages/core/`、`apps/web/` 进行全深度 review 后，识别并修复了全部问题。从第一份 report 到最终落地，共 7 commits，涉及 ~70 文件，新增 42 测试。

**验证结果：** 313 tests 全部 pass（core 18 + agent 207 + web 88）

---

## Commits

```
8aec5817 refactor: eliminate web→core duplication — web imports from @opencut/core
cb23ecd0 docs: update review report — all findings resolved
07dd9eac feat(agent): implement remaining review findings (D1-D5, C1-C3, Phase 4-5)
1d5c532e docs: add comprehensive agent review report
646471d4 feat(agent): wire index.ts — full production agent stack
ef3ab52b feat(agent): wire integration — EventBus, session-aware chat, turn tracking
6779746f fix(agent): resolve 6 bugs, 4 codex review findings, and wire integration
```

---

## 一、Bug 修复 (6 个)

### B1: 缺失运行时依赖
- **文件:** `apps/agent/package.json`
- **问题:** `zod-to-json-schema` 和 `nanoid` 被 import 但未声明为依赖，启动时 MODULE_NOT_FOUND
- **修复:** 添加到 dependencies

### B2: DATABASE_URL 无守卫崩溃
- **文件:** `apps/agent/src/db/index.ts`
- **问题:** `process.env.DATABASE_URL!` 模块级执行，未设时 `postgres(undefined)` 崩溃
- **修复:** 添加守卫，未设时抛出明确错误信息

### B3: Vision Client 零防御 + API Key 泄露
- **文件:** `apps/agent/src/services/vision-client.ts`
- **问题:**
  - API key 拼入 URL 字符串存储，任何日志输出都会泄露
  - `data.candidates[0].content.parts[0].text` 无防御，Gemini 返回空 candidates 或 safety filter 时 TypeError
- **修复:**
  - API key 改为请求时传入 query param，不存储在实例变量中
  - 添加 `response.ok` 检查、candidates 数组验证、content/parts 存在性检查、JSON.parse try/catch

### B4: BatchCommand.redo() 调错方法
- **文件:** `packages/core/src/commands/batch-command.ts`
- **问题:** `redo()` 遍历子命令调 `command.execute()` 而非 `command.redo()`，子命令覆盖 `redo()` 时行为被绕过
- **修复:** 改为调 `command.redo()`

### B5: 公开 API 拼写错误 canTracktHaveAudio
- **文件:** `packages/core/src/utils/track-utils.ts`, `packages/core/src/index.ts`, 及 web 侧 4 个消费者
- **问题:** 函数名多了一个 `t`，已被 web 消费，越晚改成本越高
- **修复:** 重命名为 `canTrackHaveAudio`，添加 deprecated re-export alias，更新所有消费者

### B6: Core 测试 bun 不兼容
- **文件:** `packages/core/src/__tests__/change-log.test.ts`, `apps/agent/src/events/__tests__/event-bus.test.ts`
- **问题:** `toHaveBeenCalledOnce()` 和 `toHaveBeenCalledWith()` 在 bun test runner 中未实现
- **修复:** 替换为 `toHaveBeenCalledTimes(1)` + `mock.calls[0][0]`

---

## 二、Codex Review 遗留修复 (4 个)

### CR1: MemorySelector activation_scope 测试覆盖
- **文件:** `apps/agent/src/memory/__tests__/memory-selector.test.ts`
- **发现:** 代码实现已正确（在前几轮 commit 中修复），但测试覆盖不足
- **修复:** 补充 5 个隔离测试：
  - Draft with project_id+batch_id+session_id 全匹配通过
  - Draft with project_id 匹配但 session_id 不匹配被排除
  - Confidence 单独决胜
  - Source 单独决胜
  - Updated 单独决胜

### CR2: ToolPipeline 幂等 key 生命周期
- **文件:** `apps/agent/src/tools/tool-pipeline.ts`
- **问题:**
  - 幂等 key 在 executor 成功后立即提交，post-hook 失败时 key 已占用但整体失败
  - onFailure hooks 部分路径不触发，部分路径 fire-and-forget
- **修复:**
  - 三阶段生命周期：`reserve`（防并发）→ `release`（任意失败时释放）→ `commit`（全部成功时永久占用）
  - 显式 `PipelineStage` 状态机：`validated → reserved → executed → post_processed → committed`
  - onFailure 在所有失败路径（executor、pre-hook、post-hook）都触发且 `await`
  - onFailure 自身抛错被 try/catch 吞掉不影响 pipeline
- **新增 8 个测试:** pre/post-hook failure → onFailure、key reserve/release/commit、async await

### CR3: Skill agent_type 数组契约
- **文件:** `apps/agent/src/skills/types.ts`, `skills/loader.ts`, `memory/types.ts`, `memory/memory-store.ts`
- **问题:** 类型声明允许 `AgentType | AgentType[]`，但运行时 `String(fields.agent_type)` 强制转单值
- **修复:**
  - `ParsedMemory.agent_type` 改为 `string | string[]`
  - Frontmatter 解析保留数组而非 `String()` 强转
  - 过滤逻辑支持 `Array.isArray()` 检查
  - 提取 `agentTypeMatches()` 辅助函数统一匹配逻辑
- **新增 6 个测试:** 数组匹配双路径（store + preset）

### CR4: Frontmatter 解析器重复
- **文件:** `apps/agent/src/utils/frontmatter.ts` (新建), `memory/memory-store.ts`, `skills/loader.ts`
- **问题:** `parseFrontmatter` + `parseYamlValue` 在 memory-store 和 loader 中各有一份
- **修复:** 提取到共享 `utils/frontmatter.ts`，两处改为 import

---

## 三、Integration Wiring (8 项)

### W1: 删除死代码路由
- **文件:** `routes/chat.ts`, `routes/events.ts`, `routes/status.ts`
- **问题:** 每个文件导出 standalone router + DI factory，standalone 版本无人消费
- **修复:** 删除 standalone exports，只保留 `createXxxRouter()` factory

### W2: Sub-agent API Key 注入
- **文件:** 6 个 agent 文件 + 2 个 test 文件
- **问题:** 每次 `dispatch()` 读 `process.env.ANTHROPIC_API_KEY ?? ""`，空字符串产生不可调试的 401
- **修复:** 构造时注入 `apiKey`，启动时在 `index.ts` 验证

### W3: EventBus 接入 Pipeline
- **文件:** `tools/hooks.ts`, `server.ts`, `agents/create-agent-pipeline.ts`, 6 个 agent 文件
- **问题:** EventBus 存在但无人 emit 事件
- **修复:**
  - 创建 `createEventBusHook()` — pre-hook emit `tool.called`，post-hook emit `tool.result`
  - `createAgentPipeline()` 接受 `ToolHook[]` 参数
  - 所有 sub-agent 构造时传入 eventBusHook
  - MasterAgent 构造时注册 eventBusHook

### W4: Chat 路由接入 Agent 执行
- **文件:** `routes/chat.ts`, `server.ts`
- **问题:** POST /chat 只记录消息返回 `"processing"`，不执行 Agent
- **修复:**
  - `MessageHandler` 类型 + `createMessageHandler()` 工厂
  - Chat 路由有 handler 时：执行 → 记录 assistant response → 返回 `"completed"`
  - 无 handler 时保留 stub 行为（测试兼容）
  - 错误时 `status: "failed"` + 错误信息

### W5: Runtime Session Turn 追踪
- **文件:** `server.ts` (`createWiredMasterAgent`)
- **问题:** `runtime.onTurnComplete` 和 `sessionManager.incrementTurn` 都存在但没连接
- **修复:** `createWiredMasterAgent()` 将 `runtime.setOnTurnComplete` 接到 `sessionManager.incrementTurn`

### W6: Session 生命周期事件
- **文件:** `routes/chat.ts`, `server.ts` (`createMessageHandler`)
- **修复:**
  - Chat 路由 emit `session.created`
  - MessageHandler emit `agent.turn_start` / `agent.turn_end`

### W7: index.ts 完整 Agent 堆栈
- **文件:** `apps/agent/src/index.ts`
- **问题:** 只创建 app 和 skill loader，不创建 MasterAgent/sub-agents/messageHandler
- **修复:**
  - 构建 6 个 sub-agent（带 apiKey + hooks）
  - 注册 dispatchers Map
  - `createWiredMasterAgent()` 构建 MasterAgent
  - `createMessageHandler()` 包装 MasterAgent
  - `createApp({ messageHandler })` 接入 chat 路由
  - `availableTools` 从 `masterToolDefinitions` 提取真实工具名

### W8: Services 暴露
- **文件:** `server.ts`
- **修复:** `createApp()` 返回 `app.services` 含 sessionManager、taskRegistry、eventBus、eventBusHook、skillContracts

---

## 四、设计文档偏离修复 (5 项)

### D1: Runtime Session 持久化
- **文件:** `apps/agent/src/agents/runtime.ts`
- **问题:** `NativeAPIRuntime` 是无状态 tool-use loop，无法记录对话历史
- **修复:**
  - 添加 `SessionCallbacks` 接口 + `setSessionCallbacks()` 方法
  - `run()` 中三个回调点：user message / assistant response / tool results
  - Optional chaining 保证无回调时不影响现有代码

### D2: ProjectContext videoAnalysis 版本化
- **文件:** `apps/agent/src/context/project-context.ts`
- **问题:** `scenes: any[]`，无版本化字段，无法检测过期分析
- **修复:**
  - `scenes` 改为 `Array<{ start: number; end: number; description: string }>`
  - 添加 `sourceStorageKey`、`analyzedAtSnapshotVersion`、`lastAnalyzedAt`
  - 添加 `updateVideoAnalysis()` 方法
  - 2 个新测试

### D3: Memory 因果追踪字段
- **文件:** `apps/agent/src/memory/memory-extractor.ts`, `memory/types.ts`
- **问题:** 创建 memory 时不写 `created_session_id`、`last_reinforced_session_id`
- **修复:**
  - `MemoryExtractor` 构造函数接受 `sessionId`
  - `handleRejection` / `handleExplicitInput` 写入 `created_session_id`
  - `handleApproval` reinforcement 时更新 `last_reinforced_session_id`
  - 3 个新测试

### D4: Exploration 状态机
- **文件:** `apps/agent/src/exploration/exploration-engine.ts`
- **问题:** 无状态机，`void skeleton.commands` 丢弃 commands，preview pipeline 断裂
- **修复:**
  - 8 状态生命周期：`queued → running → partial → completed → user_selected → applied | cancelled | expired`
  - `VALID_TRANSITIONS` 状态转移表 + `transition()` 方法强制合法转移
  - Commands 不再丢弃，通过 `executeAgentCommand()` 应用到 clone
  - Commands 传入 job payload
  - 5 个生命周期方法：`getStatus`、`getSession`、`selectCandidate`、`applySelection`、`cancel`
  - 15 个新测试

### D5: downloadToTempFile 流式下载
- **文件:** `apps/agent/src/services/object-storage.ts`
- **问题:** 整个 response body 读入内存再写文件，大文件 OOM
- **修复:** 检测 body 类型（Node.js Readable vs Web ReadableStream），用 `Readable.fromWeb()` 转换后 pipe 到 `createWriteStream`

---

## 五、Phase 4-5 Stubs 接入真实服务

### MasterAgent 工具接入
- **文件:** `apps/agent/src/agents/master-agent.ts`
- **修复:**
  - `propose_changes` → `ChangesetManager.propose()` (optional dep)
  - `explore_options` → `ExplorationEngine.explore()` (optional dep)
  - `export_video` → `TaskRegistry.createTask()` (optional dep)
  - 无依赖时保留 stub 行为（向后兼容）

### Routes DI Factory 化
- **文件:** `routes/commands.ts`, `routes/project.ts`, `routes/media.ts`
- **修复:**
  - `createCommandsRouter({ serverEditorCore })` — 版本校验 + 命令执行
  - `createProjectRouter({ contextManager })` — 返回真实 timeline state
  - `createMediaRouter({ objectStorage })` — finalize + signed URL
  - 均保留无依赖默认实例（测试兼容）

### Asset Store Drizzle Schema
- **文件:** `apps/agent/src/db/schema.ts`
- **新增 3 张表:**
  - `assets` (id, name, type, storageKey, tags, generationContext, projectId, createdAt)
  - `brandKits` (id, name, brandSlug, visualConfig, toneConfig, createdAt)
  - `skills` (id, name, agentType, content, frontmatter, skillStatus, createdAt, updatedAt)

### Asset Store API 修正
- **文件:** `assets/asset-store.ts`, `assets/brand-store.ts`, `assets/skill-store.ts`
- **问题:** `db.insert("assets", {...})` 不是 Drizzle API
- **修复:** 改为 `db.insert(assets).values({...})`，使用真实 Drizzle table 引用

---

## 六、Core ↔ Web 去重

### 统一 ID 生成
- **文件:** `packages/core/src/change-log.ts`, `packages/core/package.json`
- **修复:** `nanoid` 替换为 `generateUUID()`，移除 `nanoid` 依赖

### Web 导入切换到 @opencut/core
- **文件:** `apps/web/package.json` + 8 个 src 文件
- **修复:**
  - 添加 `"@opencut/core": "workspace:*"` 依赖
  - `capitalizeFirstLetter`, `generateUUID` 切到 core
  - `element-utils`: 7 函数 re-export from core
  - `track-utils`: 8 函数 re-export from core
  - `bookmarks`: 9 函数 + `BOOKMARK_TIME_EPSILON` re-export from core
  - `scenes`: 切到 core 的 `generateUUID` + `calculateTotalDuration`
- **净减 336 行重复代码**
- **注意:** 返回 `TimelineTrack`/`TimelineElement` 类型的函数因 `buffer?: AudioBuffer` vs `buffer?: unknown` 差异保留本地实现

### Shared parseFrontmatter 提取
- **文件:** `apps/agent/src/utils/frontmatter.ts` (新建)
- **修复:** memory-store 和 skills/loader 的重复解析器统一到一个共享模块

---

## 七、新增测试清单 (42 个)

| 文件 | 数量 | 覆盖内容 |
|---|---|---|
| `memory-selector.test.ts` | 5 | activation_scope 组合、confidence/source/updated 单独决胜 |
| `tool-pipeline.test.ts` | 8 | pre/post-hook → onFailure、key reserve/release/commit、async await |
| `loader.test.ts` | 6 | agent_type 数组匹配 store/preset 双路径 |
| `exploration-engine.test.ts` | 15 | 状态机生命周期、commands 应用、select/apply/cancel |
| `memory-extractor.test.ts` | 3 | 因果追踪字段写入 + bun 兼容 |
| `project-context.test.ts` | 2 | updateVideoAnalysis 版本化字段 |
| bun 兼容修复 | 3 | change-log.test.ts (2) + event-bus.test.ts (1) |

---

## 八、仍未落地 (2 项)

| 项目 | 说明 | 原因 |
|---|---|---|
| Content editing pipeline | `content-editor.ts`/`generation-client.ts` 存在但未接入 agent 链路 | Phase 3 范围，需要外部生成 API (Kling/Veo/Seedance) 对接 |
| Sandbox + Preview 渲染 | ExplorationEngine 有状态机但 Daytona sandbox 和 Playwright 渲染未实现 | 需要基础设施部署（Daytona sandbox pool + Playwright headless） |

---

## 九、最终验证

```
packages/core:  18 tests, 18 pass, 0 fail
apps/agent:    207 tests, 207 pass, 0 fail
apps/web:       88 tests, 88 pass, 0 fail
TypeScript:     0 new errors (2 pre-existing in next.config.ts + v5-to-v6.test.ts)
─────────────────────────────────────────
Total:         313 tests, 313 pass, 0 fail
```
