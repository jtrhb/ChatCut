# ChatCut Fan-out 探索机制设计文档

基于 [chatcut-architecture.md](./chatcut-architecture.md) 的 Agent 架构和 [chatcut-plan.md](./chatcut-plan.md) 的执行计划，设计 Fan-out 探索机制——将模糊意图转化为可选择的候选方案。

---

## 一、定位与动机

### 问题

视频编辑中，用户的意图经常是模糊的：

- "这段太拖了" → 该怎么改？剪短？加速？删段落？换节奏？
- "让这个视频更有活力" → 加快转场？换音乐？调色？重排片段？
- "做成适合 Instagram 的版本" → 竖版裁切？缩短时长？加字幕？换节奏？

当前的单路径模式（用户说 → Agent 执行一个方案 → 用户看结果 → 不满意 → 重新沟通）效率低：

```
对话式澄清（当前模式）：
用户: "这段太拖了"
Agent: "你是想剪短还是加速？"
用户: "剪短吧"
Agent: "剪到多少秒？"
用户: "不确定，你看着办"
Agent: 执行 → 用户不满意 → 来回 3-4 轮
```

### Fan-out 解决什么

**让用户"选"而不是"说清楚"。**

```
Fan-out 模式：
用户: "这段太拖了"
Agent: 并行生成 4 个方案 →
  A. 删除静音段（18s → 14s）  [视频预览]
  B. 整体加速 1.3x（18s → 14s）[视频预览]
  C. 保留高能量段（18s → 12s）[视频预览]
  D. 紧凑剪辑（18s → 10s）   [视频预览]
用户: 选 C → 在 C 基础上微调 → approve
```

一次交互解决，跳过 3-4 轮对话。

### 核心价值

- **降低表达门槛**：用户不需要知道"加速 1.3x"这种专业术语，看预览就能选
- **加速决策**：从"串行对话"到"并行候选"
- **飞轮效应**：用户的选择是 Memory Layer 的强信号（"这个用户偏好紧凑剪辑"）

---

## 二、架构概览

```
用户输入模糊意图
        │
        ▼
Master Agent 判断：是否需要 fan-out？
├── 意图明确 → 直接执行（现有单路径）
└── 意图模糊 → 触发 fan-out
        │
        ▼
Master Agent 生成 N 个 Execution Plan（不可变执行计划）
（每个 plan = 一组 Commands + 物化后的全部产物引用 + 理由摘要）
        │
        ▼
Exploration Engine（异步 job，通过 pg-boss 管理）
├── 每个 plan → 独立的 Daytona sandbox
│   ├── 应用 Commands 到 timeline JSON 副本
│   ├── 物化产物（新增媒体 → 上传 R2 → storageKey）
│   ├── Playwright 渲染预览视频
│   └── 预览视频上传 R2（storageKey，非 signed URL）
├── 4 个 sandbox 并行执行
└── 通过 SSE 流式返回结果（部分完成即可推送）
        │
        ▼
Chat UI 展示候选方案
（卡片式网格，每张卡片含预览视频 + 文字摘要 + 关键指标）
        │
        ▼
用户选择一个方案
        │
        ▼
选择时验证：baseSnapshotVersion 匹配？
├── 匹配 → 进入预览模式（未 commit）→ 用户微调 → propose() → approve
└── 不匹配（期间有其他编辑）→ 提示"时间线已变化，是否基于最新状态重新应用？"
        │                         → 是 → rebase Commands → 预览 → approve
        │                         → 否 → 丢弃，回到编辑
        ▼
Memory Extractor 记录选择偏好
```

### 2.2 Exploration 状态机

每个 exploration session 有明确的状态流转：

```
                queued
                  │
                  ▼
               running ──── (sandbox 渲染中)
              ╱   │   ╲
         partial  │  completed ──── (全部完成)
         (部分完成)│       │
              ╲   │   ╱   │
               cancelled  │
                  │        ▼
                  │   user_selected ──── (用户选了一个)
                  │        │
                  ▼        ▼
               expired  applied ──── (进入 changeset 流程)
```

```typescript
type ExplorationStatus =
  | "queued"         // 等待 sandbox 分配
  | "running"        // sandbox 渲染中
  | "partial"        // 部分候选已完成
  | "completed"      // 全部候选完成
  | "user_selected"  // 用户已选择
  | "applied"        // 已应用到 ServerEditorCore
  | "cancelled"      // 用户取消
  | "expired";       // 24h TTL 过期
```

---

## 三、触发机制

### 3.1 双触发模式

**Master Agent 自主判断（默认）：**

Master Agent 在解析用户意图后，评估是否需要 fan-out。评估标准：

```typescript
interface FanoutDecision {
  shouldFanout: boolean;
  reason: string;
  skeletons?: CandidateSkeleton[];  // 如果 fan-out，同时给出方案骨架
  // CandidateSkeleton = explore_options tool 的 input.candidates 中的元素
  // 物化在 tool 内部执行（见 §3.3），Master Agent 不需要提供完整 ExecutionPlan
}
```

触发 fan-out 的信号：
- 用户意图包含主观/模糊词（"更好"、"太拖了"、"有活力"、"不太对"）
- 用户意图有多种合理解读（"精简"可以是删段落、加速、或重排）
- 用户没有指定具体参数（"剪短"但没说剪到多少秒）
- Memory 中没有覆盖当前场景的明确偏好

