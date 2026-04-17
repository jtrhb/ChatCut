# Advanced Agent 借鉴对照记录

日期：2026-03-31

## 研究范围

本轮对照同时看了四类材料：

- `advanced agent/` 本地实现，重点看 prompt、runtime、tool pipeline、permission、hooks、tasks、memory、skills、plugins、bridge。
- `apps/agent/src/` 我们当前 agent 实现，重点看真实接线状态，而不是只看设计目标。
- `docs/chatcut-agent-system.md`、`docs/chatcut-architecture.md`、`docs/chatcut-memory-layer.md`、`docs/chatcut-fanout-exploration.md`。
- 外部设计意图参考：`https://github.com/tvytlx/claude-code-deep-dive`。

由于当前会话没有平台级 `spawn_agent` 工具，本次采用“独立分析通道 + master 汇总”方式代替真正子代理：

- 通道 A：advanced runtime / prompt / tool / permission。
- 通道 B：advanced memory / skills / plugins / session / task。
- 通道 C：本地 `apps/agent` 实现现状与 docs 目标落差。

## 当前状态快照

先给结论：`apps/agent/` 现在更接近“架构骨架 + 若干底层模块已成型”，距离产品级 agent runtime 还有明显距离。

已经有价值的底座：

- 共享上下文与并发互斥：`apps/agent/src/context/project-context.ts`、`apps/agent/src/context/write-lock.ts`
- 变更审批骨架：`apps/agent/src/changeset/changeset-manager.ts`
- 工具 schema 与执行器骨架：`apps/agent/src/tools/executor.ts`
- 长期 memory 底座：`apps/agent/src/memory/memory-loader.ts`、`apps/agent/src/memory/memory-extractor.ts`、`apps/agent/src/memory/pattern-observer.ts`
- 异步任务与幂等基础：`apps/agent/src/services/job-queue.ts`、`apps/agent/src/services/content-editor.ts`
- 数据库表已经预留了 session / exploration / pending changeset：`apps/agent/src/db/schema.ts`

明显还只是骨架或未接通的部分：

- `/chat` 仍是 placeholder：`apps/agent/src/routes/chat.ts`
- Master runtime 只有最薄的一层 prompt 拼接与 dispatch：`apps/agent/src/agents/master-agent.ts`
- `NativeAPIRuntime` 只有基础 tool loop，没有 compaction、session persistence、error recovery、hook integration：`apps/agent/src/agents/runtime.ts`
- `explore_options`、`propose_changes`、`export_video` 在 Master 里仍是 stub：`apps/agent/src/agents/master-agent.ts`
- `ExplorationEngine` 还没有真正物化 commands 和 preview pipeline：`apps/agent/src/exploration/exploration-engine.ts`

## 精细思考循环

### Round 1：Prompt 不是字符串，而是可编排运行时资源

Advanced 侧观察：

- `advanced agent/constants/prompts.ts` 把 system prompt 视为装配系统，而不是一段长字符串。
- `advanced agent/constants/systemPromptSections.ts` 把 prompt section 做成可缓存、可失效、可按会话动态注入的单元。
- deep dive README 的核心判断也是“prompt assembly architecture”，不是“神秘 system prompt”。

我们当前状态：

- `apps/agent/src/agents/master-agent.ts` 的 `buildSystemPrompt()` 只是把 timeline、memory、recentChanges 顺序拼接。
- 各 sub-agent prompt 也都是单文件字符串模板：如 `apps/agent/src/agents/editor-agent.ts`、`apps/agent/src/agents/vision-agent.ts`。
- 没有 section 级 cache、没有动态边界、没有 prompt budget 管理。

可借鉴点：

- 给 ChatCut 建一个 `prompt sections` 层，把静态部分和动态部分拆开。
- 静态部分至少包括：角色、工具语法、审批原则、编辑哲学。
- 动态部分至少包括：timeline 摘要、recent change delta、memory injection、当前 pending changeset、exploration 状态。
- 在模型调用前做 section 级裁剪，而不是超长后再整体截断。

