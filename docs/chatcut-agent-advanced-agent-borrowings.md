# ChatCut Agent 向 Advanced Agent 借鉴分析

## 范围与方法

本分析同时参考了四组材料：

- `advanced agent/` 本地实现
- `apps/agent/src/` 当前 ChatCut Agent 实现
- `docs/chatcut-agent-system.md`、`docs/chatcut-architecture.md`、`docs/chatcut-memory-layer.md`、`docs/chatcut-fanout-exploration.md`
- 外部研究文档：<https://github.com/tvytlx/claude-code-deep-dive>

目标不是“照搬 Claude Code”，而是判断哪些设计对 ChatCut 这种视频编辑 Agent 真正有复用价值，哪些现在就该做，哪些应该等基础设施成熟后再做。

结论先行：

- `advanced agent` 最强的不是单个 prompt，而是把 `prompt / tool runtime / permission / hook / agent lifecycle / memory / skill / plugin / task` 做成了一套统一运行时。
- `apps/agent` 目前已经有不错的骨架：`NativeAPIRuntime`、`Master + Sub-agent`、共享 `ProjectContext`、`ToolExecutor`、`ChangesetManager`、`ExplorationEngine`、`MemoryLoader`。
- 但它现在仍偏“模块集合”，还没有成长为“受控 agent runtime”。最值得借鉴的部分集中在：动态 prompt 装配、工具执行管线、子 agent 调度协议、异步任务生命周期、skills/plugins/hook 的一等公民化。

## 当前状态判断

### 已有基础

- 运行时抽象已经存在：`apps/agent/src/agents/runtime.ts`
- Master / Sub-agent 分层已经存在：`apps/agent/src/agents/master-agent.ts`
- 共享上下文骨架已经存在：`apps/agent/src/context/project-context.ts`
- Tool 注册、权限校验、调用日志已经存在：`apps/agent/src/tools/executor.ts`
- Changeset / Exploration / Memory / Skill 雏形已经存在：
  - `apps/agent/src/changeset/changeset-manager.ts`
  - `apps/agent/src/exploration/exploration-engine.ts`
  - `apps/agent/src/memory/memory-loader.ts`
  - `apps/agent/src/memory/memory-extractor.ts`
  - `apps/agent/src/skills/loader.ts`

### 主要短板

- prompt 仍然是每个 agent 手写字符串，缺少统一装配器
- tool 执行还没有 hook / policy / tracing / retry / idempotency 一体化管线
- chat / changeset 路由还只是占位壳子：
  - `apps/agent/src/routes/chat.ts`
  - `apps/agent/src/routes/changeset.ts`
- sub-agent 调度缺少“如何委派”的模型协议
- 异步任务、后台执行、恢复、摘要、通知还没有形成闭环
- skills 目前更像“读取 markdown 片段”，不是运行时工作流 primitive

## 精细思考循环

### Round 1: 动态 System Prompt 装配器

- Advanced pattern
  - `advanced agent/constants/prompts.ts` 把 system prompt 视为运行时装配资源，而不是硬编码长字符串。
  - 它显式区分静态段、动态段、语言段、memory 段、MCP 指令段、output style 段，并设置 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 做 cache 边界。
- 当前状态
  - `apps/agent/src/agents/master-agent.ts`、`editor-agent.ts`、`vision-agent.ts` 等都在手写 prompt。
  - `docs/chatcut-agent-system.md` 虽然提到 memory、recent changes、timelineState，但并没有真正抽成 prompt assembly 层。
- 可借鉴点
  - 为 ChatCut 建一个统一的 `buildAgentSystemPrompt()`，把以下输入标准化：
    - timeline snapshot
    - memory prompt
    - recent changes
    - exploration mode
    - tool policy
    - output style / response style
  - 把稳定 section 和高频变化 section 分离，为将来 prompt caching 和 compaction 做准备。
- 适配建议
  - 优先级：`P0`
  - 先做本地装配器，不必一开始就做 Anthropic 那种 cache economics，但接口形状应该一步到位。
- 证据
  - `advanced agent/constants/prompts.ts`
  - `apps/agent/src/agents/master-agent.ts`
  - `apps/agent/src/agents/editor-agent.ts`

### Round 2: Tool Runtime 不是函数调用，而是执行管线

