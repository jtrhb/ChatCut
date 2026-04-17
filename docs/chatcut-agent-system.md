# ChatCut Agent System 设计文档

基于 [chatcut-architecture.md](./chatcut-architecture.md) 的多 Agent 架构和 [chatcut-plan.md](./chatcut-plan.md) 的执行计划，详细设计 Agent 模块——SDK 选型、通信机制、Tool 系统、调度策略。

---

## 一、定位与概览

### Agent 模块在 ChatCut 中的角色

Agent 模块是 ChatCut 的"大脑"——接收用户自然语言指令，理解视频内容，做出编辑决策，操作时间线。它由 1 个 Master Agent + 5 个 Sub-agent 组成，协同完成视频编辑任务。

### 核心设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| SDK | 全部 Claude Agent SDK | 统一运行时 + agent-to-agent 通信 + 上下文管理 |
| Gemini | 降级为 tool（非 agent 运行时） | SDK 统一性 > 模型多样性 |
| 通信模式 | 共享上下文空间 | Agent 间需要看到同一个项目状态 |
| 编排模式 | 分层（Master 协调，Sub-agent 自主执行） | Sub-agent 有决策自主性，但跨 agent 协作需 Master 中转 |

---

## 二、SDK 选型：全部 Claude Agent SDK

### 2.1 为什么全部用 Agent SDK

之前的设计是 Master 用 SDK + Sub-agent 用原生 API。改为全部 SDK 的原因：

**1. Agent-to-agent 通信需要统一运行时**

Agent SDK 提供 agent 间的通信原语（共享上下文、消息传递）。如果 Sub-agent 用原生 API，Master 只能通过函数返回值传递结果——没有持续的上下文共享能力。

**2. Gemini 不再阻碍统一**

Vision Agent 现在用 Claude 运行时 + Gemini 作为 tool：

```
之前：Vision Agent 整个跑在 Gemini 上 → 不能用 Claude SDK
现在：Vision Agent 跑在 Claude SDK 上 → 需要视频理解时调 Gemini tool
```

**3. 统一带来的收益超过灵活性损失**

| 统一收益 | 灵活性损失 |
|---------|-----------|
| 上下文管理统一（auto compaction） | 不能为每个 agent 用不同 LLM 运行时 |
| Session 持久化统一 | SDK 抽象层增加调试复杂度 |
| Hooks 统一拦截 | 受 SDK 版本约束 |
| Agent 通信原语开箱即用 | — |
| 错误处理/重试统一 | — |

### 2.2 SDK-Independent Runtime Contract

**所有 agent 代码面向 AgentRuntime 接口编程，不直接依赖 SDK 具体 API：**

```typescript
// 抽象层——无论用 Agent SDK 还是原生 API，上层代码不变
interface AgentRuntime {
  createAgent(config: AgentConfig): AgentHandle;
  run(agent: AgentHandle, input: string): Promise<AgentResult>;
  saveSession(agent: AgentHandle): Promise<string>;
  restoreSession(sessionId: string): Promise<AgentHandle>;
}

interface AgentConfig {
  model: string;
  system: string;
  tools: ToolDefinition[];
  tokenBudget?: { input: number; output: number };
  maxIterations?: number;
}

interface AgentResult {
  text: string;
  toolCalls: ToolCallRecord[];
  tokensUsed: { input: number; output: number };
  needsAssistance?: { agentType: string; task: string; context: any };
}
```

**两套实现：**

| 实现 | 何时用 | 能力 |
|------|--------|------|
| `ClaudeSDKRuntime` | Agent SDK 正式发布且 API 稳定 | 完整（compaction、session、hooks） |
| `NativeAPIRuntime` | SDK 未发布 / API 不满足需求 / fallback | 基础（手动 tool-use loop + 手动 session 序列化） |

```typescript
// NativeAPIRuntime fallback 实现
class NativeAPIRuntime implements AgentRuntime {
  async run(agent: AgentHandle, input: string): Promise<AgentResult> {
    const messages = [{ role: "user", content: input }];
    let iterations = 0;
    while (iterations < agent.config.maxIterations) {
      const response = await anthropic.messages.create({
        model: agent.config.model,
        system: agent.config.system,
        tools: agent.config.tools,
        messages,
      });
      if (response.stop_reason === "end_turn") {
        return { text: extractText(response), toolCalls: collectedCalls, tokensUsed: ... };
      }
      const toolResults = await executeToolCalls(response, agent.executor);
      messages.push(...toolResults);
      iterations++;
    }
  }
}
```

**Phase 2 用 NativeAPIRuntime 跑通 tool 系统。Phase 4 切换到 ClaudeSDKRuntime（如果 SDK 就绪）。切换只改一行配置，不改业务代码。**

### 2.3 SDK 使用方式（ClaudeSDKRuntime）