Master 判断：

- 这是 P0。因为它会同时改善 token 开销、稳定性、后续 feature 扩展能力。

### Round 2：真正的 runtime 核心是 query loop，不是一次 `messages.create()`

Advanced 侧观察：

- `advanced agent/query.ts` 是完整的 turn loop，包含 token budget、reactive compact、withheld errors、tool summary、stop hooks、continuation 等状态机。
- `advanced agent/services/tools/toolExecution.ts` 与 query loop 是一体化设计，不是简单的“tool call -> tool result”。

我们当前状态：

- `apps/agent/src/agents/runtime.ts` 是最基础的 while-loop。
- 没有 `saveSession()` / `restoreSession()`，虽然后者在 `docs/chatcut-agent-system.md` 里是明确目标。
- 没有自动 compaction，没有恢复机制，没有 stop reason 分类，没有中间错误恢复策略。

可借鉴点：

- 先不要急着整体切 Claude SDK；先在本地抽一个 `TurnController`。
- 这个 controller 至少统一处理：token accounting、max iteration/retry policy、stop reason classification、tool error recovery、session snapshot。
- 把 `AgentRuntime` 从“调用一次模型”提升为“执行一个完整回合”。

Master 判断：

- 这是 P0 中的核心骨架。没有这一层，后面权限、任务、session 都只能零散拼接。

### Round 3：Tool 调度应该有并行语义，而不是一律串行

Advanced 侧观察：

- `advanced agent/services/tools/toolOrchestration.ts` 会按 `isConcurrencySafe` 把工具调用分成并行批次和串行批次。
- read/search 类工具可以并发，写类工具保守串行。

我们当前状态：

- `apps/agent/src/agents/runtime.ts` 对所有 `tool_use` 顺序执行。
- `apps/agent/src/tools/types.ts` 只有 `accessMode`，没有并发安全语义。

可借鉴点：

- 给 `ToolDefinition` 增加 `isConcurrencySafe` 或 `concurrencyClass`。
- 对 `get_timeline_state`、`preview_frame`、vision read tools、asset read tools、memory read tools 开并发。
- 对 timeline mutation、changeset proposal、generation trigger 保持串行。
- 这会直接提升 fan-out 前的搜索/分析效率，也更符合 multi-agent 读多写少的真实行为。

Master 判断：

- P0.5。难度不高，但收益很直接。

### Round 4：权限不该只是 `agentType` allowlist，而应该是统一判定系统

Advanced 侧观察：

- `advanced agent/hooks/useCanUseTool.tsx` 与 `advanced agent/utils/permissions/permissions.ts` 把权限收敛成统一的 `allow / ask / deny` 决策。
- 决策理由可来自 rule、hook、mode、classifier、async agent、sandbox override 等多个来源。

我们当前状态：

- `apps/agent/src/tools/executor.ts` 的权限只有“这个 agentType 能不能调这个 tool”。
- `docs/chatcut-agent-system.md` 已经明确提到权限、Tier 1/2/3、副作用分级、review lock，但代码里还没有对应统一层。

可借鉴点：

- 定义 `PermissionResult`，至少包含：`behavior`、`reason`、`updatedInput?`。
- 决策输入要覆盖：agentType、accessMode、project lock、pending changeset、cost budget、是否跨项目、是否外部副作用、是否可逆。
- 把 Creator/Audio 的生成类操作纳入同一权限框架，而不是工具自己各管各的。

Master 判断：

- 这是从“能跑”升级到“可控”的关键。尤其 ChatCut 有生成费用和不可逆导出，不能继续停留在 allowlist。

### Round 5：Hook 是产品策略注入点，不是锦上添花

Advanced 侧观察：

- `advanced agent/services/tools/toolHooks.ts` 提供了 pre/post/failure hook。
- `advanced agent/utils/hooks/sessionHooks.ts` 甚至支持 session-scoped function hook。

我们当前状态：