- Advanced pattern
  - `advanced agent/services/tools/toolExecution.ts` 与 `toolHooks.ts` 展示的是完整链路：schema 校验、permission、pre-hook、tool 执行、post-hook、失败 hook、telemetry、structured result。
- 当前状态
  - `apps/agent/src/tools/executor.ts` 目前只有：
    - 查找 tool
    - 校验 agent 权限
    - Zod 校验
    - 执行
    - 记录日志
  - 这已经是好骨架，但远未形成运行时治理层。
- 可借鉴点
  - 在 `ToolExecutor` 之外增加 `ToolRuntimePipeline`：
    - pre-execution policy
    - hook interception
    - idempotency / side-effect guard
    - post-execution normalization
    - telemetry / audit events
  - 区分“可重试工具”和“有外部副作用工具”。
- 适配建议
  - 优先级：`P0`
  - 对 ChatCut 最关键的是给 `generate_video`、`generate_voiceover`、`export_video`、`explore_options` 这类外部副作用工具加 `idempotencyKey`。
- 证据
  - `advanced agent/services/tools/toolExecution.ts`
  - `advanced agent/services/tools/toolHooks.ts`
  - `apps/agent/src/tools/executor.ts`
  - `docs/chatcut-agent-system.md`

### Round 3: 子 Agent 调度需要显式“委派协议”

- Advanced pattern
  - `advanced agent/tools/AgentTool/prompt.ts` 不是普通说明，而是模型侧 delegation protocol。
  - 它清楚告诉主 agent：什么时候 fork、什么时候 fresh agent、怎么写 prompt、不要预言子任务结果。
- 当前状态
  - `apps/agent/src/tools/master-tools.ts` 定义了 `dispatch_editor` / `dispatch_vision` 等工具。
  - 但 `apps/agent/src/agents/master-agent.ts` 只告诉模型“可以调度 sub-agent”，没有告诉它“如何正确地调度 sub-agent”。
- 可借鉴点
  - 给 Master 增加一段固定 delegation contract：
    - 什么任务应直接做，什么任务应委派
    - 写给 sub-agent 的 prompt 必须包含哪些上下文
    - 何时并行 dispatch，何时串行
    - 未拿到 sub-agent 结果前不得脑补结果
  - 这会显著降低 Master 的“懒 delegation”和“空心任务描述”。
- 适配建议
  - 优先级：`P0`
  - 这是最快能提升稳定性的 prompt 级改进。
- 证据
  - `advanced agent/tools/AgentTool/prompt.ts`
  - `apps/agent/src/tools/master-tools.ts`
  - `apps/agent/src/agents/master-agent.ts`

### Round 4: fork 与 fresh sub-agent 应该是两种不同模式

- Advanced pattern
  - `advanced agent/tools/AgentTool/AgentTool.tsx` 与 `runAgent.ts` 明确区分：
    - fork path：继承上下文，适合研究/大中间结果任务
    - normal path：fresh context，适合独立专业 agent
- 当前状态
  - ChatCut 目前所有 sub-agent dispatch 都是同构的 `DispatchInput -> runtime.run()`。
  - 没有“继承上下文的同类 worker”与“重新 briefing 的专职 agent”之分。
- 可借鉴点
  - 将来至少拆成两种调度：
    - `dispatch_specialist(agentType, task, context)`
    - `fork_worker(task, inheritedContextSlice)`
  - 在 fan-out、批量 preview、素材巡检、记忆扫描这类任务里，fork worker 很有用。
- 适配建议
  - 优先级：`P1`
  - 先不做完整 worktree/remote 隔离，但应先把 API 语义分开。
- 证据
  - `advanced agent/tools/AgentTool/prompt.ts`
  - `advanced agent/tools/AgentTool/AgentTool.tsx`
  - `advanced agent/tools/AgentTool/runAgent.ts`
  - `apps/agent/src/agents/types.ts`

### Round 5: 技能不是 prompt 附件，而是运行时 primitive

- Advanced pattern
  - `advanced agent/tools/SkillTool/SkillTool.ts` 把 skill 变成一等工具，支持：
    - frontmatter metadata
    - allowed-tools
    - forked execution
    - 运行时发现与调用
  - `advanced agent/skills/loadSkillsDir.ts` 又把 skill 目录、frontmatter、hooks、model/effort hints 做成统一加载层。