```typescript
import { Agent, tool } from 'claude-agent-sdk';  // 包名以正式发布为准

// Master Agent
const masterAgent = new Agent({
  model: "claude-opus-4-6",
  system: masterSystemPrompt,
  tools: masterTools,
  // Agent SDK 提供的能力：
  // - 自动 context compaction（接近 token 上限时压缩历史）
  // - session 持久化（跨请求保持对话状态）
  // - hooks（拦截 tool 调用、修改行为）
  // - token 预算控制
});

// Sub-agent（同样用 Agent SDK，但模型和配置不同）
const editorAgent = new Agent({
  model: "claude-sonnet-4-6",
  system: editorSystemPrompt,
  tools: editorTools,
});
```

### 2.4 模型分配

| Agent | 模型 | 理由 |
|-------|------|------|
| Master | Claude Opus 4.6 | 复杂意图解析、任务分解、协调决策 |
| Editor | Claude Sonnet 4.6 | Tool 调用为主，Sonnet 性价比最优 |
| Creator | Claude Sonnet 4.6 | 参数构造 + API 调用 |
| Audio | Claude Sonnet 4.6 | 音频处理决策 |
| Vision | Claude Sonnet 4.6 + Gemini tool | Agent 运行时 Sonnet，视频理解调 Gemini |
| Asset | Claude Haiku 4.5 | 简单 CRUD，Haiku 够用 |

---

## 三、Agent 间通信：共享上下文空间

### 3.1 设计理念

所有 Agent 操作同一个项目的同一条时间线。它们需要看到：
- 当前时间线状态
- 其他 agent 刚做了什么修改
- 用户的最新指令和偏好

**不是每个 agent 维护自己的上下文副本，而是共享一个项目级的上下文空间。**

### 3.2 共享上下文结构

```typescript
interface ProjectContext {
  // === 只读区域（所有 agent 可读，只有特定写入者可写）===

  // 时间线状态（写入者：ServerEditorCore via commands）
  timelineState: SerializedTimeline;
  snapshotVersion: number;

  // 视频理解结果（写入者：Vision Agent）
  videoAnalysis: {
    scenes: SceneAnalysis[];
    characters: string[];
    mood: string;
    style: string;
    // 版本化：检测过时分析
    sourceStorageKey: string;       // 分析的是哪个媒体
    analyzedAtSnapshotVersion: number;  // 分析时的时间线版本
    lastAnalyzedAt: string;
    // 消费者应检查：analyzedAtSnapshotVersion == currentSnapshotVersion
    // 不匹配时提示 Master "视频分析可能过时，是否重新分析？"
  } | null;

  // 用户意图（写入者：Master Agent）
  currentIntent: {
    raw: string;              // 用户原始输入
    parsed: string;           // Master 解析后的结构化意图
    explorationMode: boolean; // 是否在 fan-out 探索中
  };

  // Memory 上下文（写入者：Memory Layer）
  memoryContext: {
    promptText: string;       // 注入 system prompt 的 memory 文本
    injectedMemoryIds: string[];
    injectedSkillIds: string[];
  };

  // === 通信区域（agent 间传递中间结果）===

  // 中间产物缓存（任何 agent 可写入，其他 agent 可读取）
  // 约束：最多 50 个 artifact，单个 artifact data 最大 100KB
  // 大文件（帧图片、视频片段）只存 storageKey 引用，不存内容
  // TTL：30 分钟未被读取的 artifact 自动清理
  artifacts: Record<string, {
    producedBy: string;       // agent type
    type: string;             // "video_analysis" | "generated_media" | "frame_extraction" | ...
    data: any;                // 轻量数据 或 storageKey 引用（大文件不内联）
    sizeBytes: number;        // data 大小（用于配额检查）
    timestamp: string;
    lastAccessedAt: string;   // TTL 基准
  }>;

  // Change Log 近期事件（写入者：Context Synchronizer）
  recentChanges: ChangeEntry[];
}
```

### 3.3 上下文访问模式

```
Master Agent 接收用户请求
    ↓
读取 ProjectContext → 注入 system prompt
    ↓
Master 决策："需要 Vision Agent 先分析视频，再让 Editor Agent 编辑"
    ↓
dispatch Vision Agent：
  Vision Agent 读取 ProjectContext.timelineState（知道当前时间线）
  Vision Agent 调用 analyze_video tool（内部调 Gemini）
  Vision Agent 将分析结果写入 ProjectContext.videoAnalysis + artifacts
    ↓
dispatch Editor Agent：
  Editor Agent 读取 ProjectContext.timelineState（知道当前时间线）
  Editor Agent 读取 ProjectContext.videoAnalysis（Vision 的分析结果）
  Editor Agent 读取 ProjectContext.artifacts（Vision 可能留下的帧提取等中间产物）
  Editor Agent 执行编辑 commands
    ↓
Master 汇总结果 → propose() → 用户审批
```

### 3.4 写入隔离

虽然上下文是共享的，但写入有明确的权限边界：