- 本地 docs 多次提到 hooks，但 `apps/agent/src` 还没有成体系的 hook 层。
- 现在很多策略只能塞进 tool executor、route handler、或 future 的 runtime 里，容易扩散。

可借鉴点：

- 用 hook 统一承接以下策略：
  - timeline 写前的 review lock / stale snapshot 检查
  - changeset 边界自动记录
  - generation 任务的 idempotencyKey 注入与校验
  - memory signal 抽取
  - audit / telemetry
- 先做 session 内 hooks，不必一步到位做插件可扩展 hooks。

Master 判断：

- 这是 P1，但应该在 runtime/permission 设计时一起预留接口，否则后面会反向侵入所有工具实现。

### Round 6：Sub-agent 不应只是一组固定类，而应有“专业 agent + fork agent + 临时 agent”分层

Advanced 侧观察：

- `advanced agent/tools/AgentTool/AgentTool.tsx`、`runAgent.ts`、`prompt.ts` 说明它的 agent 系统不是固定几类 worker，而是一个可扩展的 agent launching plane。
- 内建了 `Explore`、`Plan`、`Verification` 等 built-in agents：`advanced agent/tools/AgentTool/builtInAgents.ts`
- `advanced agent/tools/AgentTool/built-in/exploreAgent.ts` 还明确给了 read-only specialist 合同。

我们当前状态：

- `apps/agent/src/agents/*-agent.ts` 是固定的五个领域 agent 加一个 master。
- dispatch 关系硬编码在 `apps/agent/src/agents/master-agent.ts`。
- 这对 MVP 足够，但会把“探索/验证/审查/查找 memory”这类横切任务全部挤回 master。

可借鉴点：

- 保留当前五个领域 agent。
- 额外引入 2-3 个轻量 specialist：
  - `explore`：只读分析 timeline / media / docs / memory
  - `verify`：验证生成结果、对比 before/after、检查 changeset 风险
  - `review`：面向 human-in-the-loop 的风险摘要
- 再往后，允许 master“fork 自己”的只读子回合，用于短分析任务，不必每次都走完整 agent registry。

Master 判断：

- P1。它比一次性扩成插件化 agent 更实际，也更符合 ChatCut 的任务分层。

### Round 7：Background task / session / notification 是长任务 agent 的基础设施

Advanced 侧观察：

- `advanced agent/tasks.ts` 与 `advanced agent/tasks/LocalAgentTask/LocalAgentTask.tsx` 已经把 agent 当作 task 管理，带进度、通知、输出路径、前后台切换。
- `advanced agent/bridge/createSession.ts` 则把 session 继续扩到 remote bridge 与 resume 能力。

我们当前状态：

- `apps/agent/src/routes/chat.ts` 仍返回 `{ status: "processing", sessionId: "placeholder" }`。
- `apps/agent/src/db/schema.ts` 已有 `agent_sessions` 表，但还没接 runtime。
- Creator、Exploration、Export 这类天然长任务还没统一 session/task 模型。

可借鉴点：

- 尽快把 `/chat` 从 placeholder 升级成真正 session 入口。
- 统一任务模型：`chat session`、`generation job`、`exploration session`、`export job` 都挂在同一 session/task registry 下。
- 给 master/sub-agent 返回结构加上 `taskId`、`progress`、`nextAction`、`artifacts`，而不是只有纯文本。

Master 判断：

- P0.5。因为 ChatCut 的长任务天然很多，不先做 task/session，体验会一直碎裂。

### Round 8：Session memory 和长期 memory 是两层，不该混为一层

Advanced 侧观察：

- `advanced agent/services/SessionMemory/sessionMemory.ts` 在当前会话内异步维护结构化 notes。
- `advanced agent/services/compact/sessionMemoryCompact.ts` 又把 session memory 接入 compact/resume。
- `advanced agent/context.ts` 区分 system context 和 user context，并做 session 级缓存。

我们当前状态：