不触发 fan-out 的信号：
- 用户意图明确（"把第 3 个片段删掉"）
- Memory 中有高置信度偏好覆盖当前场景
- 用户正在微调模式中（已经选了一个方案，在细调）

**用户显式要求：**

- "给我几个方案看看"
- "有没有其他做法"
- 点击 Chat UI 中的"探索模式"按钮

### 3.2 Fan-out 作为 Master Agent tool

```typescript
// Master Agent 的 tool 定义
tool("explore_options", {
  description: "当用户意图模糊时，生成多个候选方案的预览视频供用户选择",
  input: {
    intent: "string",              // 用户的原始意图
    baseSnapshotVersion: "number", // 当前时间线版本（选择时校验）
    timelineSnapshot: "string",    // 当前时间线 JSON
    candidates: [{                 // 3-4 个候选骨架（CandidateSkeleton）
      label: "string",            // 方案名
      summary: "string",          // 一句话摘要
      candidateType: "string",    // 方案类型
      commands: "Command[]",      // 操作序列（可含非确定性参数）
      expectedMetrics: { durationChange: "string", affectedElements: "number" },
    }],
    // 注意：输入是骨架，tool 内部执行物化 → 生成完整 ExecutionPlan（见 §3.3）
  },
  output: {
    explorationId: "string",
    status: "queued",  // 异步 job，不阻塞 tool 返回
    // 同步返回候选元数据（label/summary/metrics），Chat UI 可立即渲染卡片骨架
    candidates: [{
      candidateId: "string",
      label: "string",
      summary: "string",
      expectedMetrics: { durationChange, affectedElements },
      previewStatus: "rendering",  // 初始状态
    }],
    // 预览视频通过 SSE 流式推送：
    // { type: "candidate_ready", explorationId, candidateId, previewStorageKey, metrics, status: "rendered" }
    // Chat UI 收到后更新对应卡片的预览视频
  },
})

### 3.3 Canonical ExecutionPlan Schema

**所有阶段（tool input → pg-boss payload → sandbox render → SSE → DB persistence）共用同一个 schema：**

```typescript
interface ExecutionPlan {
  // 标识
  explorationId: string;           // 所属 exploration session
  candidateId: string;             // 候选方案 ID

  // 方案描述（同步返回给 Chat UI 用于卡片骨架）
  label: string;                   // 方案名（"紧凑剪辑"）
  summary: string;                 // 一句话摘要
  candidateType: string;           // 方案类型（"trim" | "speed" | "reorder" | "restructure" | ...）

  // 执行内容（物化后，所有非确定性参数已替换为 storageKey）
  commands: Command[];             // 操作序列
  resultTimeline: string;          // 执行后的完整 timeline JSON 快照
  artifacts: Record<string, string>; // 物化产物 { key: storageKey }

  // 媒体访问（共享缓存卷路径）
  mediaSources: Record<string, string>; // { elementId: "/shared-media/{projectId}/{storageKey}" }

  // 预览
  previewPolicy: PreviewPolicy;    // 渲染策略（见 §5.3）
  previewStorageKey?: string;      // 渲染后填入

  // 指标
  expectedMetrics: {
    durationChange: string;        // "18s → 12s"
    affectedElements: number;
  };
}
```

**物化时机：** Master Agent 生成方案骨架后，Exploration Engine 在入队 pg-boss 之前执行物化步骤：

```
Master Agent 生成骨架（commands + label + summary）
    ↓
Exploration Engine 物化：
  1. 在内存中对 timeline 副本执行 commands → 得到 resultTimeline
  2. 非确定性产物上传 R2 → artifacts
  3. 计算 previewPolicy（基于 diff）
  4. 填入 mediaSources（从项目 media 映射到共享缓存卷路径）
    ↓
完整的 ExecutionPlan → 入队 pg-boss
```

// Exploration 作为 pg-boss async job 执行
// Master Agent 调用 explore_options → 入队 pg-boss job → 立即返回 explorationId
// job worker 分配 sandbox → 并行渲染 → 逐个完成时 SSE 推送
// Chat UI 收到第一个结果就开始展示，后续结果追加
```

**与 pg-boss Job Queue 的集成：**