| 上下文区域 | 谁可以写 | 谁可以读 |
|-----------|---------|---------|
| timelineState | ServerEditorCore（通过 commands） | 所有 agent |
| videoAnalysis | Vision Agent | 所有 agent |
| currentIntent | Master Agent | 所有 agent |
| memoryContext | Memory Layer（通过 loadMemories） | 所有 agent |
| artifacts | 任何 agent（写入自己的产物） | 所有 agent |
| recentChanges | Context Synchronizer | 所有 agent |

**冲突避免：** 同一时刻只有一个 agent 在执行写操作（时间线写锁，见 §五调度策略）。读操作不受限。

### 3.5 Sub-agent 间的间接通信

Sub-agent 不直接互相调用。需要协作时通过 Master 中转：

```
Editor Agent 执行中发现："这段需要音频分析才能确定在哪里切"
    ↓
Editor Agent 返回给 Master：{ needsAssistance: "audio_analysis", context: {...} }
    ↓
Master 理解需求 → dispatch Audio Agent（带上 Editor 的上下文）
    ↓
Audio Agent 分析完 → 结果写入 artifacts
    ↓
Master 再次 dispatch Editor Agent（继续之前的任务，能读到 Audio 的结果）
```

这比 Sub-agent 直接通信更可控——Master 始终知道发生了什么，能在协作过程中调整策略。

---

## 四、Tool 系统设计

### 4.1 设计原则

1. **Tool 是 Agent 的手** — Agent 决策，Tool 执行。Agent 不直接操作时间线，而是通过 Tool 调用 ServerEditorCore
2. **Schema 即契约** — 每个 Tool 有严格的 JSON Schema 定义输入输出，Agent 和执行器都遵守
3. **按 Agent 职责分组** — 每个 Sub-agent 只能看到自己职责范围内的 Tools
4. **读写分离** — 读操作（查询时间线、分析视频）和写操作（修改时间线）明确区分，影响调度策略

### 4.2 Tool 注册机制

通过 Agent SDK 的进程内 MCP server 注册（不是外部 MCP，无网络开销）：

```typescript
import { createMcpServer, tool } from 'claude-agent-sdk';

const editorMcp = createMcpServer({
  tools: [
    tool("get_timeline_state", {
      description: "获取当前时间线状态的精简视图",
      input: z.object({}),
      output: z.object({ timeline: AgentTimelineViewSchema }),
      execute: async () => stateSerializer.serializeTimeline(editorCore.getState()),
    }),

    tool("trim_element", {
      description: "裁剪指定元素的起止时间",
      input: z.object({
        elementId: z.string(),
        newStartTime: z.number().optional(),
        newEndTime: z.number().optional(),
      }),
      execute: async ({ elementId, newStartTime, newEndTime }) => {
        const command = new TrimClipCommand(editorCore, elementId, newStartTime, newEndTime);
        await editorCore.executeAgentCommand(command, agentId);
        return { success: true };
      },
    }),

    // ... 更多 tools
  ],
});
```

### 4.3 Tool 清单

#### Master Agent Tools（调度层）

| Tool | 类型 | 描述 |
|------|------|------|
| `dispatch_vision` | 调度 | 分派任务给 Vision Agent |
| `dispatch_editor` | 调度 | 分派任务给 Editor Agent |
| `dispatch_creator` | 调度 | 分派任务给 Creator Agent |
| `dispatch_audio` | 调度 | 分派任务给 Audio Agent |
| `dispatch_asset` | 调度 | 分派任务给 Asset Agent |
| `explore_options` | 调度 | 触发 fan-out 探索（见 [fanout-exploration.md](./chatcut-fanout-exploration.md)） |
| `propose_changes` | 审批 | 将当前 pending 操作提交给用户审批 |
| `export_video` | 导出 | 触发视频导出 job |
| `check_export_status` | 查询 | 查询导出进度 |

#### Vision Agent Tools（视频理解）

| Tool | 类型 | 描述 | 底层实现 |
|------|------|------|---------|
| `analyze_video` | 异步/幂等 | 分析视频内容（场景、角色、情绪）。长视频可能 30s+，走 pg-boss job | Gemini 2.5 Pro API |
| `check_analysis_status` | 读 | 查询分析任务状态 | Job Queue |
| `locate_scene` | 读 | 自然语言定位时间范围（依赖已完成的 analysis） | 分析缓存 + LLM 匹配 |
| `describe_frame` | 读 | 描述指定时间点的画面内容 | Gemini API |
| `extract_frames` | 读 | 提取指定时间范围的帧图片 | FFmpeg |

#### Editor Agent Tools（时间线编辑）