- 当前状态
  - `apps/agent/src/skills/loader.ts` 现在能加载 preset 和 R2 `_skills/`，但还是“读文件然后交给 prompt”。
  - `docs/chatcut-architecture.md` 想把 skill 作为风格与工作流载体，这个方向是对的。
- 可借鉴点
  - 把 ChatCut skill 升级成“可执行 skill”而不是“被动注入文本”：
    - skill 声明适用 agent
    - skill 声明允许用哪些 tools
    - skill 声明何时自动触发
    - skill 可以作为一个子任务模板运行
  - 这样才能把“beat sync”、“viral replication”、“creator prompt routing”从 prompt 文案升级成可治理能力包。
- 适配建议
  - 优先级：`P1`
  - 先给 `SkillLoader` 增加 frontmatter 能力，再决定是否引入 `invoke_skill` 工具。
- 证据
  - `advanced agent/tools/SkillTool/SkillTool.ts`
  - `advanced agent/skills/loadSkillsDir.ts`
  - `apps/agent/src/skills/loader.ts`
  - `apps/agent/src/skills/presets/*.md`

### Round 6: Memory 要有写入纪律和索引纪律

- Advanced pattern
  - `advanced agent/memdir/memdir.ts` 对 memory 的要求很严格：
    - `MEMORY.md` 作为索引入口
    - 单文件 frontmatter 规范
    - 何时写 memory、何时不要写
    - memory 与 plan / task 的边界
    - 目录存在性与读取纪律
- 当前状态
  - `docs/chatcut-memory-layer.md` 设计得其实很强，甚至比 `memdir` 更贴业务。
  - `apps/agent/src/memory/memory-loader.ts`、`memory-store.ts`、`memory-extractor.ts` 也已有不错雏形。
  - 但当前实现缺少一个真正的“入口索引 + 渐进披露 + 写入纪律提示”层。
- 可借鉴点
  - 保留 ChatCut 的分层 memory 路由设计，但借鉴 `memdir` 的三件事：
    - 明确入口索引文件
    - 明确 Agent 何时该写 / 何时不该写 memory
    - 明确 memory 与 session plan / task 的边界
  - 否则 memory 容易被写成一堆碎片化笔记。
- 适配建议
  - 优先级：`P1`
  - 这里不建议照搬 `MEMORY.md`，更适合把 `_index.md` 真正落地到读取流程里。
- 证据
  - `advanced agent/memdir/memdir.ts`
  - `docs/chatcut-memory-layer.md`
  - `apps/agent/src/memory/memory-loader.ts`
  - `apps/agent/src/memory/memory-extractor.ts`

### Round 7: Permissions 不能只看 agentType，还要看动作语义

- Advanced pattern
  - `advanced agent/utils/permissions/permissions.ts` 的权限系统不是“谁能用哪个工具”这么简单，而是：
    - permission mode
    - allow / deny / ask rules
    - hook 影响
    - sandbox / working dir / classifier
    - 解释型 permission message
- 当前状态
  - `apps/agent/src/tools/executor.ts` 只有 `tool.agentTypes.includes(agentType)`。
  - `apps/agent/src/agents/master-agent.ts` 额外有写锁，但没有真正的 approval/policy runtime。
- 可借鉴点
  - 给 ChatCut 增加第二层权限：
    - role permission：哪个 agent 能调哪些工具
    - action permission：哪些工具调用必须进入 changeset / confirm / safe-guard
  - 例如：
    - `trim_element` 可自动执行
    - `delete_element` 需要更严格保护
    - `replace_segment` / `export_video` / 外部生成要走副作用 guard
- 适配建议
  - 优先级：`P0`
  - 这比“更强模型”更能减少事故。
- 证据
  - `advanced agent/utils/permissions/permissions.ts`
  - `apps/agent/src/tools/executor.ts`
  - `apps/agent/src/changeset/changeset-manager.ts`

### Round 8: Hook 是治理层，不只是回调点

- Advanced pattern
  - `advanced agent/services/tools/toolHooks.ts` 里的 hook 能：
    - block
    - rewrite input
    - inject extra context
    - modify MCP output
    - stop continuation
  - 这说明 hook 是 runtime policy layer，而不是 side effect callback。