```typescript
// 入队
await boss.send('exploration', {
  explorationId,
  projectId,
  baseSnapshotVersion,  // 记录发起时的版本，选择时校验
  candidates: executionPlans,
  mediaSources,
}, {
  singletonKey: `exploration-${projectId}`,  // 同一项目同时只能有一个 exploration
  expireInMinutes: 30,
});

// 消费
await boss.work('exploration', async (job) => {
  let sandboxes = await poolManager.acquire(4);
  // 防御：sandbox 分配为空时降级
  if (sandboxes.length === 0) {
    // 冷启动重试一次
    await poolManager.initialize();
    sandboxes = await poolManager.acquire(4);
    if (sandboxes.length === 0) {
      // 降级为文字摘要（不渲染预览视频）
      for (const plan of job.data.candidates) {
        sseEmit(job.data.projectId, {
          type: 'candidate_ready',
          explorationId: job.data.explorationId,
          candidateId: plan.candidateId,
          label: plan.label,
          summary: plan.summary,
          metrics: plan.expectedMetrics,
          previewStorageKey: null,  // 无预览视频
          status: 'text_only',
        });
      }
      return;
    }
  }

  // 将候选方案分配到可用 sandbox
  const results = [];
  const queue = [...job.data.candidates];
  while (queue.length > 0) {
    const batchSize = Math.max(1, sandboxes.length);  // 至少 1
    const batch = queue.splice(0, batchSize);
    const batchResults = await Promise.allSettled(
      batch.map((plan, i) =>
        renderInSandbox(sandboxes[i], plan)
          .then(result => {
            sseEmit(job.data.projectId, {
              type: 'candidate_ready',
              explorationId: job.data.explorationId,
              candidateId: plan.candidateId,
              label: plan.label,
              summary: plan.summary,
              metrics: result.metrics,
              previewStorageKey: result.previewStorageKey,
              status: 'rendered',
            });
            return result;
          })
      )
    );
    results.push(...batchResults);
  }
  // 只归还未被 cancel 销毁的 sandbox
  // cancel 路径会直接 destroy sandbox（不归还 pool），
  // 所以这里过滤掉已销毁的实例
  const aliveSandboxes = sandboxes.filter(sb => !sb.destroyed);
  await poolManager.release(aliveSandboxes);
  // pool manager 异步补充被销毁的 sandbox
  return results;
});
```
```

---

## 四、方案生成

### 4.1 Master Agent 生成方案骨架

Master Agent 基于用户意图 + 当前时间线状态 + Memory，生成 4 个候选方案。每个方案是一组 Commands。

**关键约束：**
- 方案之间必须有实质性差异（不是微调同一个思路）
- 方案应覆盖不同的创作方向（如：节奏、内容、结构、风格）
- 每个方案独立可行（不依赖其他方案的结果）

**Execution Plan 物化（确保 sandbox 预览 = 最终应用结果）：**

物化在**入队 pg-boss 之前**由 Exploration Engine 在 Agent 服务中完成（见 §3.3）。sandbox worker 接收的是**已物化的完整 ExecutionPlan**，只负责渲染预览，不做任何物化操作。

```
唯一的物化流程（§3.3 权威定义）：
  Master Agent 生成骨架 → Exploration Engine 物化 → 完整 ExecutionPlan → pg-boss → sandbox 渲染
```

**V1 约束：** 如果物化开销过大（如每个方案都要调生成模型），可限制 V1 的 fan-out 只支持**确定性 command 子集**（trim、split、delete、reorder、speed change、volume adjust 等），非确定性操作（AI 生成、BGM 搜索）走单路径。

**方案生成 prompt 策略：**

```
System: 你是视频编辑专家。用户给了一个模糊意图，你需要生成 4 个差异化的编辑方案。

规则：
1. 每个方案走不同的创作方向
2. 方案之间的差异要大到用户一眼能看出区别
3. 每个方案用具体的 Command 序列表达，不要抽象描述
4. 参考用户的 Memory 偏好（如有）来排序方案——最可能被选中的排第一

用户意图：{intent}
当前时间线：{serializedTimeline}
用户偏好：{memoryContext}
```

### 4.2 方案多样性保证

为防止 4 个方案趋同，使用**维度分散策略**：

```
维度空间：
├── 时长维度：不变 / 缩短 / 大幅缩短
├── 节奏维度：保持 / 加快 / 变化型
├── 内容维度：保留全部 / 精选高光 / 重新排列
├── 风格维度：原风格 / 加特效 / 极简
└── 结构维度：线性 / 非线性 / 倒叙

Master Agent 在生成前先选定 4 个差异化的维度组合，
然后按组合生成具体 Commands。
```

---

## 五、Exploration Engine

### 5.1 职责

Exploration Engine 是 fan-out 的执行层，负责：
1. 接收 4 个方案骨架（Commands + timeline snapshot + media assets）
2. 分发到 4 个 Daytona sandbox 并行执行
3. 收集预览视频 + 指标
4. 返回结果给 Chat UI

### 5.2 Daytona Sandbox Pool

维持 **4 个 warm sandbox** 常驻：

```
Sandbox Pool Manager
├── sandbox-1: WARM（Playwright 已启动，ChatCut 渲染器已加载）
├── sandbox-2: WARM
├── sandbox-3: WARM
└── sandbox-4: WARM

fan-out 请求到达
    ↓
Pool Manager 分配 4 个 warm sandbox
    ↓
每个 sandbox 执行一个方案
    ↓
执行完毕 → sandbox 回到 WARM 状态，等待下一次请求
```

**Sandbox 生命周期管理：**

```typescript
class SandboxPoolManager {
  private pool: DaytonaSandbox[] = [];
  private readonly POOL_SIZE = 4;

  // 启动时初始化 pool
  async initialize() {
    for (let i = 0; i < this.POOL_SIZE; i++) {
      const sandbox = await daytona.create({
        image: 'chatcut/preview-renderer:latest',
        // 预装: Node.js + Playwright + Chromium + FFmpeg + ChatCut 渲染器
      });
      // worker.js 是 entrypoint，sandbox 创建后自动启动
      // 等待 worker 就绪（/health 返回 WARM）
      await this.waitForHealth(sandbox);
      this.pool.push(sandbox);
    }
  }