| Tool | 类型 | 描述 |
|------|------|------|
| `get_timeline_state` | 读 | 获取当前时间线精简视图 |
| `get_element_info` | 读 | 获取指定元素的详细信息 |
| `preview_frame` | 读 | 预览指定时间点的合成画面 |
| `trim_element` | 写 | 裁剪元素 |
| `split_element` | 写 | 分割元素 |
| `delete_element` | 写 | 删除元素 |
| `move_element` | 写 | 移动元素位置 |
| `add_element` | 写 | 添加新元素到轨道 |
| `set_speed` | 写 | 设置播放速度 |
| `set_volume` | 写 | 设置音量 |
| `add_transition` | 写 | 添加转场 |
| `add_effect` | 写 | 添加特效 |
| `update_text` | 写 | 更新文字内容/样式 |
| `add_keyframe` | 写 | 添加关键帧 |
| `reorder_elements` | 写 | 重新排列元素顺序 |
| `batch_edit` | 写 | 批量操作（多个独立写操作合并为一次原子提交） |

#### Creator Agent Tools（内容生成）

| Tool | 类型 | 描述 | 底层实现 |
|------|------|------|---------|
| `generate_video` | 异步/幂等 | 生成视频片段（需传 idempotencyKey，重试不重复生成） | Kling / Seedance / Veo API |
| `generate_image` | 异步/幂等 | 生成图片（需传 idempotencyKey） | 生成模型 API |
| `check_generation_status` | 读 | 查询生成任务状态 | Job Queue |
| `replace_segment` | 写 | 用生成内容替换时间线片段 | ReplaceSegmentCommand |
| `compare_before_after` | 读 | 对比替换前后的画面 | FFmpeg 帧提取 |

**非幂等 tool 的重试保护：** `generate_video`、`generate_image`、`export_video`、`generate_voiceover` 等有外部副作用的 tool 必须携带 `idempotencyKey`（由 agent 生成的 UUID）。Tool executor 通过 pg-boss `singletonKey` 保证相同 key 不重复入队。Agent SDK 的自动重试对这类 tool 不会产生重复费用/产物。

#### Audio Agent Tools（音频处理）

| Tool | 类型 | 描述 | 底层实现 |
|------|------|------|---------|
| `search_bgm` | 读 | 搜索背景音乐 | Freesound API |
| `add_bgm` | 写 | 添加背景音乐到时间线 | EditorCore insert |
| `set_volume` | 写 | 设置音量 | EditorCore update |
| `transcribe` | 异步 | 转录音频为文字 | Whisper API |
| `auto_subtitle` | 写 | 自动生成字幕 | transcribe + batch insert |
| `generate_voiceover` | 异步 | 生成配音 | xAI TTS API |

#### Asset Agent Tools（资产管理，Phase 5 完善）

| Tool | 类型 | 描述 |
|------|------|------|
| `search_assets` | 读 | 搜索素材库 |
| `get_asset_info` | 读 | 获取素材详情 |
| `save_asset` | 写 | 保存素材到库 |
| `tag_asset` | 写 | 给素材打标签 |
| `find_similar` | 读 | 找相似素材 |
| `get_character` | 读 | 获取角色信息 |
| `get_brand_assets` | 读 | 获取品牌资产 |

### 4.4 Tool Executor 架构

```
Agent SDK 运行时
    ↓
Agent 决策调用 tool（如 trim_element）
    ↓
MCP Server 路由到对应 Tool Executor
    ↓
Tool Executor 层：
├── 参数校验（zod schema）
├── 权限检查（该 agent 能否调这个 tool）
├── 读写分类（影响调度锁）
├── 执行：
│   ├── 读操作 → 直接查询 ServerEditorCore / 外部 API
│   └── 写操作 → 构建 Command → ServerEditorCore.executeAgentCommand()
├── 结果序列化
└── 返回给 Agent
```

```typescript
// Tool Executor 基类
abstract class ToolExecutor {
  constructor(
    protected editorCore: ServerEditorCore,
    protected projectContext: ProjectContext,
    protected agentId: string,
  ) {}

  // 执行前校验
  protected validatePermission(toolName: string, agentType: string): void {
    if (!TOOL_PERMISSIONS[agentType].includes(toolName)) {
      throw new Error(`Agent ${agentType} is not allowed to call ${toolName}`);
    }
  }

  // 读写分类
  protected isWriteOperation(toolName: string): boolean {
    return WRITE_TOOLS.includes(toolName);
  }
}

// 具体实现
class EditorToolExecutor extends ToolExecutor {
  async trimElement(input: { elementId: string; newStartTime?: number; newEndTime?: number }) {
    const command = new TrimClipCommand(this.editorCore, input.elementId, input.newStartTime, input.newEndTime);
    await this.editorCore.executeAgentCommand(command, this.agentId);
    return { success: true, newState: this.getElementState(input.elementId) };
  }
}
```

### 4.5 Gemini Tool 封装

Vision Agent 的视频理解能力通过 tool 封装 Gemini API：

