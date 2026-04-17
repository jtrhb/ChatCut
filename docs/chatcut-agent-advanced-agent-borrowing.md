# ChatCut Agent 向 Advanced Agent 借鉴点研究

日期：2026-03-31

## 研究范围

本轮对照同时参考了四类材料：

- `advanced agent/` 本地实现
- `apps/agent/src/` 当前实现
- `docs/chatcut-agent-system.md`、`docs/chatcut-architecture.md`、`docs/chatcut-memory-layer.md`、`docs/chatcut-fanout-exploration.md`
- 外部研究文档：[tvytlx/claude-code-deep-dive](https://github.com/tvytlx/claude-code-deep-dive)

其中，deep dive README 明确给出的总判断是：Claude Code 的强项不是某一段 prompt，而是一整套把 prompt、tool、permission、agent、skill、plugin、hook、MCP、cache 和产品体验统一起来的 Agent Operating System。这个判断和本地 `advanced agent/` 的代码结构是吻合的：`query.ts`、`constants/prompts.ts`、`tools/AgentTool/runAgent.ts`、`services/tools/toolExecution.ts`、`services/tools/toolHooks.ts`、`memdir/`、`tasks/`、`plugins/` 都围绕“平台级 agent runtime”而不是“一次性调用器”搭建。

## 当前 ChatCut Agent 的真实基线

先给一个基线判断，避免后续比较失焦。

`apps/agent/` 不是空白工程。它已经有：

- 多 agent 骨架：`src/agents/master-agent.ts`、`src/agents/editor-agent.ts`、`src/agents/vision-agent.ts` 等
- 共享上下文骨架：`src/context/project-context.ts`
- tool 权限与调用日志基础：`src/tools/executor.ts`
- changeset 审批基础：`src/changeset/changeset-manager.ts`
- fan-out 雏形：`src/exploration/exploration-engine.ts`
- memory 读写与抽取基础：`src/memory/memory-loader.ts`、`src/memory/memory-extractor.ts`、`src/memory/pattern-observer.ts`
- 队列基础：`src/services/job-queue.ts`

但它距离文档里设想的目标态还有明显距离。最典型的差异是：

- 文档已经把 `session`、`hooks`、`ClaudeSDKRuntime`、`taskState`、`in-process MCP`、`fan-out async loop` 说得很具体了，代码里大多还没落地
- `src/routes/chat.ts`、`src/routes/status.ts`、`src/routes/events.ts`、`src/routes/changeset.ts` 目前仍偏占位
- `src/agents/runtime.ts` 还是单次 `run(config, input)` 的最小 tool-use loop

所以，这份文档不是单纯比较 “advanced agent 有什么，ChatCut 没什么”，而是分成三层看：

1. advanced agent 已验证的成熟设计
2. ChatCut 文档已经意识到、但代码尚未实现的方向
3. 真正值得现在借鉴并进入实施队列的点

## 精细思考循环

下面按轮次展开。每一轮都包含四个部分：

- Advanced Agent 学到了什么
- ChatCut 当前代码在哪里
- ChatCut 自己文档是否已经想到
- Master 结论

---

## Round 1：从“Agent 调用器”升级到“Agent OS”

### Advanced Agent 学到了什么

advanced agent 的顶层结构本身就在表达平台化思维。deep dive README 把它概括为：

- Prompt 是模块化 runtime assembly
- Tool 走 permission / hook / analytics / MCP-aware execution pipeline
- Agent 是 built-in / fork / subagent 的分工系统
- Plugin、Skill、MCP 共同组成扩展平面

本地代码也能印证这一点：`advanced agent/query.ts`、`advanced agent/constants/prompts.ts`、`advanced agent/tasks/`、`advanced agent/plugins/`、`advanced agent/memdir/` 是并列核心模块，而不是围着一次 `messages.create()` 打补丁。

### ChatCut 当前代码在哪里

`apps/agent/` 当前更像“多 agent 服务端样机”：

- `src/server.ts` 暴露若干 HTTP route
- `src/agents/master-agent.ts` 负责调度固定的五类 sub-agent
- `src/agents/runtime.ts` 负责最基础的 Claude tool-use loop

也就是说，当前中心仍是“如何完成一次 agent 请求”，还不是“如何让 agent 成为一个长期运行、可恢复、可扩展的平台”。

### ChatCut 文档是否已经想到

想到了，而且很早就想到了。`docs/chatcut-agent-system.md` 已经把 runtime contract、session、hooks、MCP、taskState 都写进目标架构。

### Master 结论

第一性借鉴点不是某个局部技巧，而是心智切换：后续建设不能再把 `apps/agent/` 当作“AI route 集合”，而要当成 `OpenCut Agent Runtime`。这会直接影响接下来 session、事件流、skills、memory、任务系统的设计边界。

---

## Round 2：System Prompt 必须模块化，而不是每个 agent 手工拼字符串

### Advanced Agent 学到了什么

`advanced agent/constants/prompts.ts` 不是一份固定 prompt，而是一个“提示词总装机”：

- system section、task section、hooks section、language section、output style section、MCP instruction section 都是独立模块
- 还显式区分静态边界和动态边界，服务于 prompt cache
- `advanced agent/tools/AgentTool/prompt.ts` 进一步把 agent tool 的说明拆成共享部分、fork 说明、when-not-to-use、examples 等块

### ChatCut 当前代码在哪里

ChatCut 目前的 prompt 构造仍然偏原始：

- `src/agents/master-agent.ts`：只把 timeline、memory、recent changes 拼进 prompt
- `src/agents/editor-agent.ts`、`src/agents/creator-agent.ts`、`src/agents/audio-agent.ts` 等：每个 agent 都是手写 `buildSystemPrompt()`

这会带来几个问题：

- 重复逻辑会快速扩散
- 很难做统一升级，例如语言偏好、输出风格、权限提醒、skill 注入
- 后续如果要做 session resume / compaction，很难知道哪些段落应该持久，哪些段落应该重建

### ChatCut 文档是否已经想到

部分想到。文档强调了 memory、timeline、recent changes、skills 应注入 system prompt，但没有把“prompt section registry”明确成一个实现层模块。

### Master 结论

这轮最值得借鉴的不是 prompt 内容，而是 prompt 装配方式。建议尽快把各 agent 的 `buildSystemPrompt()` 收敛成统一的 section-based builder，至少拆出：

- static identity
- runtime state
- memory/skills
- recent changes
- task-specific instructions
- safety / output policy

否则后面所有能力都会在 prompt 层重复施工。

---

## Round 3：Query Loop 需要预算、压缩、恢复，而不是只会重复调 API

### Advanced Agent 学到了什么

`advanced agent/query.ts` 是一个真正的主循环：

- token budget 跟踪
- auto compact / reactive compact
- max output token 恢复
- tool summary
- attachment / memory prefetch
- stop hook 与 continuation transition

也就是说，模型调用不是“一个 while 循环”，而是“一个可恢复、可自我修正的查询状态机”。

### ChatCut 当前代码在哪里

`apps/agent/src/agents/runtime.ts` 现在只有：

- `messages.create()`
- 检查 `end_turn`
- 执行 tool use
- 到达 `maxIterations` 就结束

它没有：

- compaction
- session restore
- token budget 的真正治理
- output/token 异常恢复
- tool 结果摘要
- turn continuation 的因果信息

### ChatCut 文档是否已经想到

是。`docs/chatcut-agent-system.md` 已明确把 `ClaudeSDKRuntime` 的 compaction / session / hooks 列为目标能力，并把 `NativeAPIRuntime` 定义为 fallback。

### Master 结论

这轮的结论很明确：文档方向没有问题，问题在于实现停在了 fallback 的起点。短期不一定要等官方 SDK 全量接入，但至少要把 `QueryEngine` 抽出来，而不是让 `NativeAPIRuntime` 永远维持“最小 loop”形态。最优先该补的是：

- budget accounting
- recoverable stop reasons
- tool result summarization
- conversation compaction 边界

---

## Round 4：Tool Execution 应该是流水线，而不是一次 execute()

### Advanced Agent 学到了什么

`advanced agent/services/tools/toolExecution.ts` 和 `advanced agent/services/tools/toolHooks.ts` 展示了一条成熟的工具执行链：

- permission decision
- pre-tool hooks
- tool execution
- post-tool hooks
- failure hooks
- tracing / analytics
- MCP-aware 处理
- error classification
- permission reason 不是只看“哪个 agentType”，而是综合 rule、mode、hook、side effect 语义

这让 tool 不只是“函数调用”，而是“可治理的执行单元”。

### ChatCut 当前代码在哪里

`apps/agent/src/tools/executor.ts` 已经有不错的起点：

- tool registry
- agentType 权限校验
- Zod schema 校验
- call log

但仍明显缺少：

- pre / post hooks
- tool 级 tracing
- 幂等键与 side-effect 分类
- 区分用户拒绝、配置拒绝、hook 阻断、运行时失败
- 区分“能否调用某工具”和“这次调用是否触发高风险动作”
- 不同 tool 类型的差异化策略

### ChatCut 文档是否已经想到

是。`docs/chatcut-agent-system.md` 多次提到 hooks、权限校验、非幂等 tool 要带 `idempotencyKey`、不同 Tier 的 side effect 分类。

### Master 结论

这一轮是最高优先级借鉴点之一。`ToolExecutor` 现在不该继续长成“大 switch”，而应升级成 staged pipeline。推荐顺序是：

1. preflight: permission + idempotency + access mode
2. pre-hook
3. execute
4. post-hook / failure-hook
5. tracing / audit log

这里尤其要补一层“动作语义权限”，例如只读分析、时间线写入、外部生成、导出、跨项目写入不应只靠 tool name 粗分。否则后面 changeset、审批、恢复和扩展性都很难解耦。

---

## Round 5：Sub-agent 不应只有“固定五个 dispatch”，而要有 fork / fresh / continuation 语义

### Advanced Agent 学到了什么

`advanced agent/tools/AgentTool/prompt.ts` 和 `advanced agent/tools/AgentTool/runAgent.ts` 的核心价值，不只是“能开子代理”，而是把不同子代理语义说清楚了：

- fresh subagent：零上下文，适合独立视角
- fork：继承上下文，适合并行研究或实现
- 每个 agent 有自己允许的 tools / 禁止的 tools / MCP server
- agent tool 的提示词里还专门教主代理何时 fork、何时不要 peek、何时不要猜结果
- 除了领域 agent，还内建 explore / plan / verification 这类横切 specialist

### ChatCut 当前代码在哪里

ChatCut 当前的子代理机制是固定映射：

- `dispatch_editor`
- `dispatch_vision`
- `dispatch_creator`
- `dispatch_audio`
- `dispatch_asset`

`src/agents/master-agent.ts` 通过 `DISPATCH_ROUTES` 找到 dispatcher，然后加写锁或直接执行。这种做法简单，但表达能力非常有限。

### ChatCut 文档是否已经想到

部分想到。文档里已经有 `needsAssistance`、`taskState`、`taskId` 隔离、重新 dispatch continuation 的设想，但代码里还没有真正的 continuation 语义。

### Master 结论

这轮不建议照搬 Claude Code 的“通用 agent marketplace”，但必须借鉴它对 agent 语义的区分。对 ChatCut 而言，至少要补三种 dispatch 模式：

- fresh specialist：例如独立 vision 分析
- forked continuation：带着当前任务上下文分叉探索
- resumed continuation：恢复之前未完成的子任务

同时不应只保留 editor / vision / creator 这类领域 agent，还应该逐步补上 explore / verify / review 这类横切 specialist。否则 `needsAssistance` 和 `taskState` 最终会沦为文档概念，进不了真正执行链。

---

## Round 6：Session Lifecycle 是一等公民，不应继续停留在占位 `sessionId`

### Advanced Agent 学到了什么

advanced agent 对 session 的重视非常彻底：

- `runAgent.ts` 会处理 agent 上下文、缓存、MCP、hooks、transcript 等
- `advanced agent/commands/session/session.tsx`、`advanced agent/utils/sessionRestore.ts`、`advanced agent/remote/RemoteSessionManager.ts` 表明 session 不是附属状态，而是产品对象
- deep dive 也强调它有面向 CLI、MCP、SDK 的多入口 session 语义

### ChatCut 当前代码在哪里

ChatCut 现在最典型的落差在这里：

- `src/routes/chat.ts` 对合法输入只返回 `{ status: "processing", sessionId: "placeholder" }`
- `src/routes/status.ts` 只返回 `{ agentStatus: "idle", activeChangesets: 0 }`
- `src/agents/runtime.ts` 没有 create / restore / resume / fork 概念

### ChatCut 文档是否已经想到

明确想到了。`docs/chatcut-agent-system.md` 把 `saveSession()`、`restoreSession()`、session 持久化、taskState 恢复都写进了运行时契约。

### Master 结论

这是目前“文档与实现落差最大”的点之一，也是最该补的基础设施之一。建议把 `AgentRuntime` 扩成真正的 session contract，而不是只保留 `run()`：

- `createSession`
- `resumeSession`
- `forkSession`
- `saveSession`
- `listSessions`

如果没有这一层，后续的 memory、background tasks、human-in-the-loop 都只能做表面集成。

---

## Round 7：异步任务要统一建模，而不是“有队列但没有任务控制面”

### Advanced Agent 学到了什么

advanced agent 的 `tasks/` 不是一个零散目录，而是一个统一任务平面：

- local shell task
- local agent task
- remote agent task
- workflow task
- dream task
- 统一 background task 判定

这说明“后台化”不是某一个功能，而是 agent runtime 的通用能力。

### ChatCut 当前代码在哪里

ChatCut 这边已经有两块苗头：

- `src/services/job-queue.ts`：有 pg-boss 队列
- `src/exploration/exploration-engine.ts`：会把 preview-render 入队

但控制面几乎是空的：

- `src/routes/events.ts` 只会发一个 `connected`
- `src/routes/status.ts` 不表达 exploration、generation、export、resume、background jobs

### ChatCut 文档是否已经想到

想到了。`docs/chatcut-fanout-exploration.md` 已经把状态机、SSE、异步入队、逐步返回写得很完整。

### Master 结论

这里的借鉴重点不是“也做一个 tasks 目录”，而是统一任务模型。ChatCut 应尽快把两类任务区分清楚：

- agent 内任务：探索、分支分析、子代理协作
- 外部副作用任务：生成、渲染、导出

然后通过同一个 task control plane 暴露状态、恢复、取消和结果订阅。否则队列只会成为“后端内部细节”，不会成为可操作系统的一部分。

---

## Round 8：Memory 不是“多读几份 markdown”，而是“索引 + 类型学 + 自动沉淀”

### Advanced Agent 学到了什么

advanced agent 在 memory 上最值得借鉴的点有三个：

- `advanced agent/memdir/memdir.ts`：强调 `MEMORY.md` 作为入口索引，并限制尺寸，保证可持续读取
- `advanced agent/memdir/memoryTypes.ts`：明确“应该记什么 / 不应该记什么”
- `advanced agent/memdir/findRelevantMemories.ts`：对 memory manifest 做二次筛选，只取少量高相关记忆

再加上 session memory 相关模块，它不是简单的“长期存储”，而是带主动提炼机制的长期上下文系统。

### ChatCut 当前代码在哪里

ChatCut 在 memory 上其实已经走得比别的模块更深：

- `src/memory/memory-loader.ts` 有 scope merge、activation scope、budget truncation
- `src/memory/memory-extractor.ts` 有 rejection / approval 驱动的 memory 写入
- `src/memory/pattern-observer.ts` 有从 memory 结晶 skill 的思路
- `docs/chatcut-memory-layer.md` 的设计也非常完整

但短板也很明确：

- 缺一个低成本入口索引层
- 缺一个“当前 query 只该取哪几份记忆”的 selector
- 缺 session memory 摘要 worker

### ChatCut 文档是否已经想到

大部分想到了，但实现只覆盖了读写基础，还没有进入“自动沉淀 + 选择性注入”的成熟阶段。

### Master 结论

这一轮不是大改方向，而是补齐 memory 的操作系统层。优先借鉴的顺序应是：

1. memory index / manifest
2. relevant memory selector
3. session summary memory

这样 memory 才会从“知识文件夹”升级成真正能支撑长期协作的认知层。

---

## Round 9：Skill 要从“提示文本”进化成“执行期契约”

### Advanced Agent 学到了什么

`advanced agent/skills/loadSkillsDir.ts` 的关键不在于“能加载 markdown”，而在于 frontmatter 会影响运行期：

- `allowed-tools`
- `model`
- `hooks`
- `effort`
- `executionContext`
- `agent`

这意味着 skill 不只是告诉模型“怎么做”，而是在约束“能做什么、怎么做、何时做”。

### ChatCut 当前代码在哪里

ChatCut 目前的 skill 机制还比较轻：

- `src/skills/loader.ts` 会从 R2 `_skills/` 或本地 `presets/` 读取 markdown
- 过滤条件主要是 `agent_type` 和 `skill_status`
- `pattern-observer.ts` 虽然会结晶 skill，但产物仍接近 memory 文本

换句话说，skill 现在更像“可注入知识”，还不是“可执行工作流单元”。

### ChatCut 文档是否已经想到

想到了方向。`docs/chatcut-architecture.md` 已经把 skill 定义为比 tool 更高阶的知识/工作流复用层，但实现契约还没有成型。

### Master 结论

这是非常适合借鉴、且不需要一次做太大的模块。建议先扩 frontmatter contract，而不是先做 plugin marketplace。首批字段就足够：

- `agent_type`
- `allowed_tools`
- `effort`
- `when_to_use`
- `hooks`
- `execution_context`

只要 skill 能真实影响运行时，后续再谈 skill 自动结晶、A/B 对比、品牌级 skill 复用才有意义。

---

## Round 10：Plugin / MCP 不只是“多接几个工具”，而是扩展平面

### Advanced Agent 学到了什么

advanced agent 的 plugin 和 MCP 体系很成熟：

- `advanced agent/utils/plugins/pluginLoader.ts` 支持插件目录、manifest、commands、agents、hooks
- `advanced agent/services/mcp/` 让 MCP 不只提供 tool，也提供行为说明、权限与连接管理
- deep dive 里也明确把 MCP 定义为 integration plane，而不是普通工具桥

### ChatCut 当前代码在哪里

ChatCut 文档层已经接受了 in-process MCP server 这个方向，但代码层几乎还没开始：

- `docs/chatcut-agent-system.md` 把 MCP 作为 tool 注册机制
- `apps/agent/src/` 里目前没有对应的 MCP runtime / plugin integration 平面

### ChatCut 文档是否已经想到

想到了方向，但实现为零散的 provider/tool 封装，尚未形成统一扩展面。

### Master 结论

这轮我给出的判断是：现在不应该急着做“大而全插件系统”，但必须为它预留边界。对 ChatCut 更现实的借鉴方式是：

- 先把 provider / tool / brand-specific integration 统一成可注册组件
- 再把 skill / hook / MCP server 放进统一注册表
- 最后才考虑 marketplace 或外部插件包

也就是说，先要有 extension contract，再谈 extension ecosystem。

---

## Round 11：需要一个真正的 Agent Control Plane

### Advanced Agent 学到了什么

deep dive README 把 Claude Code 的命令系统称为“整个产品的操作面板”，列举了 `/memory`、`/permissions`、`/hooks`、`/plugin`、`/tasks`、`/status`、`/agents`、`/model` 等命令。这一点很重要：产品不只是让模型干活，还让用户能观察和控制 runtime。

### ChatCut 当前代码在哪里

ChatCut 现在暴露出来的控制面还很薄：

- `src/routes/status.ts` 只有 idle 和 activeChangesets
- `src/routes/events.ts` 是 SSE stub
- `src/routes/changeset.ts` 只是请求校验后直接回状态

这意味着系统虽然内部有 changeset、queue、memory、exploration 的雏形，但用户和上层 UI 还没有真正的控制面可以操作。

### ChatCut 文档是否已经想到

隐含想到了，因为 fan-out、changeset 审批、status 查询、job queue 都写了，但还没有收敛成“控制平面”这个概念。

### Master 结论

建议把 control plane 正式列为一个一级模块，而不是若干 route 的拼盘。最小闭环至少应该允许上层 UI 或 API 做这些事：

- 看当前 session / task / changeset
- 恢复中断会话
- 订阅异步结果
- 查询当前 memory / skill 注入情况
- 批准、拒绝、取消或重试某类任务

这能把 agent 从“黑盒服务”变成“可协作系统”。

---

## Round 12：Session Memory 和长期 Memory 不应混成一层

### Advanced Agent 学到了什么

advanced agent 在 memory 上不只做“长期记忆”，还区分了短期 continuity 和长期沉淀：

- `advanced agent/services/SessionMemory/sessionMemory.ts` 会异步维护当前会话摘要
- `advanced agent/services/compact/sessionMemoryCompact.ts` 会把 session memory 接入压缩与恢复链
- `advanced agent/context.ts` 把 system context、user context、session continuity 视为不同层
- `advanced agent/memdir/` 负责更长期、更可复用的记忆

### ChatCut 当前代码在哪里

ChatCut 在长期 memory 上其实不弱：

- `src/memory/memory-loader.ts`、`src/memory/memory-extractor.ts`、`src/memory/pattern-observer.ts` 已经有比较完整的长期层设计
- `docs/chatcut-memory-layer.md` 对 scope、draft、activation scope、pattern crystallization 的规划也很扎实

但短期 session continuity 基本还是空白：

- `src/agents/runtime.ts` 没有 session persistence
- `src/routes/chat.ts` 也没有真正恢复 session 的能力
- `src/context/project-context.ts` 仍偏单次 dispatch 内存态

### ChatCut 文档是否已经想到

文档层有影子，但没有正式单列成一层。现有文档更强调长期 memory，而没有把 session memory 作为独立基础设施写实装路径。

### Master 结论

这轮的关键借鉴点是：ChatCut 不能只做长期 memory，还要明确新增一层 session memory。更具体地说：

- 短期 continuity 用 session memory
- 跨项目偏好和可复用经验才进长期 memory
- compaction、resume、background task 切回前台都应该优先读取 session memory，而不是去拼长 prompt

否则“长期知识有了、当前会话反而断裂”的问题会越来越严重。

---

## Round 13：Prompt Cache Economics 与 Observability 不是豪华配置，而是运行时护栏

### Advanced Agent 学到了什么

advanced agent 不是先把所有动态能力塞进 prompt，再被动控成本；它一开始就在做两件事：

- `advanced agent/constants/prompts.ts` 通过 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 管理稳定段和动态段
- `advanced agent/services/analytics/*`、`services/tools/toolExecution.ts`、权限与 hook 模块大量埋 runtime 事件

这说明它把 prompt cache economics 和 observability 当作系统级约束，而不是事后补报表。

### ChatCut 当前代码在哪里

ChatCut 目前这些能力都很薄：

- prompt 还没有 cache-aware boundary
- timeline、recent changes、memory、skills 一旦继续增长，很容易让 prompt 成本失控
- 运行时 telemetry 基本为空白
- risky feature 也还没有 feature gate

### ChatCut 文档是否已经想到

部分想到。`docs/chatcut-agent-system.md` 已经提到 token budget、cost ceiling、重试和幂等，但还没有把 prompt cache 与 runtime observability 收敛成正式模块。

### Master 结论

这一轮不是说现在就去做一整套数据平台，而是要在主干设计里预留两个口：

- prompt section builder 必须天然支持稳定边界和 delta 注入
- runtime 必须从第一版开始记录最少量的关键事件，例如 `agent.turn_*`、`tool.*`、`dispatch.subagent`、`changeset.*`、`exploration.*`、`memory.*`

没有这层护栏，后面 session、skills、plugins、MCP 接得越多，越容易既贵又难调。

---

## Round 14：没有再发现新的一级借鉴点，后续主要是上述能力的实现细化

### Advanced Agent 学到了什么

继续往下深挖，新增内容主要落在这些已识别主题的展开变体里：

- remote / bridge / multi-surface
- plugin marketplace / installation UX
- 更复杂的权限 UI
- 更细的 analytics / growth / rollout 体系

### ChatCut 当前代码在哪里

这些方向目前大都还没落地，但它们并不构成新的“一级能力类别”，更多是前面各轮结论的产品化深化。

### ChatCut 文档是否已经想到

多数方向在文档里已经有边角影子，例如 MCP、hooks、session、background task，只是还没有进入实现层。

### Master 结论

到第 14 轮为止，可以明确判断：当前最值得借鉴的一级能力已经收敛完成。后续再继续扩展，边际收益会明显下降，讨论重点应该从“还能借什么”切换到“这些点按什么顺序落地”。

---

## 最终收敛：最值得借鉴的 10 个点

按优先级从高到低收敛如下：

1. 把 `AgentRuntime` 升级为真正的 session runtime，而不是单次 `run()`
2. 把 tool 执行改造成 staged pipeline，支持 hooks、幂等、失败分类、动作语义权限与 tracing
3. 把 prompt 构造统一为 section-based builder
4. 给 sub-agent 增加 fork / fresh / resume 三种语义，并补 explore / verify / review 型 specialist
5. 把任务系统统一建模为 control plane，而不是零散 queue
6. 给 memory 增加 index / selector / session summary 三件套
7. 把 skill 从“文本注入”升级成“执行期契约”
8. 把 event stream 做成一等输出协议，而不是 SSE stub
9. 提前为 extension contract 预留边界，再逐步长出 plugin / MCP 平面
10. 把 status、changeset、session、memory、task 汇总成统一控制面

## 推荐落地顺序

### P0：先补基础运行时

- session lifecycle：`createSession / resumeSession / forkSession / saveSession`
- event protocol：统一输出 tool、changeset、task、memory、status 事件
- tool pipeline：permission、pre/post hook、idempotency、tracing

### P1：再补认知与协作层

- prompt section builder + cache-aware boundary
- sub-agent continuation / taskState
- memory index + relevant memory selector + session memory + long-term memory 分层
- task control plane + 基础 telemetry / feature gate

### P2：最后补扩展生态

- richer skill frontmatter
- extension registry
- in-process MCP integration
- plugin surface

## 一句话总结

advanced agent 真正值得 ChatCut 借鉴的，不是某几个花哨功能，而是它把 agent 做成了一个“可持续运行、可恢复、可治理、可扩展”的系统。ChatCut 自己的文档在方向上其实已经很接近了，当前最关键的工作不是继续发明新概念，而是把文档里已经说对的那些 runtime 能力，按平台化顺序真正落地。