  // 分配 sandbox（硬上限 = POOL_SIZE，不超额创建）
  async acquire(count: number): Promise<DaytonaSandbox[]> {
    if (this.pool.length < count) {
      // pool 不够 → 等待归还或冷启动补充（不超过 POOL_SIZE）
      while (this.pool.length < count && this.totalCreated < this.POOL_SIZE) {
        const sb = await this.createWarmSandbox();
        this.pool.push(sb);
        this.totalCreated++;
      }
    }
    // 仍不够 → 用可用数量（降级为部分并行）
    const available = Math.min(count, this.pool.length);
    return this.pool.splice(0, available);
  }

  // 归还 sandbox（通过 worker API 重置）
  async release(sandboxes: DaytonaSandbox[]) {
    for (const sb of sandboxes) {
      await resetSandbox(sb);  // HTTP POST /reset
      this.pool.push(sb);
    }
  }

  // 等待 worker 就绪
  private async waitForHealth(sandbox: DaytonaSandbox, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const res = await fetch(`http://${sandbox.ip}:3000/health`);
        if (res.ok) return;
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    throw new Error(`Sandbox ${sandbox.id} failed to become WARM within ${timeoutMs}ms`);
  }
}
```

**多项目调度与公平性：**

sandbox pool 是全局共享的，不是 per-project。同一时间只有一个 exploration 占用 pool（通过 pg-boss singletonKey 保证 per-project 串行，跨 project 通过 pool 容量自然限流）。

```
并发策略：
├── 同一 project → pg-boss singletonKey 保证串行（§9.4 拒绝并发）
├── 不同 project 同时请求 fan-out →
│   ├── pool 有空闲 sandbox → 分配
│   └── pool 满 → pg-boss job 排队等待（FIFO）
└── 极端场景（4+ 个 project 同时 fan-out）→ 排队，预估等待时间通过 SSE 推送

**MVP 全局互斥：** pool size = 4，同时只服务 1 个 exploration（全局，不仅 per-project）。
通过 PostgreSQL advisory lock 或 pg-boss 全局 singletonKey `exploration-global` 保证。
`acquire()` 在 advisory lock 未获取到时阻塞等待（带 30s 超时），不立即返回部分结果。

```typescript
// MVP: 全局互斥
await boss.send('exploration', payload, {
  singletonKey: 'exploration-global',  // 全局只有一个 exploration 运行
  expireInMinutes: 30,
});
```

扩展时：移除全局锁 → per-project singletonKey + 增加 pool size → 并发服务多个 exploration。
```

**空闲回收：**
- sandbox 空闲超过 30 分钟 → 自动销毁（节省资源）
- 下次 fan-out 请求时按需重建 + 预热（~200ms 冷启动 + ~2s 预热）
- 活跃用户（最近 30 分钟有操作）保持 pool 常驻

### 5.3 Sandbox 内部执行流程

每个 sandbox 接收：
- timeline JSON 副本
- 一组 Commands
- 相关媒体文件的共享缓存卷本地路径（见 §9.3）

执行流程：

```
1. 接收 Execution Plan（物化后的 Commands + resultTimeline + artifact storageKeys）
       ↓
2. 渲染器加载 resultTimeline JSON
       ↓
3. 媒体访问统一走共享缓存卷（见 §9.3）：
   渲染器 → /shared-media/{project-id}/{storageKey} → 本地磁盘读取
   （Agent 服务在项目打开时已从 R2 拉取到共享卷）
       ↓
4. Playwright 渲染 5-10s 预览视频片段（关键时间范围）
       ↓
5. 导出为 MP4 → 上传到 R2（storageKey: previews/{explorationId}/{candidateId}.mp4）
       ↓
6. 返回 { previewStorageKey, metrics }
   （存 storageKey 而非 signed URL，读取时按需 mint signed URL）
```

**预览策略（候选特异性）：**

不同类型的方案需要不同的预览方式。Master Agent 在生成 Execution Plan 时同时指定预览策略：

```typescript
// 预览策略类型——所有字段在生成时计算好，透传到 worker，worker 不做二次推导
type PreviewPolicy =
  | { type: "hotspot"; start: number; end: number }                              // 变化最密集的区间
  | { type: "before_after"; timestamps: number[]; originalTimelineJson: string } // before/after 对比
  | { type: "multi_clip"; clips: Array<{ start: number; end: number }> }         // 多段拼接
  | { type: "full_preview"; duration: number }                                    // 完整预览