```typescript
// Vision Agent 的 analyze_video tool
tool("analyze_video", {
  description: "分析视频内容：场景分割、角色识别、情绪分析",
  input: z.object({
    storageKey: z.string(),
    focus: z.string().optional(),
  }),
  execute: async ({ storageKey, focus }) => {
    // 1. 检查缓存
    const cached = await visionCache.get(storageKey);
    if (cached && !focus) return cached;

    // 2. 从共享缓存卷下载到临时文件
    const { tempPath, cleanup } = await objectStorage.downloadToTempFile(storageKey);

    try {
      // 3. 调用 Gemini API
      const genai = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
      const model = genai.getGenerativeModel({ model: "gemini-2.5-pro" });

      const video = await model.uploadFile(tempPath);
      const result = await model.generateContent({
        contents: [{
          parts: [
            { fileData: { mimeType: "video/mp4", fileUri: video.uri } },
            { text: ANALYSIS_PROMPT + (focus ? `\n重点关注：${focus}` : '') },
          ],
        }],
        generationConfig: { responseMimeType: "application/json" },
      });

      const analysis = JSON.parse(result.response.text());

      // 4. 写入共享上下文 + 缓存
      projectContext.videoAnalysis = analysis;
      projectContext.artifacts[`analysis-${storageKey}`] = {
        producedBy: "vision",
        type: "video_analysis",
        data: analysis,
        timestamp: new Date().toISOString(),
      };
      if (!focus) await visionCache.set(storageKey, analysis);

      return analysis;
    } finally {
      cleanup();
    }
  },
});
```

---

## 五、调度策略

### 5.1 分层调度模型

```
用户请求 → Master Agent
              ↓
         Master 解析意图，制定执行计划
              ↓
         Master 通过 dispatch_* tools 调度 Sub-agents
              ↓
         ┌─────────────────────────────────────────┐
         │ 调度规则：                                 │
         │                                          │
         │ 读操作（Vision 分析、查询时间线）            │
         │   → 可并行执行                             │
         │                                          │
         │ 写操作（编辑时间线、替换片段）               │
         │   → 必须串行（project-level 写锁）          │
         │                                          │
         │ 读+写混合                                  │
         │   → 读先行并行，写排队串行                   │
         │                                          │
         │ 跨 agent 依赖                              │
         │   → Master 决定顺序，先完成依赖再继续        │
         └─────────────────────────────────────────┘
              ↓
         Sub-agents 执行（各自有决策自主性）
              ↓
         结果写入 ProjectContext.artifacts
              ↓
         Master 汇总 → propose() 或返回用户
```

### 5.2 并行调度

Master Agent 一次响应可以返回多个 `dispatch_*` tool calls。Agent SDK 识别到多个 tool calls 时：

```typescript
// Master 返回的 tool calls
[
  { tool: "dispatch_vision", input: { task: "分析视频内容", accessMode: "read" } },
  { tool: "dispatch_editor", input: { task: "获取当前时间线状态", accessMode: "read" } },
]

// 调度引擎处理：
// 1. 分类：两个都是 accessMode: "read"
// 2. 读+读 → 并行执行（不加写锁）
// 3. 等待两个都完成 → 返回结果给 Master

// 如果是读+写混合：
[
  { tool: "dispatch_vision", input: { task: "分析视频", accessMode: "read" } },
  { tool: "dispatch_editor", input: { task: "裁剪片段", accessMode: "write" } },
]
// 读立即执行，写获取 dispatch-scoped 锁后执行
// 写 dispatch 持有锁期间，其他写 dispatch 排队
```

### 5.3 写锁机制

```typescript
// 进程内写锁——MVP 单进程部署足够。
// 水平扩展边界：多实例部署时需替换为 PostgreSQL advisory lock
// 或 Redis RedLock，确保跨进程互斥。接口不变，只换实现。
class ProjectWriteLock {
  private locked: boolean = false;
  private queue: Array<{ resolve: () => void }> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    return new Promise(resolve => this.queue.push({ resolve }));
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      next.resolve();
    } else {
      this.locked = false;
    }
  }
}

// 写锁粒度：dispatch-scoped（整个 dispatch 期间持有锁，不是 per-tool-call）
// 这确保同一个 dispatch 内的多个 tool call 原子执行，
// 且不同 dispatch 的 tool call 不会交叉——避免 rollback 时状态污染

async function executeDispatch(
  agentType: string,
  input: DispatchInput,
  writeLock: ProjectWriteLock,
  projectContext: ProjectContext,
) {
  const isWrite = input.accessMode === "write" || input.accessMode === "read_write";

  if (isWrite) {
    // 写操作：在 dispatch 开始时获取锁，dispatch 完成后释放
    await writeLock.acquire();
    try {
      // 记录 dispatch 开始时的 snapshotVersion
      const baseVersion = projectContext.snapshotVersion;

      // 执行整个 sub-agent loop（所有 tool call 在锁内完成）
      const result = await runSubAgent(agentType, input);

      return result;
    } catch (e) {
      // dispatch 失败 → rollback 该 taskId 的所有 commands（在锁内回滚，安全）
      await rollbackByTaskId(input.taskId);
      throw e;
    } finally {
      writeLock.release();
    }
  } else {
    // 读操作：不加锁，可并行
    return await runSubAgent(agentType, input);
  }
}
```