- 当前状态
  - ChatCut 文档提到了 changeset interceptor、Human-in-the-Loop、Context Synchronizer。
  - 但实现层还没有真正的 hook 系统。
- 可借鉴点
  - 给 ChatCut 增加三类 hook：
    - `PreToolUse`: 拦截高风险编辑
    - `PostToolUse`: 归档 recent changes / artifact / memory signals
    - `PostToolFailure`: 产生重试建议、回退建议、用户提示
  - 这样很多跨切 concerns 就不必塞进每个 agent 里。
- 适配建议
  - 优先级：`P1`
  - 最先落地的 hook 应该服务于 changeset、memory extractor、exploration telemetry。
- 证据
  - `advanced agent/services/tools/toolHooks.ts`
  - `docs/chatcut-agent-system.md`
  - `apps/agent/src/context/context-sync.ts`
  - `apps/agent/src/changeset/changeset-manager.ts`

### Round 9: Agent 生命周期需要 task 化，而不是一次 Promise

- Advanced pattern
  - `advanced agent/tools/AgentTool/AgentTool.tsx`、`runAgent.ts`、`QueryEngine.ts` 把 agent 视为有生命周期的 task：
    - foreground / background
    - progress
    - output file
    - notification
    - cleanup
    - transcript
    - resume
- 当前状态
  - `apps/agent/src/routes/chat.ts` 只返回 `processing` 和 placeholder `sessionId`。
  - `apps/agent/src/routes/changeset.ts` 也没有接到真实 manager。
  - `NativeAPIRuntime.run()` 是一次性 loop，没有 session persistence。
- 可借鉴点
  - 为 ChatCut 引入 `AgentTask` 概念：
    - taskId / sessionId
    - status
    - progress events
    - result summary
    - resumable transcript
  - 这样 chat UI、探索、生成、审核才能并入同一 runtime。
- 适配建议
  - 优先级：`P0`
  - 这是 `chat` 路由从占位到可用的关键。
- 证据
  - `advanced agent/tools/AgentTool/AgentTool.tsx`
  - `advanced agent/tools/AgentTool/runAgent.ts`
  - `advanced agent/QueryEngine.ts`
  - `apps/agent/src/routes/chat.ts`
  - `apps/agent/src/agents/runtime.ts`

### Round 10: Fan-out 与后台任务应统一到异步作业框架

- Advanced pattern
  - deep dive 明确提到 background agent、task 通知、output 文件、异步生命周期。
  - 这不是单独为 coding task 设计的，对 ChatCut 的 exploration/render 更适用。
- 当前状态
  - `apps/agent/src/exploration/exploration-engine.ts` 和 `services/job-queue.ts` 已经走对了方向。
  - 但 `explore()` 还没有：
    - 完整物化 plan
    - 增量结果推送
    - 与主 agent task / changeset / chat session 打通
- 可借鉴点
  - 把 exploration candidate、render preview、generation poll、export job 统一纳入一个 task registry。
  - 让 UI 不只知道“有个 job”，而是知道“这是哪个 agent / 哪个 exploration / 哪个 changeset 的子任务”。
- 适配建议
  - 优先级：`P0`
  - 这是 ChatCut 最能拉开体验差距的一块，值得比普通 CRUD 更早做。
- 证据
  - `advanced agent/tools/AgentTool/AgentTool.tsx`
  - `apps/agent/src/exploration/exploration-engine.ts`
  - `apps/agent/src/services/job-queue.ts`
  - `docs/chatcut-fanout-exploration.md`

### Round 11: 验证 Agent 非常适合 ChatCut

- Advanced pattern
  - deep dive 对 Verification Agent 的总结很关键：它不是“再跑一次”，而是 adversarial validator。
  - 在 `advanced agent/tools/AgentTool/built-in/verificationAgent.ts` 也能看到这种导向。
- 当前状态
  - ChatCut 目前的 Creator / Vision / Editor 之间没有一个专门负责“验收结果”的角色。
  - `compare_before_after` 只在 Creator prompt 里被提了一句：`apps/agent/src/agents/creator-agent.ts`