function selectPreviewPolicy(
  originalTimeline: Timeline,
  modifiedTimeline: Timeline,
  candidateType: string,
): PreviewPolicy {
  const duration = modifiedTimeline.duration;

  // 短视频直接完整预览
  if (duration <= 15) return { type: "full_preview", duration };

  // 结构重排 → 多段拼接（展示重排后的顺序）
  if (candidateType === "reorder" || candidateType === "restructure") {
    const keyClips = findStructuralDiffs(originalTimeline, modifiedTimeline);
    return { type: "multi_clip", clips: keyClips.slice(0, 3) };
  }

  // 默认：变化最密集的区间
  const diffs = diffTimelines(originalTimeline, modifiedTimeline);
  const hotspot = findDensestDiffRegion(diffs, 10);
  return { type: "hotspot", start: hotspot.start, end: hotspot.end };
}
```

**音频预览：**
- 卡片默认静音自动播放
- 音乐/节奏类方案：hover 时自动启用音频（标注"此方案涉及音频变化，建议开启声音"）
- 用户可点击 🔊 按钮开启/关闭音频

### 5.4 媒体预加载

用户打开项目时，Pool Manager 预加载当前项目的媒体到 sandbox 的本地缓存：

```
用户打开项目
    ↓
Pool Manager 获取项目的 media storageKey 列表
    ↓
4 个 sandbox 各自从 R2 拉取媒体到本地缓存
    ↓
fan-out 请求到达时，媒体已在本地 → 渲染无需等待拉取
```

这样 fan-out 的主要延迟只有**渲染本身**（~3-8s），不包含媒体拉取时间。

### 5.5 超时与降级

```
正常流程：4 个 sandbox 并行 → ~5-10s 全部完成
    ↓
超时策略（30s）：
├── 3/4 完成 → 返回已完成的 3 个 + 标记第 4 个为"渲染中"
├── 2/4 完成 → 返回 2 个 + 标记其余为"渲染中"
├── 1/4 完成 → 返回 1 个 + 标记其余
└── 0/4 完成 → 降级为文字摘要（不等视频预览）

后续渲染完成后通过 SSE 推送追加结果
```

---

## 六、Chat UI 展示

### 6.1 候选卡片布局

```
┌────────────────────────────────────────────────────────┐
│  "这段太拖了" — 4 个方案供你选择                          │
│                                                        │
│  ┌─────────────┐  ┌─────────────┐                      │
│  │  [视频预览]   │  │  [视频预览]   │                      │
│  │  方案 A       │  │  方案 B       │                      │
│  │  删除静音段    │  │  整体加速1.3x │                      │
│  │  18s → 14s   │  │  18s → 14s   │                      │
│  │  [选这个]     │  │  [选这个]     │                      │
│  └─────────────┘  └─────────────┘                      │
│                                                        │
│  ┌─────────────┐  ┌─────────────┐                      │
│  │  [视频预览]   │  │  [视频预览]   │                      │
│  │  方案 C       │  │  方案 D       │                      │
│  │  保留高能量段  │  │  紧凑剪辑     │                      │
│  │  18s → 12s   │  │  18s → 10s   │                      │
│  │  [选这个]     │  │  [选这个]     │                      │
│  └─────────────┘  └─────────────┘                      │
│                                                        │
│  [都不满意，换一批]  [让我自己说具体要求]                    │
└────────────────────────────────────────────────────────┘
```

### 6.2 卡片内容

每张候选卡片包含：
- **视频预览**：5-10s 循环播放（自动播放、静音、hover 时播放音频）
- **方案标题**：2-4 字（如"紧凑剪辑"）
- **操作摘要**：一句话描述做了什么
- **关键指标**：时长变化、影响的元素数量
- **选择按钮**

### 6.3 交互流程

```
用户点击"选这个"
    ↓
Chat UI 进入微调模式（Working Copy 机制）：
├── 选中方案的物化 Commands 通过 propose() 提交到 ServerEditorCore
│   → 创建 pending changeset（用户能在时间线上看到效果）
├── 聊天框提示："方案 C 已应用到预览。你可以继续调整，或直接确认。"
├── 用户可以：
│   ├── 继续对话微调（"再快一点"、"把第 2 段保留"）
│   │   → 微调操作追加到同一 pending changeset（approveWithMods 路径）
│   ├── 手动在时间线上编辑
│   │   → 同样追加到 pending changeset
│   └── 确认 approve → changeset 整体提交（包含原始方案 + 所有微调）
└── 或点击"换一个方案"
    → reject() 当前 changeset → 回到选择界面

用户确认
    ↓
approve() → changeset 整体提交（原始 Commands + 微调编辑全部包含）
    ↓
其他 3 个候选方案的预览视频（R2 临时文件）标记为待清理
```

---

## 七、与现有架构的集成

### 7.0 预览视频访问 API

预览视频存储在 R2（storageKey: `previews/{explorationId}/{candidateId}.mp4`），但没有 `media_assets` 表记录。Chat UI 需要一个专用端点将 storageKey 转换为可播放的 signed URL：

```
GET /api/exploration/:explorationId/preview/:candidateId
    ↓
验证 exploration 归属当前用户 + 未过期
    ↓
从 R2 mint signed URL（TTL 1h，支持 Range 请求）
    ↓
返回 { url: "https://...", expiresAt: "..." }
```

Chat UI 收到 SSE `candidate_ready` 事件后，调用此端点获取可播放 URL。URL 过期后重新调用即可续签。

预览视频的清理：exploration 过期（24h TTL）后，后台任务批量删除 `previews/{explorationId}/` 下所有文件。

### 7.1 与 Changeset Manager 的关系

Fan-out 探索是 changeset 审批的**前置环节**，不替代它：

```
当前流程：
  Agent 执行 → propose() → 用户审批 → approve/reject