**关键：写锁是 dispatch-scoped，不是 tool-call-scoped。** 一个 write dispatch 持有锁期间，其他 write dispatch 排队等待。这确保：
- 同一 dispatch 内的多个 tool call 按顺序执行，无交叉
- dispatch 失败时 rollback 不影响其他 dispatch 的状态
- 读 dispatch 不受锁影响，可与写 dispatch 并行

**StaleStateError 处理：** 如果 dispatch 获取锁后发现 snapshotVersion 与预期不符（其他 dispatch 刚改完），SDK 自动将最新 timeline state 注入 agent 上下文，agent 重新决策。

```
```

### 5.4 错误恢复

```
Sub-agent 执行失败
    ↓
错误分类：
├── 可重试错误（API 超时、网络抖动）
│     → Agent SDK 自动重试（内置 exponential backoff）
│
├── 不可重试错误（参数无效、权限不足）
│     → 返回错误给 Master
│     → Master 决策：换策略 / 换 agent / 报告用户
│
└── 致命错误（agent 崩溃、内存溢出）
      → Agent SDK 捕获
      → 回滚该 dispatch 的所有 commands（通过 taskId 隔离，见下方）
      → Master 收到通知 → 决定是否重新 dispatch
```

**Per-dispatch 命令隔离（解决共享 changeset 中的 agent 回滚问题）：**

每次 dispatch sub-agent 时分配一个 `taskId`。该 agent 执行的所有 commands 都打上这个 `taskId` 标签：

```typescript
// dispatch 时
const taskId = generateTaskId();  // 如 "task_editor_abc123"

// agent 的每次 executeAgentCommand 都携带 taskId
editorCore.executeAgentCommand(command, { agentId, taskId });

// Change Log 记录 taskId
changeLog.record(command, { source: "agent", agentId, taskId });
```

**回滚策略：**

```
agent 执行失败
    ↓
收集该 taskId 下的所有 commands（从 CommandManager 历史栈中按 taskId 过滤）
    ↓
逆序 undo 这些 commands（只撤销该 agent 的操作，不影响其他 agent 的）
    ↓
changeset 中标记这些 commands 为 rolled_back
    ↓
Master 可以重新 dispatch（新的 taskId）或跳过该步骤
```

### 5.5 Token 预算控制

```typescript
// 每个 agent 有独立的 token 预算
const TOKEN_BUDGETS = {
  master: { input: 100_000, output: 8_000 },     // Opus，需要大 context
  editor: { input: 30_000, output: 4_000 },       // Sonnet，tool 调用为主
  creator: { input: 30_000, output: 4_000 },
  audio: { input: 30_000, output: 4_000 },
  vision: { input: 50_000, output: 8_000 },       // 视频分析结果可能很大
  asset: { input: 10_000, output: 2_000 },        // Haiku，简单 CRUD
};

// Agent SDK 的 auto compaction：
// 当 agent 接近 input token 上限时，SDK 自动压缩历史消息
// 保留：system prompt + 最近 N 轮 + tool 结果摘要
// 压缩：早期的详细 tool 结果 → 摘要
```

---

## 六、Agent 生命周期

### 6.1 Session 模型

```
用户打开项目 → 创建 AgentSession
    ↓
AgentSession 包含：
├── Master Agent 实例（持久化，跨多次请求保持上下文）
├── ProjectContext（共享上下文空间）
├── 写锁
└── Sub-agent 按需创建（dispatch 时实例化，完成后释放）

用户关闭项目 → AgentSession 持久化到 PostgreSQL
    ↓
用户重新打开 → 从 PostgreSQL 恢复 AgentSession
               Master Agent 上下文恢复（SDK session 恢复能力）
               ProjectContext 从最新快照重建
```

### 6.2 Sub-agent 生命周期

Sub-agent 不是长驻的——按需创建，完成即释放：

```
Master dispatch_editor({ task: "裁剪第二段到 3 秒" })
    ↓
创建 Editor Agent 实例（加载 system prompt + editor tools + memory context）
    ↓
Editor Agent 执行 tool-use loop（1-5 轮）
    ↓
返回结果给 Master
    ↓
Editor Agent 实例释放（不保持状态）
    ↓
下次 dispatch 时创建新实例（ProjectContext 共享，所以能看到之前的操作结果）
```

**为什么不保持 Sub-agent 常驻：**
- Sub-agent 每次任务独立，不需要跨任务记忆（Memory Layer 已经处理长期知识）
- 常驻会占用 token 预算（每个 agent 累积的历史消息）
- 按需创建更轻量

**任务续接机制（structured taskState）：**