- 我们在长期 memory 上其实已经走得更远：`apps/agent/src/memory/memory-loader.ts`、`memory-extractor.ts`、`pattern-observer.ts` 都比很多项目扎实。
- 但短期 session memory 这一层基本没有落地。
- 结果就是：长期 knowledge 有规划，当前会话 continuity 反而薄弱。

可借鉴点：

- 新增 session-level memory，记录：
  - 当前用户意图
  - 当前 pending changeset / exploration
  - 最近成功与失败策略
  - 当前项目关键上下文摘要
- 长期 memory 继续由 approval/rejection/pattern crystallization 驱动。
- 原则：短期 continuity 用 session memory，跨项目偏好才进长期 memory。

Master 判断：

- P1。这个点对“关闭项目再回来”和“长会话 compaction”尤其关键。

### Round 9：Skill 体系不该只是“能加载 md”，而应该有完整发现、预算、触发契约

Advanced 侧观察：

- `advanced agent/skills/loadSkillsDir.ts` 用 frontmatter 管 skill 的能力、工具范围、执行上下文、effort。
- `advanced agent/tools/SkillTool/prompt.ts` 甚至控制 skill listing 的预算，避免 discovery 把 prompt 撑爆。
- 它还明确规定：匹配到 skill 时，调用 skill 不是建议，而是强约束。

我们当前状态：

- `apps/agent/src/skills/loader.ts` 已经能从 preset 和 memory `_skills/` 载入内容。
- 但 skill 还没真正成为 runtime contract。
- agent prompt 里没有强约束说“命中 skill 先调 skill”，也没有 discovery/budget 机制。

可借鉴点：

- 统一 preset skill 和 memory crystallized skill 的 frontmatter 契约。
- 在 master/sub-agent prompt 里加入 skill matching contract。
- skill listing 不要整段全文塞 prompt，只注入 name / when-to-use / short desc；正文按需展开。
- skill 不只是知识片段，还应该能携带工具范围和执行建议。

Master 判断：

- P1。我们已经有 skill 底座，不把它做成运行时一等公民会很浪费。

### Round 10：Plugin / MCP 应该被视为扩展平面，而不是以后再说的附加功能

Advanced 侧观察：

- `advanced agent/utils/plugins/pluginLoader.ts`、`services/plugins/PluginInstallationManager.ts` 把 plugin 当成 agents / commands / hooks / settings 的承载体。
- `runAgent.ts` 还能给 agent 附加自己的 MCP servers。

我们当前状态：

- `docs/chatcut-agent-system.md` 明确写了 in-process MCP server 的方向。
- 但 `apps/agent/src` 还没有真正的 MCP / plugin 接线。

可借鉴点：

- 先不要做 marketplace，先做本地插件格式。
- 插件一开始只开放三类扩展：
  - tool registration
  - skill/agent registration
  - hook registration
- 这样 Vision provider、Generation provider、Brand-specific workflow 都能逐步外置，而不是永远堆进主仓 `tools/`。

Master 判断：

- P2。方向正确，但不该抢在 runtime/session/permission 之前做重。

### Round 11：Prompt cache economics 值得尽早考虑，不然动态能力越多越贵

Advanced 侧观察：