Fan-out 流程：
  Agent 生成候选 → Exploration Engine 渲染预览 → 用户选择
      ↓
  选中方案 → propose() → 用户微调 → approve/reject
```

fan-out 阶段不触发 `propose()`——候选方案只在 sandbox 中执行，不影响真实 ServerEditorCore。用户选择后才进入正常的 changeset 流程。

### 7.2 与 Memory Layer 的关系

Fan-out 是 Memory Layer 的强信号源，但需要防止**展示顺序偏差**导致错误的偏好学习。

```
用户从 4 个方案中选了 C（保留高能量段）
    ↓
Memory Extractor 记录：
├── 选择信号："面对'太拖了'的意图，用户选择了保留高能量段"
│   → source: implicit, status: draft
│   → 同时记录 exposure_order（C 在第 3 位展示）
│   → 如果多次选择同类方案 → 强化 → status: active
├── 跳过的方案：**不作为负面信号**
│   → 单次跳过不记录（可能只是展示顺序的影响）
│   → 只有被连续 3+ 次跳过（跨多次 fan-out）才记录为弱负面信号
└── 如果用户点了"都不满意" → 记录意图+全部候选方向 → 用于调整方案生成策略
```

**防偏差措施：**

```
1. 展示顺序随机化：
   Memory 偏好影响方案的"生成"（哪些方向优先探索），
   但不影响"展示顺序"。4 个卡片的排列每次随机。
   避免"第一个总是被选"导致的位置偏差。

2. 定期注入探索多样性：
   每 5 次 fan-out，至少 1 个候选方案来自 Memory 偏好之外的方向
   （"exploration slot"），防止偏好锁定。

3. 只记录显式选择为强信号：
   选择 = 强正面信号（draft memory）
   跳过 ≠ 负面信号（除非反复跳过）
   "都不满意" = 所有方向的弱负面信号
```

### 7.3 与 Context Synchronizer 的关系

Fan-out 过程中用户选择了方案 C，后续微调时 Context Synchronizer 需要知道：
- 用户当前的编辑状态是基于方案 C
- 方案 A/B/D 的内容不在当前上下文中

### 7.4 Exploration 状态持久化

```
PostgreSQL exploration_sessions 表：
├── exploration_id (UUID, PRIMARY KEY)
├── project_id (UUID)
├── base_snapshot_version (INT)  # 发起时的时间线版本（选择时校验）
├── user_intent (TEXT)           # 原始意图
├── candidates (JSONB)           # 4 个 Execution Plan（物化后的 Commands + resultTimeline）
├── preview_storage_keys (JSONB) # 4 个预览视频的 R2 storageKey（非 signed URL，读取时 mint）
├── selected_candidate_id (TEXT) # 用户选择的方案
├── parent_exploration_id (UUID) # 级联 fan-out 的父探索 ID（null = 第 1 层）
├── exposure_order (JSONB)       # 展示顺序（用于防偏差分析）
├── status: queued | running | partial | completed | user_selected | applied | cancelled | expired
├── created_at (TIMESTAMP)
├── expires_at (TIMESTAMP)       # 24h TTL
└── memory_signals (JSONB)       # 提取的 memory 信号
```

---

## 八、Daytona 集成细节

### 8.1 Docker 镜像

```dockerfile
# chatcut/preview-renderer:latest
FROM node:22-slim

# 复制 package.json（声明 "type": "module" + 依赖）并安装
COPY package.json package-lock.json /app/
WORKDIR /app
RUN npm ci

# 安装 Playwright Chromium 浏览器二进制
RUN npx playwright install --with-deps chromium

# 安装 FFmpeg
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# 复制 ChatCut 渲染器（静态构建）
COPY renderer-build/ /app/renderer/

# 复制 worker 进程（长驻 HTTP RPC 服务）
COPY worker.js /app/

# package.json 内容（关键字段）：
# { "type": "module", "dependencies": { "playwright": "^1.x" } }

# sandbox 启动时自动运行 worker（entrypoint）
CMD ["node", "worker.js"]
```

### 8.2 Sandbox Worker 进程（长驻服务）

**关键设计：** sandbox 内运行一个**长驻 worker 进程**（HTTP 服务），而非通过 `sandbox.exec` 一次性调用。这确保 Playwright browser 实例在进程内持续存活，多次渲染复用同一个 browser。

```javascript
// worker.js — sandbox 内的长驻服务进程（ESM）
import { chromium } from 'playwright';
import http from 'http';
import fs from 'fs';

let browser, page;

async function warmup() {
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
  await page.goto('file:///app/renderer/index.html');
  await page.waitForFunction(() => window.ChatCutRenderer?.ready === true);
}

let currentAbortController = null;