- 可借鉴点
  - 新增一个轻量 `VerificationAgent` 或 `verify_result` 流程，职责包括：
    - 对比编辑前后差异是否符合用户意图
    - 检查生成片段是否破坏时序、节奏、品牌一致性
    - 给出 `PASS / FAIL / PARTIAL`
  - 这比把验证混在 Editor/Creator prompt 里更稳定。
- 适配建议
  - 优先级：`P1`
  - 尤其适合高成本生成与批量探索候选的筛选。
- 证据
  - `advanced agent/tools/AgentTool/built-in/verificationAgent.ts`
  - `/tmp/claude-code-deep-dive-readme.md`
  - `apps/agent/src/agents/creator-agent.ts`

### Round 12: 扩展面应从“技能文件”升级到“生态面”

- Advanced pattern
  - `advanced agent/plugins/builtinPlugins.ts` 与 `advanced agent/commands.ts` 说明它把 plugin / skill / command / output style / hook 统一成生态入口。
  - 不同能力不是散落加载，而是进入统一 discoverability surface。
- 当前状态
  - ChatCut 目前有：
    - preset skills
    - asset store / brand store / skill store
  - 但用户侧和 agent 侧都还没有统一扩展面。
- 可借鉴点
  - 长期看，ChatCut 可以把品牌模板、剪辑风格、平台规范、生成 provider routing、审核策略统一抽成 plugin-like 包。
  - 这样品牌团队和内部模板就不是硬编码逻辑，而是可启停、可分发的配置包。
- 适配建议
  - 优先级：`P2`
  - 这不是 MVP 必做，但对多品牌、多系列、多团队协作很有价值。
- 证据
  - `advanced agent/plugins/builtinPlugins.ts`
  - `advanced agent/commands.ts`
  - `apps/agent/src/assets/*.ts`
  - `apps/agent/src/skills/loader.ts`

## 进一步深挖后的边界判断

做到第 12 轮后，高价值借鉴点基本已经收敛，剩余还能继续挖的内容主要是：

- TUI / CLI 层交互细节
- remote / bridge / teammate swarm
- output style / analytics / telemetry 细枝末节

这些当然也有价值，但对 ChatCut 当前阶段不是最高杠杆。换句话说，现阶段最值得借鉴的精华已经基本找齐，继续深挖会开始进入“平台化豪华配置”，而不是“决定成败的主链路”。

## 最值得落地的借鉴清单

### P0: 应该优先实现

- 统一 `system prompt assembly`，替代各 agent 手写 prompt
- 为 tool 执行补齐 runtime pipeline：policy、idempotency、post-processing、audit
- 为 Master 增加显式 sub-agent delegation contract
- 将 agent 执行升级为 `task/session` 模型，打通 `chat` 路由、状态、恢复、结果
- 把 exploration / generation / export 纳入统一异步任务注册表
- 将权限从“agentType 能不能调”升级为“动作语义 + 副作用等级”

### P1: 基础稳定后跟进

- 引入 fork worker vs specialist sub-agent 双模式
- 让 skill 变成可执行工作流 primitive
- 引入 hook 作为治理层
- 引入 verification agent / verify flow
- 把 `_index.md` 真正接入 memory 读取与写入纪律

### P2: 平台化增强

- plugin-like 扩展面
- output style / response style 可配置化
- 更强的 transcript summarization / compaction
- 更细粒度 observability 与 analytics

## 推荐的第一阶段实施顺序

1. `PromptBuilder`
   - 新建统一 prompt 装配层，先接入 Master 和 Editor。
2. `AgentTaskRuntime`
   - 给 `chat` 路由、sub-agent dispatch、exploration job 一个统一任务模型。
3. `ToolRuntimePipeline`
   - 在 `ToolExecutor` 外包一层，接 permissions、changeset、memory hooks。
4. `Verification`
   - 在高成本生成链路后加验收节点。
5. `SkillRuntime`
   - 从“读 markdown”升级到“执行带 metadata 的 workflow package”。

## 一句话总结

`advanced agent` 最值得学的，不是某个“超强 prompt”，而是它把 Agent 当成了一个有协议、有治理、有生命周期的运行时系统。ChatCut 现在已经有了不错的业务骨架，下一步最该补的就是这层运行时基础设施。