Sub-agent 被销毁后，如果 Master 需要"继续之前的工作"，通过 artifacts 中的 `taskState` 传递：

```typescript
// Sub-agent 执行中途需要其他 agent 协助 → 返回 needsAssistance + taskState
return {
  result: "需要音频分析才能确定切割点",
  needsAssistance: { agentType: "audio", task: "分析 3.2s-8.7s 的节拍" },
  artifacts: {
    "editor-task-state": {
      producedBy: "editor",
      type: "task_state",
      data: {
        completedSteps: ["定位片段", "设置慢动作"],
        pendingSteps: ["在节拍点切割"],
        contextSnapshot: { targetElementId: "elem_123", currentSpeed: 0.5 },
      },
      timestamp: new Date().toISOString(),
    },
  },
};

// Master 协调 Audio Agent 完成后，重新 dispatch Editor Agent，带上 taskState
dispatch_editor({
  task: "继续之前的编辑任务：在节拍点切割",
  context: {
    previousTaskState: projectContext.artifacts["editor-task-state"].data,
    audioAnalysis: projectContext.artifacts["audio-beat-analysis"].data,
  },
});
```

### 6.3 Master Agent 持久化

Master Agent 是唯一需要持久化的 agent：

```
持久化内容：
├── 对话历史（用户的所有请求和 Master 的响应）
├── 当前 session 的决策上下文（为什么选择了某个策略）
├── Agent SDK session ID（用于恢复）

不持久化（从权威源重建）：
├── Sub-agent 状态（每次重建）
├── ProjectContext.timelineState（从 PostgreSQL committed 快照重建）
├── ProjectContext.videoAnalysis（从 visionCache 重建）
├── ProjectContext.artifacts（临时产物，不持久化，丢失可重新生成）
├── ProjectContext.memoryContext（从 R2 memory 重新加载）
├── ProjectContext.recentChanges（从 Change Log 重新加载）
├── 写锁状态（重启后重建，无锁）
```

---

## 七、Dispatch 协议

### 7.1 dispatch_* Tool 的输入输出

每个 `dispatch_*` tool 有统一的协议：

```typescript
// 统一的 dispatch 输入
interface DispatchInput {
  task: string;              // 自然语言任务描述
  accessMode: "read" | "write" | "read_write";  // 声明式访问模式（调度引擎用于并行/串行决策）
  context?: {                // 额外上下文（从其他 agent 的结果传递）
    [key: string]: any;
  };
  constraints?: {            // 约束条件
    maxIterations?: number;  // 最大 tool-use 轮数
    timeoutMs?: number;      // 超时时间
  };
}

// 统一的 dispatch 输出
interface DispatchOutput {
  result: string;            // Agent 的自然语言总结
  artifacts?: Record<string, any>;  // 产生的中间产物
  needsAssistance?: {        // 需要其他 agent 协助
    agentType: string;       // 需要哪个 agent
    task: string;            // 协助任务
    context: any;            // 传递的上下文
  };
  toolCallCount: number;     // 执行了多少次 tool call
  tokensUsed: number;        // 消耗了多少 token
}
```

### 7.2 跨 Agent 协作示例

```
用户："给咖啡师特写那段加个慢动作效果，配上轻柔的背景音乐"

Master Agent 解析：
  1. 需要先定位"咖啡师特写" → Vision Agent
  2. 设置慢动作 → Editor Agent
  3. 搜索并添加音乐 → Audio Agent
  顺序依赖：1 → (2, 3 并行)

Master dispatch_vision({
  task: "定位'咖啡师特写'的时间范围",
})
→ Vision Agent 返回：{ result: "3.2s - 8.7s", artifacts: { sceneMatch: { start: 3.2, end: 8.7 } } }

Master 拿到时间范围后，并行 dispatch：

dispatch_editor({
  task: "把 3.2s-8.7s 的片段设置为 0.5x 慢动作",
  context: { targetRange: { start: 3.2, end: 8.7 } },
})

dispatch_audio({
  task: "搜索轻柔的背景音乐并添加到 3.2s-8.7s",
  context: { targetRange: { start: 3.2, end: 8.7 } },
})

→ 两个 agent 并行执行（Editor 写 + Audio 写 → 串行，写锁保证顺序）
→ Master 汇总 → propose()
```

---

## 八、与其他模块的集成

### 8.1 与 Memory Layer 的集成

每次 dispatch sub-agent 时，per-agent 加载 memory：

```typescript
async function dispatchSubAgent(agentType: string, input: DispatchInput) {
  // 1. 加载该 agent 类型的 memory + skills
  const memCtx = await loadMemories(taskContext, agentType);

  // 2. 构建 system prompt（含 memory）
  const systemPrompt = buildSubAgentPrompt(agentType, memCtx);

  // 3. 创建 agent 实例
  const agent = new Agent({
    model: MODEL_MAP[agentType],
    system: systemPrompt,
    tools: TOOL_MAP[agentType],
  });

  // 4. 执行
  const result = await agent.run(input.task);

  // 5. 记录注入的 memory/skill IDs（用于 approve 时的强化追踪）
  currentChangeset?.appendInjectedIds(memCtx.injectedMemoryIds, memCtx.injectedSkillIds);

  return result;
}
```