async function render(input) {
  currentAbortController = new AbortController();
  const { signal } = currentAbortController;

  // 1. 注入修改后的 timeline
  await page.evaluate((json) => {
    window.ChatCutRenderer.loadTimeline(JSON.parse(json));
  }, input.modifiedTimelineJson);

  // 2. 设置媒体源（共享缓存卷的本地路径）
  await page.evaluate((mediaMap) => {
    window.ChatCutRenderer.setMediaSources(mediaMap);
  }, input.mediaSources);

  // 3. 按 previewPolicy 渲染
  let videoBuffers = [];
  const policy = input.previewPolicy;

  if (policy.type === "full_preview") {
    videoBuffers.push(await renderRange(0, policy.duration));
  } else if (policy.type === "hotspot") {
    videoBuffers.push(await renderRange(policy.start, policy.end));
  } else if (policy.type === "multi_clip") {
    // 多段拼接：渲染每段 → FFmpeg concat
    for (const clip of policy.clips) {
      if (signal.aborted) throw new Error('ABORTED');
      videoBuffers.push(await renderRange(clip.start, clip.end));
    }
  } else if (policy.type === "before_after") {
    // 原始 timeline 和修改后各渲染关键帧 → 拼接为对比视频
    // 需要原始 timeline 也传入（input.originalTimelineJson）
    videoBuffers.push(await renderBeforeAfter(policy.originalTimelineJson, input.modifiedTimelineJson, policy.timestamps));
  }

  if (signal.aborted) throw new Error('ABORTED');

  // 4. 合并多段 → 保存 → 上传 R2
  const finalVideo = videoBuffers.length > 1
    ? await concatWithFFmpeg(videoBuffers)
    : videoBuffers[0];
  const tempPath = `/tmp/preview-${Date.now()}.mp4`;
  fs.writeFileSync(tempPath, Buffer.from(finalVideo));
  const storageKey = await uploadToR2(tempPath, input.previewStorageKey);
  fs.rmSync(tempPath, { force: true });

  currentAbortController = null;
  return { previewStorageKey: storageKey, metrics: input.metrics };
}

async function renderRange(start, end) {
  return await page.evaluate(async ({ start, end }) => {
    return await window.ChatCutRenderer.renderRange(start, end);
  }, { start, end });
}

async function reset() {
  await page.evaluate(() => window.ChatCutRenderer.reset());
}

// HTTP RPC 服务
const server = http.createServer(async (req, res) => {
  // 无 body 的控制端点
  if (req.url === '/health') {
    res.end('WARM');
    return;
  }
  if (req.url === '/abort') {
    if (currentAbortController) currentAbortController.abort();
    res.end('OK');
    return;
  }
  if (req.url === '/reset') {
    await reset();
    res.end('OK');
    return;
  }

  // 有 body 的端点
  if (req.url === '/render') {
    const body = await readBody(req);
    const input = JSON.parse(body);
    try {
      const result = await render(input);
      res.end(JSON.stringify(result));
    } catch (e) {
      if (e.message === 'ABORTED') {
        res.writeHead(499); res.end('ABORTED');
      } else {
        res.writeHead(500); res.end(e.message);
      }
    }
    return;
  }

  res.writeHead(404); res.end('Not Found');
});

// 启动
await warmup();
server.listen(3000);
console.log('Worker ready on :3000');
```

**Exploration Engine 与 sandbox worker 的交互：**

```typescript
// Exploration Engine 通过 HTTP 调用 sandbox worker
async function renderInSandbox(sandbox: DaytonaSandbox, plan: ExecutionPlan): Promise<PreviewResult> {
  const response = await fetch(`http://${sandbox.ip}:3000/render`, {
    method: 'POST',
    body: JSON.stringify({
      modifiedTimelineJson: plan.resultTimeline,
      mediaSources: plan.mediaSources,
      previewPolicy: plan.previewPolicy,  // 透传完整 policy（含 start/end/duration/timestamps/originalTimelineJson）
      previewStorageKey: `previews/${plan.explorationId}/${plan.candidateId}.mp4`,
      metrics: plan.expectedMetrics,
    }),
  });
  return response.json();
}

async function resetSandbox(sandbox: DaytonaSandbox): Promise<void> {
  await fetch(`http://${sandbox.ip}:3000/reset`, { method: 'POST' });
}
```

### 8.5 成本估算

```
Daytona 自部署成本（4 个 warm sandbox）：
├── 4 × ~512MB RAM = ~2GB 常驻内存
├── 4 × Chromium 进程 = ~1GB 额外
├── 总计 ~3GB RAM 常驻
└── 按需扩展：每额外 sandbox ~750MB

每次 fan-out 成本：
├── 计算：4 × ~5-10s 渲染 ≈ 20-40s CPU
├── 存储：4 × ~5MB 预览视频 = ~20MB（24h TTL）
├── 带宽：媒体拉取（预加载时已完成）+ 预览上传
└── 总计：主要成本是 sandbox 的常驻资源

对比 E2B 托管：
├── E2B: ~$0.05-0.25/次 fan-out
├── 自部署: 固定服务器成本，边际成本接近 0
└── 日均 100+ 次 fan-out 时自部署更划算
```

---

## 九、设计决策（已确定）

### 9.1 方案差异度保证

**策略：生成前约束 + 生成后检测，最多重试 1 次。**

```
Step 1: 生成前约束
  Master Agent 在生成方案前，先选定 4 个差异化的维度组合：
  例：[时长-大幅缩短, 节奏-加快, 内容-精选高光, 结构-重排]
  强制每个方案走不同维度，从 prompt 层面保证差异

