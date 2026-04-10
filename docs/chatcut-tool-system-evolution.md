# ChatCut Tool System Evolution — Finalized Spec

基于 [Harness Engineering Ch.2](https://zhanghandong.github.io/harness-engineering-from-cc-to-ai-coding/part1/ch02.html) 的 Claude Code Tool 系统架构，对照 OpenCut Agent 现状的改进方案。

**状态**: 已完成辩论，决策锁定 (2026-04-03, Codex review iteration 1 applied)
**审查**: Deep Interview → Architect Review → Critic Review → 15 Finding 逐条辩论 → Codex Review
**测试运行器**: agent 包使用 `vitest run`（非 `bun test`），验收测试需通过 `bun run test --filter @opencut/agent` 或直接 `vitest run`

---

## 0. 架构差异前提

| 维度 | Claude Code | OpenCut Agent |
|------|------------|---------------|
| 运行模式 | 单用户本地 CLI | 多会话服务端 (Bun) |
| Tool 结果流向 | 单一对话上下文 | Master → Sub-agent，各自独立 context |
| "编译期"概念 | 打包为二进制，dead-code elimination 有意义 | Runtime 服务，工具在启动时注册，无编译期 |
| Prompt cache | 单用户单前缀 | 按 session × agent-type 多前缀 |
| 延迟敏感度 | 终端交互，秒级可接受 | 视频编辑器，目标 < 200ms 响应 |

**原则**：借鉴 Claude Code 的设计思路，但每个决策必须验证是否适用于服务端多 agent 架构。

---

## 1. 结果预算控制 ✅ 已锁定

### 最终决策：Session 级 Map + 工具自定义摘要 + 序列化层分级

**溢出存储**：使用 session 级进程内 `Map<string, string>`，不使用 R2 Memory。
- 理由：工具结果是临时产物，timeline 编辑后即过期。R2 的跨 session 持久化会导致 agent 读到过期数据。
- Session 结束时 Map 自动清除，零网络延迟，零过期风险。
- Sub-agent 与 Master 共享同一进程，直接访问 Map，无需额外注入。
- **SessionId 传递**：overflow Map 按 `sessionId` 分片。`sessionId` 从 `server.ts` 的 request handler 注入到 `MasterAgent`，再通过 `TurnContext` 传递到 runtime/executor 层。`read_overflow` 工具从执行上下文获取 `sessionId` 以定位正确的 Map 分片。空闲清理定时器按 `sessionId` 独立运行。
- **字节上限**：单个 session overflow Map 上限 10MB。超限时按 LRU 淘汰最旧条目。单个结果超过 10MB 时直接拒绝存储 — 返回 summarize() 预览 + 错误提示 `"result too large for overflow (>10MB), only preview available"`。工具应通过 `summarize()` 或 `StateSerializer({ detail: "summary" })` 确保结果在合理范围内。
- **空闲清理**：session 超过 30 分钟无 tool call 时自动清空 overflow Map（防止长时间 session 或废弃 session 累积内存）。

**Timeline State 特殊处理**：`StateSerializer.serialize()` 支持 `{ detail: "summary" | "full" }` 参数。
- `summary`：元素概览（ID + 时间范围 + 类型），省略 keyframe 细节、动画参数。
- `full`：完整序列化（现有行为）。
- Agent 默认请求 summary，需要时请求 full。不靠预算截断。

**预览策略**：工具自定义 `summarize?(result: unknown): string`。
- 每个工具声明对 agent 有意义的摘要方式。
- 例：`analyze_video` 摘要 = 场景数量 + 每场景一行描述 + 总时长。
- 未声明 `summarize` 的工具用通用策略：保留 JSON 顶层 keys + 数组前 3 元素 + "...and N more"。

**预算参考**：

| 工具 | maxResultSizeChars | 理由 |
|------|-------------------|------|
| analyze_video | 20,000 | 场景描述应精炼 |
| get_timeline_state | 不适用 | 用序列化层 detail 参数控制，非预算截断 |
| dispatch_* | 30,000 | sub-agent 结果 |
| generate_video | 5,000 | 只需状态和 URL |
| 默认值 | 30,000 | 保守默认 |

### Acceptance Tests

1. 工具结果超过 `maxResultSizeChars` 时，存入 session overflow Map 并返回 `{ preview, ref, size_bytes }`。模型通过内置 `read_overflow` 工具按 `ref` 读取完整数据。`read_overflow` 始终注册（不 defer），isReadOnly=true, isConcurrencySafe=true

**`read_overflow` 工具合约**（Codex review fix）：
```ts
{
  name: "read_overflow",
  inputSchema: z.object({
    ref: z.string(),              // overflow Map 的 key
    offset: z.number().default(0), // 起始字符位置
    limit: z.number().default(30000), // 最大返回字符数，默认 30K
  }),
  // 返回值
  // {
  //   content: string,           // 请求范围内的内容
  //   total_bytes: number,       // 完整结果的总字节数
  //   offset: number,            // 当前起始位置
  //   has_more: boolean,         // 是否还有更多数据
  //   content_type: "json" | "text", // 便于模型决定是否需要完整数据
  // }
}
```
2. Session 结束后 overflow Map 为空（自动清除）
3. 声明了 `summarize()` 的工具，溢出预览使用自定义摘要而非通用截断
4. `StateSerializer.serialize({ detail: "summary" })` 返回的 JSON 体积 < 完整序列化的 60%（现有 serializer 已较紧凑，summary 主要省略 keyframe/animation/effect 参数细节）
5. `StateSerializer.serialize({ detail: "summary" })` 包含所有 element ID 和时间范围

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R1-1 (R2 过度设计) | **ACCEPTED** | Session Map 替代 R2 |
| R1-2 (100K 矛盾) | **ACCEPTED** | 序列化层 detail 参数替代预算截断 |
| R1-3 (Sub-agent 访问) | **RESOLVED** | Session Map 在进程内，共享访问 |
| R1-4 (预览不可用) | **ACCEPTED** | 工具自定义 summarize() |

---

## 2. 失败关闭默认值 + 并行执行 ✅ 已锁定

### 最终决策：静态 boolean + 两级并发 + 读-读并行

**Fail-Closed 默认值**：

```ts
// ToolDefinition 新增字段（全部 additive optional）
isReadOnly?: boolean;          // 默认 false（最保守）
isConcurrencySafe?: boolean;   // 默认 false（最保守），仅静态 boolean
```

**`isConcurrencySafe` 操作语义**（Codex review fix）：
- `isConcurrencySafe: true` = 此工具可与其他 `isConcurrencySafe: true` 工具并行执行
- `isConcurrencySafe: false`（默认）= 必须串行执行
- 调度逻辑：**顺序保留批次** — 从左到右扫描 tool_use blocks，连续的 concurrent-safe 工具合并为并行批次，遇到 sequential 工具时形成屏障。不做全局重排。详见下方"NativeAPIRuntime 调度器变更"
- 这是唯一的并行调度维度。`affectsResources` 经 Codex review 后已移除（见下方理由）

**为什么移除 `affectsResources`**（Codex review finding）：
`dispatch_editor`、`dispatch_audio` 等是通用 sub-agent 调度器，不是叶子操作。同一个 `dispatch_editor` 可能读 timeline 也可能写 timeline — 取决于自由文本的 `task` 参数。静态声明 `affectsResources: ["timeline"]` 假设了不存在的资源所有权。正确做法：所有写能力的 dispatch 串行执行，只允许读-读并行。`isConcurrencySafe` 已能表达这个语义。

**accessMode 处理**：
- `accessMode` 保留为**权威字段**，pipeline 检查继续使用 `accessMode`。
- `isReadOnly: true` 是便利语法糖，在注册时自动设置 `accessMode = "read"`。
- **冲突校验**：同时声明 `isReadOnly: true` 和 `accessMode: "read_write"` 或 `"write"` 时，注册抛 validation error。不做静默覆盖 — fail-closed。

**两级并发模型**：

| 层面 | 机制 | 职责 |
|------|------|------|
| Inter-session | `writeLock` (MasterAgent) | 保护项目状态不被多 session 并发写入破坏。**保留不动。** |
| Intra-turn | Pipeline `isConcurrencySafe` 分区 | 同一 turn 内多个 tool_use blocks 的并行策略 |

**NativeAPIRuntime 调度器变更**（Codex review fix）：

当前 `NativeAPIRuntime.run()` 逐个 await 每个 tool_use block（runtime.ts:111）。需要改为**顺序保留分区**执行。

**Runtime 需要 ToolDefinition 注册表**（Codex review fix）：当前 `AgentConfig.tools` 只携带 API 格式化后的工具。并行调度（P4）和延迟加载（P6）需要完整 `ToolDefinition` 元数据（`isConcurrencySafe`, `shouldDefer` 等）。

解决方案：`NativeAPIRuntime.run()` 新增 `turnContext` 参数（非构造函数级别）：
```ts
interface TurnContext {
  toolRegistry: Map<string, ToolDefinition>;  // 当前 turn 的完整注册表
  activeSkills: SkillContract[];               // 当前 turn 的 active skills
  filterContext: ToolFilterContext;             // isEnabled 评估上下文
}
```
每次 `handleUserMessage()` 调用 `runtime.run(config, message, turnContext)` 时注入当前 turn 的上下文。`resolve_tools` 在此 turnContext 内搜索 — 不依赖构造期固定的 registry。这确保跨 turn 的 skill/isEnabled 变化被正确反映，不会暴露错误工具。

```ts
// NativeAPIRuntime.run() — 顺序保留分区执行
// 模型可能在一个 turn 中返回: [read_A, read_B, write_C, read_D]
// 不能把 read_D 提前到 write_C 之前 — 模型可能有意让 read_D 读取 write_C 的结果
//
// 算法：从左到右扫描，连续的 concurrent-safe 工具合并为一个并行批次，
// 遇到 sequential 工具时切断并开始新批次。

const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
const batches = buildOrderPreservingBatches(toolUseBlocks, toolRegistry);

// batches 示例: [[read_A, read_B], [write_C], [read_D]]
// 第一批并行, 第二批串行, 第三批独立（只有一个元素）

for (const batch of batches) {
  if (batch.length === 1 || !batch.every(t => isConcurrencySafe(t, toolRegistry))) {
    // 串行执行
    for (const toolUse of batch) {
      await this.toolExecutor(toolUse.name, toolUse.input);
    }
  } else {
    // 并行执行
    await Promise.all(batch.map(t => this.toolExecutor(t.name, t.input)));
  }
}
```

**关键约束**：不做全局 Phase 1/Phase 2 分区。改用**顺序保留批次** — 连续的 concurrent-safe 工具并行，遇到 sequential 工具时形成屏障。这保证模型意图的执行顺序不被重排。

**各工具并发声明**：

| 工具 | isReadOnly | isConcurrencySafe | 理由 |
|------|-----------|-------------------|------|
| dispatch_vision | true | true | 纯读，无副作用 |
| dispatch_asset | true | true | 纯读，无副作用 |
| dispatch_verification | true | true | 纯推理验证 |
| dispatch_editor | false | false | 可写 timeline |
| dispatch_creator | false | false | 触发外部生成 |
| dispatch_audio | false | false | 可写 timeline |
| explore_options | true | false | 需要独占 serverCore clone |
| propose_changes | false | false | 写 changeset |
| export_video | true | false | 排队任务，幂等但不应并发 |

### Acceptance Tests（通过 `vitest run` 验证）

1. ToolDefinition 未声明 `isReadOnly` 时默认 `false`（fail-closed）
2. ToolDefinition 未声明 `isConcurrencySafe` 时默认 `false`（fail-closed）
3. `isReadOnly: true` + `accessMode: "read_write"` 在注册时抛 validation error
4. 已有工具未添加新字段时行为完全不变（零 regression）
5. 两个 `isConcurrencySafe: true` 的工具在同一 turn 中并行执行（可通过 timing assertion 或 mock executor 验证 Promise.all 调用）
6. `isConcurrencySafe: false` 的工具形成屏障 — 前一批次完成后才执行，后续批次在其完成后才开始（顺序保留断言）
7. writeLock 在 MasterAgent.handleDispatch() 中继续工作，未被移除

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R2-1 (双重锁) | **ACCEPTED** | 两级模型：writeLock (inter-session) + pipeline 顺序保留批次 (intra-turn) |
| R2-2 (TOCTOU 竞态) | **MODIFIED** | 去掉 `(input) => boolean` 形式，`isConcurrencySafe` 只用静态 boolean |
| R2-3 (模型太粗) | **MODIFIED** | 读-读并行（isConcurrencySafe 分区）。资源级冲突图经 Codex review 后移除 — dispatch_* 是通用调度器，无法静态声明资源所有权 |

---

## 3. 运行时过滤 + 排序稳定性 ✅ 已锁定

### 最终决策：isEnabled 仅限稳定条件 + formatToolsForApi 排序 + context 参数

**编译期过滤**：概念不适用。OpenCut Agent 是 runtime 服务，不存在编译期工具消除。

**isEnabled 运行时过滤**：

```ts
isEnabled?: (ctx: ToolFilterContext) => boolean;  // 默认 true

interface ToolFilterContext {
  projectContext?: Readonly<ProjectContext>;  // optional — SubAgent may not have it
  session?: AgentSession;
  env?: Record<string, string | undefined>;
}
```

**关键约束**：`isEnabled` 只用于**稳定的环境条件**，不用于动态运行状态。

| 适合 isEnabled | 不适合 isEnabled（用 descriptionSuffix） |
|---------------|---------------------------------------|
| API key 有无 | 是否有 pending changeset |
| Feature flag | 是否已有视频分析结果 |
| 用户权限等级 | Exploration 是否在进行中 |

动态条件改用 Section 5 的 `descriptionSuffix` 提示模型，让模型自己判断是否调用。

**formatToolsForApi 重设计**：

```ts
// ToolFormatContext 统一 isEnabled 和 descriptionSuffix 的输入
interface ToolFormatContext {
  filterContext: ToolFilterContext;       // 用于 isEnabled 检查
  descriptionContext: ToolDescriptionContext; // 用于 descriptionSuffix
}

export function formatToolsForApi(
  tools: ToolDefinition[],
  ctx?: ToolFormatContext,  // 可选，支持 isEnabled 过滤 + descriptionSuffix
): ApiToolFormat[] {
  let filtered = tools;
  if (ctx) {
    filtered = tools.filter(t => {
      if (!t.isEnabled) return true; // 未声明 = 启用
      try {
        return t.isEnabled(ctx.filterContext);
      } catch {
        // isEnabled 抛异常时移除工具（fail-closed）+ 记录 warning
        // isEnabled 用于 API key / 权限检查 — 异常意味着检查失败，不应暴露工具
        console.warn(`isEnabled threw for tool "${t.name}", disabling it (fail-closed)`);
        return false;
      }
    });
  }
  const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
  return sorted.map(t => formatSingleTool(t, ctx));
}
```

**调用方更新**：`MasterAgent.handleUserMessage()` (master-agent.ts:137), `SubAgent.dispatch()` (sub-agent.ts:58)。

**SubAgent ProjectContext 注入**：

```ts
// SubAgentDeps 新增
projectContext?: Readonly<ProjectContext>;
```

5 个 sub-agent 构造函数（editor, vision, creator, audio, asset）通过 deps 接收 ProjectContext，用于 isEnabled 和 descriptionSuffix。可选字段，未提供时 sub-agent 行为不变。

### Acceptance Tests

1. `formatToolsForApi(tools)` 返回按 `name` 字母排序的工具列表
2. 任意注册顺序的工具，输出排序始终一致（确定性）
3. 同一工具集的两次调用产生相同 JSON 序列化（cache key 稳定）
4. `isEnabled` 返回 false 的工具不在输出列表中
5. `isEnabled` 接收的 `ToolFilterContext` 在 MasterAgent 和 SubAgent 中均可用
6. SubAgent 未提供 ProjectContext 时继续正常工作（backward compatible）

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R3-1 (过期检查) | **ACCEPTED** | isEnabled 仅限稳定条件，动态条件用 descriptionSuffix |

---

## 4. 延迟加载 — Master 层 ✅ 已锁定

### 最终决策：Master 层 defer + Sub-agent 全量 + NativeAPIRuntime 多轮循环

**Sub-agent 工具不 defer**。工具数量有限（Editor 16 个 ≈ 5K tokens），token 节省微乎其微。避免 schema 知识断裂（batch_edit 与操作数）和 round-trip 延迟。

**Master 层 defer**：当 Master 工具增长到 20+ 时启用。

```ts
// ToolDefinition 新增
shouldDefer?: boolean;    // 默认 false
searchHint?: string;      // deferred 时的一行提示
```

Deferred 工具在 system prompt 中以名称 + hint 列出，不在 `tools` API 参数中。

**isEnabled + skill 联动**（Codex review fix）：deferred 工具的 system prompt 列表和 `resolve_tools` 搜索结果受**双重过滤**：
1. 先 `isEnabled` 过滤 — `isEnabled(ctx) === false` 的工具不出现在任何列表中
2. 再 skill 过滤 — `resolve_tools` 只在当前 active skill 的 allowed/denied 约束内搜索，不暴露被 skill 限制的工具

过滤顺序：全量工具集 → isEnabled 过滤 → skill allowed/denied 过滤 → deferred 列表 / resolve_tools 搜索范围。防止通过 `resolve_tools` 绕过 skill 级工具限制。

**resolve_tools 内部工具**：

```ts
{
  name: "resolve_tools",
  description: "Load full schema for deferred tools by name or keyword search",
  inputSchema: z.object({
    names: z.array(z.string()).optional(),
    search: z.string().optional(),
  }).refine(d => d.names?.length || d.search, {
    message: "At least one of 'names' or 'search' is required",
  }),
  isReadOnly: true,
  isConcurrencySafe: true,
  shouldDefer: false,
}
```

**NativeAPIRuntime 多轮循环**：

`resolve_tools` 调用后，runtime 需要：
1. 模型调用 `resolve_tools` → runtime 返回 schema 作为 tool result
2. Runtime 将 resolved tools 加入 tool list
3. 创建新 API 请求（包含更新后的 tools）→ 模型调用实际工具

实现方式：`NativeAPIRuntime.run()` 改为循环，每轮检查是否有 tool list 变更。最大循环次数限制 = 3（防止无限 resolve）。仅 Master 层适用。

**Token 去重**（Codex review fix）：`resolve_tools` 的 tool result 包含完整 schema，这些 schema 随后又在下一轮请求的 `tools` 参数中出现 — 双重 token 消耗。缓解方案：runtime 在构造下一轮请求时，从 message history 中**剪裁 resolve_tools 的 tool result**，替换为简短确认（如 `"Resolved: trim_element, split_element"`）。Schema 信息仅通过 `tools` 参数传递，不在 history 中重复。

**Skill-aware promotion**：保留。matchesIntent 匹配的 skill 的 `allowed_tools` 自动 promote 为 fully loaded。**但 promotion 只作用于 isEnabled 过滤后的集合** — `isEnabled(ctx) === false` 的工具即使被 skill 指定也不会 promote。顺序：先 isEnabled 过滤，再 skill promotion。

**Fallback**：Deferred tool 的 `searchHint` 需足够描述性，让模型在 skill 未覆盖时通过 `resolve_tools` 关键词搜索找到工具。

### Acceptance Tests

1. Sub-agent 工具始终全量加载，不受 `shouldDefer` 影响
2. Master 层 deferred 工具出现在 system prompt（名称 + hint）但不在 `tools` 参数中
3. `resolve_tools` 返回完整 schema 后，下一轮 API 请求包含 resolved tools
4. resolve 循环最大 3 次，超过后停止（防止无限循环）
5. Skill promotion 后，匹配工具即使标记为 deferred 也进入 `tools` 参数

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R4-1 (schema 断裂) | **RESOLVED** | Sub-agent 不 defer，batch_edit 及操作数始终可用 |
| R4-2 (mid-call 添加) | **ACCEPTED** | NativeAPIRuntime 多轮循环，仅 Master 层 |
| R4-3 (延迟冲突) | **ACCEPTED** | Master 层 round trip 被 sub-agent 延迟掩盖 |
| R4-4 (skill 耦合) | **ACCEPTED** | searchHint 做后备 |

---

## 5. 动态 Description ✅ 已锁定

### 最终决策：descriptionSuffix 替代 union type

**`description` 保持 `string` 不变**。新增可选字段：

```ts
descriptionSuffix?: (ctx: ToolDescriptionContext) => string | undefined;

interface ToolDescriptionContext {
  projectContext?: Readonly<ProjectContext>;  // optional — SubAgent may not have it
  activeSkills: SkillContract[];
  agentType: AgentType;
}
```

`formatToolsForApi` 在序列化时，有 suffix 就 append 到 description 末尾。无 suffix 的工具完全不受影响。

**使用场景**：

| 工具 | Suffix 内容 | 触发条件 |
|------|------------|---------|
| dispatch_editor | " (Note: edits will be queued during exploration)" | exploration 进行中 |
| analyze_video | " (Note: no media uploaded yet)" | 无视频素材 |
| propose_changes | " (Note: another changeset awaiting review)" | changeset pending |
| explore_options | " (Note: per-project limit: 1 concurrent exploration)" | active exploration |

**Cache 影响**：4 个工具 × 低频变化（exploration 开始/结束时）= cache miss 率可忽略。记录为已知 tradeoff。

### Acceptance Tests

1. `descriptionSuffix` 是可选字段 — 未声明的工具 description 不变
2. `formatToolsForApi` 在有 suffix 时 append 到 description 末尾
3. Suffix 返回 `undefined` 时不影响 description（等同于未声明）
4. 主 description 文本不变 — cache key 变化仅限 suffix 内容

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R5-1 (union 过度设计) | **ACCEPTED** | descriptionSuffix 替代 union type |
| R5-2 (context 穿透) | **RESOLVED** | P0 formatToolsForApi 重设计 + Step 1.3 SubAgent ProjectContext |
| R5-3 (cache 冲突) | **ACCEPTED** | 可忽略，记录 tradeoff |

---

## 6. 渲染基础 + 视觉信任体系 ✅ 已锁定

### 最终决策：基础版 onProgress + Ghost/Changeset 分离 + visualHints 扩展点

**onProgress 基础实现**：

```ts
// ToolPipeline.execute() 新增可选回调
async execute(
  toolName: string,
  input: unknown,
  ctx: { agentType: AgentType; taskId: string; toolCallId?: string },  // toolCallId 来自模型 tool_use.id
  idempotencyKey?: string,
  onProgress?: (event: ToolProgressEvent) => void,  // 新增
): Promise<PipelineResult>
// Pipeline 在调用 onProgress 时自动注入 toolCallId — 工具本身无需知道 callId
// runtime 从 tool_use block 的 id 字段获取 toolCallId，传入 ctx

// ToolProgressEvent 定义
interface ToolProgressEvent {
  type: "tool.progress";
  toolName: string;
  toolCallId: string;         // 绑定到模型 tool_use block 的 id，用于并行执行时区分同名工具的不同调用
  step: number;
  totalSteps?: number;
  text?: string;
  estimatedRemainingMs?: number;
}
```

**Executor 签名扩展**：

```ts
type ExecutorFn = (
  name: string,
  input: unknown,
  ctx: { agentType: AgentType; taskId: string },
  onProgress?: (event: ToolProgressEvent) => void,  // 新增
) => Promise<ToolCallResult>;
```

**Backward compatibility**：不支持 progress 的工具忽略回调 — 零行为变化。onProgress 仅在工具主动调用时触发。

**EventBus 转发机制**（Codex review fix）：Pipeline 在 `execute()` 内部包装 `onProgress` 回调 — 工具每次调用 `onProgress(event)` 时，Pipeline 同时通过 EventBus 发出 `tool.progress` 事件。这是 Pipeline 内部逻辑，不需要 ToolHook 新增 hook 类型：

```ts
// ToolPipeline.execute() 内部
const callId = ctx.toolCallId ?? toolName;
const wrappedProgress = onProgress
  ? (event: ToolProgressEvent) => {
      const enriched = { ...event, toolCallId: callId };
      onProgress(enriched);
      // 转发到 EventBus — 遵循 RuntimeEvent { type, timestamp, taskId, data } 格式
      this.eventBus?.emit({
        type: "tool.progress",
        timestamp: Date.now(),
        taskId: ctx.taskId,
        data: { toolName, toolCallId: callId, step: event.step, totalSteps: event.totalSteps, text: event.text },
      });
    }
  : undefined;

// wrappedProgress 传入 executor — executor 签名已扩展为接收 onProgress
await this.executor(toolName, effectiveInput, ctx, wrappedProgress);
```

**Executor 合约修订**（Codex review fix）：当前 executor 签名是 `(name: string, input: unknown)` (runtime.ts:15)，且 master 用固定 taskId (master-agent.ts:101)。需要扩展为：
```ts
type ExecutorFn = (
  name: string,
  input: unknown,
  ctx: { agentType: AgentType; taskId: string; toolCallId?: string; sessionId?: string },
  onProgress?: (event: ToolProgressEvent) => void,
) => Promise<ToolCallResult>;
```
`runtime.setToolExecutor()` 和 `createAgentPipeline()` 均需适配新签名。`toolCallId` 来自模型 `tool_use` block 的 `id` 字段，由 runtime 在调用 executor 时注入。工具实现调用 `onProgress(event)` 时无需自行注入 callId — Pipeline 的 `wrappedProgress` 自动注入。

Pipeline 持有 EventBus 引用（通过构造函数注入），progress 事件不依赖 ToolHook 系统。

**RuntimeEvent 类型扩展**（Codex review fix）：`events/types.ts` 的 `RuntimeEventType` union 必须新增 `"tool.progress"`。progress 事件遵循现有 `RuntimeEvent` 格式 `{ type, timestamp, taskId, data }`，payload 包装在 `data` 字段内（与 `tool.called`/`tool.result` 一致）：
```ts
// events/types.ts 新增
type: "tool.progress"
data: { toolName: string; toolCallId: string; step: number; totalSteps?: number; text?: string }
```

**ToolCallResult 扩展**：

```ts
interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
  visualHints?: ToolVisualHint;  // 新增，用于未来 ghost 集成
}

// 初始类型定义，随 ghost 实现扩展
interface ToolVisualHint {
  affectedElements?: string[];
  operationType?: "trim" | "split" | "delete" | "move" | "add" | "effect" | "audio" | "generate";
  previewAvailable?: boolean;
}
```

**Ghost 与 Changeset 分离**：

两个独立状态系统，单向依赖：

```
Changeset (agent 侧):  propose → approve / reject
Ghost (前端侧):        proposed → previewing → accepted → committed
                                                 ↘ invalidated / stale
```

Ghost 订阅 changeset 事件（propose → 创建 ghost, approve → ghost committed），但 changeset 不知道 ghost 的存在。不需要重建 changeset 系统。

**SAM2**：保留在 agent 文档中。Vision Agent 需要理解 SAM2 mask 作为 spatial annotation 输入。客户端执行分割，通过 API 传递 mask 给 agent。

### Acceptance Tests

1. `ToolPipeline.execute()` 接受可选 `onProgress` 回调
2. 不传 `onProgress` 时行为完全不变（backward compatible）
3. 工具调用 `onProgress` 时，EventBus 接收到 `tool.progress` 事件
4. `ToolCallResult.visualHints` 是可选字段 — 未设置时为 undefined
5. Changeset 系统 (propose/approve/reject) 功能不变，不感知 ghost

### Finding Resolutions

| Finding | Resolution | 理由 |
|---------|-----------|------|
| R6-1 (onProgress 设计缺失) | **MODIFIED** | 实现基础版 onProgress，不等 Chat UI |
| R6-2 (Ghost ≠ Changeset) | **MODIFIED** | 两个独立系统，Ghost 单向订阅 changeset 事件 |
| R6-3 (SAM2 方向) | **REJECTED** | SAM2 保留在 agent 文档，Vision Agent 需要理解 mask |
| R6-4 (前向依赖) | **ACCEPTED** | ToolCallResult 加 visualHints，Pipeline 加 onProgress |

---

## 最终 ToolDefinition 接口

```ts
interface ToolDefinition {
  // 现有字段（不变）
  name: string;
  description: string;                    // 保持 string，不改 union type
  inputSchema: z.ZodType;
  agentTypes: AgentType[];
  accessMode: "read" | "write" | "read_write";  // 保留为权威字段

  // Section 1: 结果预算
  maxResultSizeChars?: number;            // 默认 30,000
  summarize?: (result: unknown) => string; // 自定义溢出摘要

  // Section 2: 失败关闭 + 并行
  isReadOnly?: boolean;                   // 默认 false。true 时自动设 accessMode="read"
  isConcurrencySafe?: boolean;            // 默认 false。true = 可与其他 concurrent-safe 工具并行

  // Section 3: 运行时过滤
  isEnabled?: (ctx: ToolFilterContext) => boolean;  // 默认 true。仅限稳定条件

  // Section 4: 延迟加载（Master 层）
  shouldDefer?: boolean;                  // 默认 false
  searchHint?: string;                    // deferred 时的提示

  // Section 5: 动态描述
  descriptionSuffix?: (ctx: ToolDescriptionContext) => string | undefined;
}
```

**所有新字段均为 optional，默认值走最保守路径。已有工具无需改动。**

**冲突校验规则**：`isReadOnly: true` + `accessMode !== "read"` → 注册时抛 validation error。

---

## 实现优先级（最终版）

| 优先级 | 项目 | 前置依赖 | 预估复杂度 |
|--------|------|----------|-----------|
| **P0** | formatToolsForApi 重设计（排序 + context 参数） | 无 | 2h |
| **P1** | Fail-closed defaults（isReadOnly, isConcurrencySafe, 冲突校验） | 无 | 4h |
| **P1.3** | SubAgent ProjectContext 注入 | 无 | 2h |
| **P2** | 结果预算控制（session Map + summarize + StateSerializer detail） | 无 | 1-2d |
| **P3** | isEnabled 运行时过滤（仅稳定条件） | P0, P1.3 | 4h |
| **P4** | 并行执行（isConcurrencySafe 分区 + NativeAPIRuntime 调度器，保留 writeLock） | P1 | 1-2d |
| **P5** | descriptionSuffix | P0 | 4h |
| **P6** | Master 级延迟加载 + NativeAPIRuntime 多轮循环 | 独立 | 1-2d |
| **P7** | onProgress 基础版 + visualHints + EventBus 集成 | P4 | 2-3d |

**可并行**：P0 + P1 + P1.3 + P2 无依赖，可同时实施。

```
P0 (formatToolsForApi) ──┬──→ P3 (isEnabled)
                         └──→ P5 (descriptionSuffix)

P1 (fail-closed) ──→ P4 (并行执行)

P1.3 (SubAgent ctx) ──→ P3, P5

P2 (结果预算) — 独立

P6 (延迟加载) — 独立（依赖 NativeAPIRuntime 改造）

P7 (onProgress) — 依赖 P4（executor 签名）
```

---

## 迁移策略

所有新字段 `?` 可选，默认值保守。增量迁移：
1. 改 ToolDefinition 接口 + 默认值处理
2. 逐个工具文件添加新字段声明
3. 未声明的工具自动走最保守路径（isReadOnly=false, isConcurrencySafe=false）

**Breaking change**：无。`accessMode` 保留为权威字段，`isReadOnly` 是语法糖。唯一的"破坏性"变更是 `formatToolsForApi` 签名增加可选 context 参数 — 但已有调用不传 context 时行为不变。

---

## 成功指标

| 指标 | 基线 | 目标 |
|------|------|------|
| Prompt cache hit rate | 未测量 | > 70% (排序后) |
| Context overflow 事件 | 未测量 | 0 (预算控制后) |
| 并行 dispatch 延迟 | N/A (串行) | 减少 40%+ (read-only dispatch 并行) |
| Sub-agent tool list token | ~5K (Editor) | 不变 (sub-agent 不 defer) |

---

<details>
<summary>Review Findings 归档（15 条，2026-04-03）</summary>

所有 findings 已在上方各节的 Finding Resolutions 表中解决。

| Finding | Severity | Resolution |
|---------|----------|------------|
| R1-1 | Major | ACCEPTED — Session Map 替代 R2 |
| R1-2 | Major | ACCEPTED — StateSerializer detail 参数 |
| R1-3 | Major | RESOLVED — 被 R1-1 解决 |
| R1-4 | Major | ACCEPTED — 工具自定义 summarize() |
| R2-1 | Major | ACCEPTED — 两级并发模型 |
| R2-2 | Medium | MODIFIED — isConcurrencySafe 仅静态 boolean |
| R2-3 | Medium | MODIFIED — 读-读并行 (isConcurrencySafe 分区)，资源级冲突图经 Codex review 移除 |
| R3-1 | Medium | ACCEPTED — isEnabled 仅限稳定条件 |
| R4-1 | Critical | RESOLVED — Sub-agent 不 defer |
| R4-2 | Critical | ACCEPTED — NativeAPIRuntime 多轮循环 |
| R4-3 | Medium | ACCEPTED — Master 层 round trip 可接受 |
| R4-4 | Medium | ACCEPTED — searchHint 做后备 |
| R5-1 | Major | ACCEPTED — descriptionSuffix 替代 union type |
| R5-2 | Medium | RESOLVED — P0 + SubAgent ProjectContext |
| R5-3 | Minor | ACCEPTED — Cache miss 可忽略 |
| R6-1 | Critical | MODIFIED — 实现基础版 onProgress |
| R6-2 | Major | MODIFIED — Ghost/Changeset 两个独立系统 |
| R6-3 | Medium | REJECTED — SAM2 保留在 agent 文档 |
| R6-4 | Medium | ACCEPTED — 加 visualHints 字段 |

</details>

---

*文档锁定于 2026-04-03。审查流程：Deep Interview (6 rounds, 19% ambiguity) → Architect Review (ITERATE → revised) → Critic Review (ACCEPT-WITH-RESERVATIONS → 3 fixes applied) → 15 Finding 逐条辩论。*