### 8.2 与 Fan-out 探索的集成

`explore_options` 是 Master 的一个 tool，触发时不走 sub-agent dispatch，而是走 Exploration Engine：

```typescript
tool("explore_options", {
  execute: async (input) => {
    // 1. 记录 baseSnapshotVersion（用户选择时校验是否过时）
    // 2. Master 生成候选骨架
    // 3. Exploration Engine 物化 + 入队 pg-boss
    // 4. 返回 explorationId（异步渲染）
    // 5. 用户选择时：version 匹配 → apply，不匹配 → rebase 或丢弃
    // 详见 chatcut-fanout-exploration.md §2
    return await explorationEngine.start({
      ...input,
      baseSnapshotVersion: projectContext.snapshotVersion,
    });
  },
});
```

### 8.3 与 Changeset Manager 的集成

所有 agent 操作按副作用分级，决定审批边界：

```
Side-effect 分级：

Tier 1: 可逆预览（reversible-preview）
├── 时间线编辑（trim, split, move, delete, reorder 等）
├── 通过 pending changeset 管理
├── reject 时完全可逆（undo）
└── 这是大部分操作的分级

Tier 2: 预计算（costly-precompute）
├── AI 视频生成、图片生成
├── 产物上传到 R2 后才写入时间线
├── reject 时：时间线回滚 + R2 产物保留 24h 后清理（不退费）
├── 用户在审批界面能看到"此操作已消耗生成 API 费用"
├── Master 在 dispatch creator 前告知用户"将消耗生成额度，是否继续？"
└── 硬性 cost ceiling：session 级 costBudget（默认 $5/session），超过时 Master 拒绝执行并提示用户

Tier 3: 不可逆外部副作用（committed-side-effect）
├── 视频导出 + 上传到外部平台
├── 需要独立确认（不包含在 changeset 的 approve 中）
└── 导出单独走 export_video → check_export_status → 用户确认下载

Agent session 开始
    ↓
Tier 1 操作 → ServerEditorCore.executeAgentCommand() → pending changeset
Tier 2 操作 → pg-boss job → 完成后产物写入 changeset
    ↓
Master 调用 propose_changes → 用户审批（能看到 tier 分级）
    ↓
approve → Tier 1 + Tier 2 一起提交
reject → Tier 1 undo + Tier 2 产物标记待清理
```

---

## 九、开放问题（已确定）

### 9.1 Agent SDK 版本风险

Agent SDK 尚未正式发布（包名、API 待确认）。缓解措施：

```typescript
// 薄封装层，隔离 SDK 依赖
// 如果 SDK API 变化，只改这一层

interface AgentRuntime {
  createAgent(config: AgentConfig): Agent;
  run(agent: Agent, input: string): Promise<AgentResult>;
  getSession(sessionId: string): Promise<AgentSession>;
}

// Claude Agent SDK 实现
class ClaudeAgentRuntime implements AgentRuntime { ... }

// 如果 SDK 废弃，可以换成原生 API 实现
class NativeAPIRuntime implements AgentRuntime { ... }
```

### 9.2 Sub-agent 最大迭代次数

防止 agent 陷入无限 tool-use loop：

| Agent | 默认 maxIterations | 理由 |
|-------|-------------------|------|
| Editor | 20 | 复杂编辑可能需要多步 |
| Creator | 10 | 生成+等待+替换 |
| Audio | 15 | 搜索+添加+调整 |
| Vision | 5 | 分析通常 1-2 次调用 |
| Asset | 10 | CRUD 操作 |

超过 maxIterations → 强制终止 → 返回已完成的部分结果给 Master。

---

## 十、实施节奏

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 2 | Tool schema 定义（全部 agent 的 tool JSON Schema） | Phase 1 EditorCore API |
| Phase 2 | Tool Executor 实现（Editor + Creator） | Phase 1 Commands |
| Phase 2 | runAgentLoop 共用函数（SDK 未就绪时的 fallback） | — |
| Phase 4 初期 | Agent SDK 集成 + AgentRuntime 封装层 | Agent SDK 发布 |
| Phase 4 初期 | ProjectContext 共享上下文实现 | Phase 4 ServerEditorCore |
| Phase 4 中期 | Master Agent + dispatch 协议 | Agent SDK |
| Phase 4 中期 | 5 个 Sub-agent 实现 | Tool Executors |
| Phase 4 中期 | 写锁 + 并行调度 | ProjectContext |
| Phase 4 后期 | Gemini tool 封装 + Vision Agent | Gemini API |
| Phase 4 后期 | Agent session 持久化 | PostgreSQL |