Step 2: 生成后检测
  对比每对方案的 timeline diff：
  - 计算每对方案的元素级操作重叠度
  - 如果任意两个方案的 diff 重叠度 > 70% → 触发重试

Step 3: 重试（最多 1 次）
  - 将重叠的方案对标记为"太相似"
  - Master Agent 为重叠方案重新生成，指定必须走不同维度
  - 如果重试后仍重叠 → 接受（不无限循环），用文字标注方案间的差异点
```

### 9.2 渲染器复用

**决策：复用 Phase 4 的 Playwright 无头渲染服务。**

Phase 4 已经需要搭建 Playwright 无头渲染（用于服务端预览和导出）。Fan-out 的 sandbox 使用**同一套渲染器打包产物**：

```
Phase 4 Playwright 渲染服务
├── 在 Agent 服务上：单实例，用于正常预览/导出
└── 在 Daytona sandbox 中：多实例，用于 fan-out 并行渲染

两者加载同一个渲染器静态构建（ChatCut 前端打包为独立 HTML + JS + CSS）
区别只是运行环境（Agent 服务 vs sandbox）
```

渲染器独立打包要求：
- 不依赖 Next.js 服务端（纯静态 HTML，Playwright 通过 `file://` 加载）
- 媒体源通过 `setMediaSources()` 注入（共享缓存卷的本地文件路径）
- timeline 状态通过 `loadTimeline()` 注入

### 9.3 媒体访问策略

**决策：Daytona sandbox 与 Agent 服务同机/同数据中心部署，共享媒体缓存卷。**

```
同一服务器部署：
├── Agent 服务进程
├── Daytona sandbox pool（4 个）
├── 共享媒体缓存卷（bind mount 到每个 sandbox）
│   └── /shared-media/{project-id}/  ← 4 个 sandbox + Agent 服务共同读取
└── R2 / MinIO 存储

媒体流转：
1. 用户上传 → R2
2. 项目打开时 Agent 服务按需从 R2 拉取到共享缓存卷
3. Sandbox 通过 bind mount 直接读取 → 本地磁盘速度，无网络开销
4. 不需要预加载到每个 sandbox → 不需要 4 倍存储
```

大文件项目（10GB+）也不是问题——只拉取一份到共享卷。

### 9.4 并发 fan-out

**决策：per-project 串行，一次只能有一个 fan-out 进行中。**

通过 pg-boss `singletonKey: exploration-${projectId}` 保证同一 project 不会有两个 exploration 同时运行。

```
用户发起 fan-out 请求
    ↓
检查当前是否有活跃的 exploration（status in [queued, running, partial, completed]）
├── 有 → 返回 "上一个探索还在进行中，请稍等或取消后重试"
│        Chat UI 提供"取消当前探索"按钮
└── 没有 → 入队 pg-boss job → 正常执行

用户点击"取消"
    ↓
1. pg-boss.cancel(jobId)
2. 对所有已分配 sandbox 发送 POST /abort
3. 不等 abort 完成——直接销毁 sandbox 实例（kill + destroy）
   （worker 内的 renderRange 是 non-interruptible await，
    /abort 只能在步骤间生效，无法保证立即停止。
    为避免 reuse race，取消时直接销毁而非归还 pool。）
4. Pool manager 异步补充新 sandbox 到 pool（冷启动 ~200ms + 预热 ~2s）
5. exploration_session.status = cancelled
6. 抑制后续 SSE 推送（cancelled 的 exploration 不推送结果）
    ↓
可以发起新的 fan-out
```

### 9.5 级联 fan-out

**决策：支持，最多 2 层。**

```
第 1 层：用户说"这段太拖了" → fan-out 4 个方案 → 用户选 C
第 2 层：用户说"C 不错但还能更紧凑" → 基于 C 的 timeline 再 fan-out 4 个方案
第 3 层：不支持 → 转为单路径微调模式

实现：exploration_session 记录 parent_exploration_id
├── parent_exploration_id = null → 第 1 层
├── parent_exploration_id = 第 1 层 ID → 第 2 层
└── parent_exploration_id 已经有 parent → 拒绝，提示用户直接微调
```

Memory 信号叠加：
- 第 1 层选择 = 大方向偏好（"偏好保留高能量段"）
- 第 2 层选择 = 细化偏好（"在高能量段基础上偏好更紧凑"）
- 两层信号都记录到 Memory Layer

---

## 十、实施节奏

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 4 中期 | `explore_options` tool 定义 + Master Agent fan-out 触发逻辑 | Phase 4 Master Agent |
| Phase 4 中期 | Exploration Engine 骨架 + Daytona sandbox pool manager | Daytona 部署 |
| Phase 4 中期 | ChatCut 渲染器独立打包（可在 sandbox 中运行） | Phase 4 Playwright 渲染 |
| Phase 4 后期 | Chat UI 候选卡片展示 + 选择 + 微调流程 | Phase 4 Chat UI |
| Phase 4 后期 | 预览视频渲染管线（sandbox 内 Playwright → MP4 → R2） | Daytona + Playwright |
| Phase 4 后期 | Memory Extractor fan-out 信号采集 | Phase 4 Memory Layer |
| 持续优化 | 方案差异度保证 + 媒体预加载 + 超时降级 | 使用数据驱动 |