- `advanced agent/constants/prompts.ts` 里有 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`。
- `advanced agent/tools/AgentTool/prompt.ts` 和 `SkillTool/prompt.ts` 明确在做“动态列表不要破坏 prompt cache”的工程化处理。

我们当前状态：

- 现在 prompt 还很简单，所以问题不显。
- 但一旦 ChatCut 把 memory、skills、exploration、review、MCP、plugins 都接进 prompt，token 成本会快速失控。

可借鉴点：

- 现在就给 prompt assembler 设计 cache-aware boundary。
- 不稳定清单类信息不要进核心 system prompt，优先做 reminder/attachment/delta 注入。
- 对 timeline 和 recent changes 做摘要层，不直接全量塞原始状态。

Master 判断：

- P1。不是 MVP 第一天就要做完，但架构必须现在就留口。

### Round 12：Observability / telemetry / feature gates 是 agent 系统的必要组成

Advanced 侧观察：

- `advanced agent/services/analytics/*`、`toolExecution.ts`、`permissions.ts` 到处在记工具时长、权限决策、缓存命中、插件安装、feature gate。
- 这让复杂 agent 行为可以逐步放量，而不是一次全开。

我们当前状态：

- 目前几乎没有运行时 telemetry。
- `docs/chatcut-agent-system.md` 虽然提到 cost budget、idempotency、重试等，但代码层观测仍很薄。

可借鉴点：

- 最少先打这些事件：
  - `agent.turn_started / completed / failed`
  - `tool.called / failed / duration`
  - `dispatch.subagent`
  - `changeset.proposed / approved / rejected`
  - `exploration.started / candidate_ready / selected`
  - `memory.injected / extracted / crystallized`
  - `prompt.size / compacted`
- risky feature 全部上 gate：session memory、background agents、auto-compaction、plugin loading。

Master 判断：

- P1.5。它不会直接提升能力，但没有它，后面的 agent 化升级都会变成盲飞。

### Round 13：Explore / Plan / Verify 合同，比“直接改”更适合 ChatCut 的模糊编辑场景

Advanced 侧观察：

- `advanced agent/tools/AgentTool/built-in/exploreAgent.ts` 把 explore agent 明确限制为只读、快速、多并发搜索。
- built-in `Plan` / `Verification` agent 说明 advanced 实现并不把所有任务都直接交给执行 agent。

我们当前状态：

- `docs/chatcut-fanout-exploration.md` 已经说明 ChatCut 很多请求是模糊意图。
- 但代码里 `explore_options` 还是 stub，`ExplorationEngine` 也还没闭环。
- 生成后验证能力也还没抽成独立合同。

可借鉴点：

- 把 ChatCut 的前置分析显式化：
  - 模糊请求先走 `explore` 或 `plan`
  - 高风险改动或生成内容回写前走 `verify`
- 对 ChatCut 来说，这比“master 直接让 editor/creator 落地”更稳定。
- `apps/agent/src/exploration/exploration-engine.ts` 可以成为这条链路的执行后端，但前面需要先有 agent 合同。

Master 判断：

- P1。它和 ChatCut 的产品形态高度贴合，值得尽早补齐。

### Round 14：没有再发现新的“一级借鉴点”，后续主要是上述能力的实现细化

本轮停止条件：

- 继续往 advanced agent 深挖后，新增内容大多是前面主题的展开变体，而不是新的一级能力。
- 例如 remote bridge、marketplace、自定义 workflow、team swarms，本质都可归入“多表面 task/session”或“插件扩展平面”，不再单独升级为新的借鉴层级。

Master 总结：

- 到 Round 13 为止，已经覆盖了当前最值得借鉴的主要设计。
- 再继续扩展，边际收益开始明显下降。

## 优先级排序

### P0：先补 runtime 主干

- Prompt assembler + section budget/cache boundary
- TurnController / query loop state machine
- tool orchestration concurrency
- unified permission result

### P1：把 agent 从“骨架”推进到“产品系统”

- session/task/background infrastructure
- session memory
- specialist agents：explore / verify / review
- skill runtime contract
- prompt cache economics

### P2：再谈生态扩展

- local plugin plane
- in-process MCP
- remote / bridge / multi-surface

## 不建议直接照搬的部分

- 不建议现在就复制 advanced agent 的完整 plugin marketplace。
- 不建议现在就复制 remote bridge / remote session 全栈。
- 不建议现在就把 agent swarms/team messaging 搬进来。

原因不是这些方向不对，而是 ChatCut 当前最短板不在这里，而在 runtime、session continuity、tool policy、exploration/verification 合同。

## 最后结论

如果只用一句话概括：

> 我们当前 `apps/agent/` 最大的问题，不是缺更多领域 tool，而是还没有把 prompt、runtime、permission、task、session、memory、skill 组织成一个真正的 agent operating layer。

advanced agent 最值得借鉴的，也正是这层“系统化编排能力”，而不是某个单独 prompt 或某个单独 agent。
