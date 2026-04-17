# ChatCut 执行计划

基于 [chatcut-architecture.md](./chatcut-architecture.md) 和 [chatcut-research.md](./chatcut-research.md) 的调研与架构设计，制定可执行的开发计划。详细设计文档：[Memory Layer](./chatcut-memory-layer.md) | [Fan-out 探索](./chatcut-fanout-exploration.md) | [Agent System](./chatcut-agent-system.md)。

---

## 一、项目概述

### 目标

开发 ChatCut——AI 驱动的视频编辑器，用户用自然语言指挥 AI 剪辑，人类在环微调。

### 产品理念

**Agent First，人类在环纠偏。** Agent 是主要操作者，人类通过 UI 审批和微调。这决定了整个架构——数据和媒体以服务端为主，客户端是瘦预览层。

### 前提

- ChatCut 是独立项目（新仓库），不是在 OpenCut 上直接修改
- 面向 human 的编辑 UI 和核心逻辑从 OpenCut 按需搬运
- 技术栈沿用 OpenCut：Next.js + React + TypeScript + Zustand + Radix UI
- **存储架构：服务端优先**（详见 1.1 节）
- creative-engine 已有 AI 生成 API 封装（Kling / Veo / Seedance）可复用

### 1.1 存储架构：服务端优先

OpenCut 是客户端优先（媒体存 IndexedDB/OPFS），ChatCut 作为 Agent First 产品需要反过来：

```
                   服务端（Source of Truth）
                   ──────────────────────
媒体文件      →    对象存储（R2 / S3）
项目/时间线   →    PostgreSQL（Drizzle ORM）
Agent 会话    →    PostgreSQL
Change Log    →    PostgreSQL
生成任务      →    PostgreSQL + 任务队列

                   客户端（瘦预览层）
                   ──────────────
媒体预览      →    从对象存储按需拉取流式播放
时间线状态    →    从 PostgreSQL 拉取，本地 Zustand 缓存
编辑操作      →    写回服务端，服务端广播到 Agent
IndexedDB     →    仅作为客户端缓存层（加速预览），不是 source of truth
```

**媒体生命周期：**

```
用户上传视频 → 上传到对象存储（R2/S3）→ 返回 storageKey
                    ↓
Agent 服务通过 downloadToTempFile(storageKey) 读取 → 分析（Gemini）/ 提取帧 / 生成替换
                    ↓
生成的新片段 → 存回对象存储 → storageKey 写入时间线
                    ↓
客户端浏览器 → 从对象存储流式拉取 → 预览播放
             → 人类纠偏操作 → 写回服务端 → Change Log 记录
```

**对 OpenCut 代码的影响：** OpenCut 的 MediaManager 和 Storage 服务需要改造——从直接读写 IndexedDB 改为通过 API 读写对象存储。VideoCache 保留作为客户端缓存层。

### 关键架构决策（已在 architecture 文档确定）

| 决策 | 说明 |
|------|------|
| 不做 Rust 重写 | 在 TypeScript 基础上改造，Tauri 路线留后期 |
| MVP 不需要 SAM2 | 帧序列 + prompt 直送生成模型，不做像素级分割 |
| Gemini 驱动视频理解 | 一步完成语义分割 + 内容描述，替代传统盲切 |
| Agentic 而非 DAG | 完全 agentic 架构，不用预定义 workflow |
| 全部 Agent SDK | Master + 所有 Sub-agent 统一用 Claude Agent SDK，Gemini 降级为 Vision Agent 的 tool（详见 [agent-system §2](./chatcut-agent-system.md)） |
| Human-in-the-Loop | Change Log + Context Synchronizer 双向上下文同步 |
| Memory Layer | 语义路由文件系统 + R2 存储，Agent 持久化认知层（详见 [memory-layer](./chatcut-memory-layer.md)） |
| Memory → Skill 飞轮 | Memory 积累后自动结晶为可复用 Skill，R2 `_skills/` 为唯一 Skill 存储 |
| Fan-out 探索 | 模糊意图 → 并行生成 4 个候选方案 → 视频预览 → 用户选择（详见 [fanout](./chatcut-fanout-exploration.md)） |
| Agent System | 全部 Claude Agent SDK + AgentRuntime 封装层 + dispatch-scoped 写锁（详见 [agent-system](./chatcut-agent-system.md)） |

### 开发过程中决策的技术问题

| 问题 | 决策 | 理由 |
|------|------|------|
| Headless 渲染 | 混合：数据层 Node.js + 渲染层 Playwright | 渲染管线深度依赖浏览器 API（WebCodecs / OffscreenCanvas / WebGL / Web Audio），纯 Node.js 跑不了 |
| 帧分辨率策略 | 按 provider 最大输入分辨率自动适配 | 只在超出时降采样，保持宽高比 contain 策略 |
| 生成片段与原视频对齐 | 利用已有渲染管线，不额外转码 | OpenCut 的 contain 缩放 + WebCodecs 已能处理混合规格时间线 |
| TTS 服务 | xAI，复用已有 skill | 已有封装，无需重新选型 |
| 内容编辑 undo | 新建 ReplaceSegmentCommand，快照式 undo | 替换操作边界情况多（时长不匹配、关键帧分配等），快照式比组合式 undo 更稳 |
| 部署架构 | Vercel（前端）+ 独立 Agent 服务 | Agent 长任务超出 Vercel Functions 30s 限制，需要独立服务 |

---

## 二、Phase 依赖图

```
Phase 0: 项目搭建 + OpenCut 核心搬运 + 存储架构
            ↓
Phase 1: API 化 + Change Log
            ↓
        ┌───┴───┐
Phase 2  Phase 3    (并行，互不依赖)
生成链路  视频理解
+Agent骨架
        └───┬───┘
            ↓
Phase 4: 多 Agent 系统 + Chat UI
            ↓
Phase 5: 资产管理系统
```

Phase 2 和 Phase 3 互不依赖，可并行推进。Phase 2 期间同时搭建 Agent 骨架（tool schema + executor），为 Phase 4 铺路。

---

## 三、Phase 0 — 项目搭建 + OpenCut 核心搬运 + 存储架构

### 目标

新建 ChatCut 项目，搭建服务端优先的存储架构，从 OpenCut 搬运核心编辑能力。

### 3.1 项目脚手架

- 初始化 monorepo（Bun + Turborepo），主应用位于 `apps/web/src/`（沿用 OpenCut 结构）
- 搭建 Next.js 应用骨架
- 配置 TypeScript、Biome、Tailwind CSS
- 配置 PostgreSQL + Drizzle ORM
- 配置 Better Auth 认证
- 配置对象存储（Cloudflare R2 或 AWS S3）
- **配置 Memory Layer R2 存储路径**（`chatcut-memory/{user-id}/`），定义 `_schema.md` 和顶层 `_index.md`（详见 [memory-layer §10](./chatcut-memory-layer.md#十存储实现)）
- 配置测试框架（Vitest）
- **搭建最小 Editor 服务**（独立 Node.js 进程，承载 ServerEditorCore），落地 server-authoritative 架构的基础设施：
  - `POST /commands` — 接收 command intent（必须携带 `baseSnapshotVersion`），版本匹配才执行并 commitMutation，不匹配返回 409
  - `GET /project/:id` — 返回最新 committed 快照
  - `GET /events` — SSE 事件流（状态变更广播）
  - 项目级写锁
  - 客户端 optimistic ack/reconcile 基础框架

> **为什么前移：** Plan 从 Phase 0 起就假设"所有变更经过服务端"，但如果 Editor 服务到 Phase 4 才搭建，Phase 0-3 无法验证核心的 server-authoritative 架构。前移后 Phase 4 只需叠加 Master/Sub-agent 和 Chat UI。

> **路径约定：** 本文档中 `src/` 路径均指 `apps/web/src/`（前端）。Agent 服务代码位于 `apps/agent/src/`。共享核心（ServerEditorCore + Commands + Change Log）位于 `packages/core/src/`。完整项目结构见 [agent-system §项目结构](./chatcut-agent-system.md)。

### 3.2 存储架构搭建

Phase 0 需要先落地服务端优先的存储架构，这是后续所有 Phase 的基础：

**3.2.1 对象存储服务**

**新增文件：** `src/services/object-storage.ts`

```typescript
class ObjectStorageService {
  // 上传媒体文件，返回不可变 storage key
  upload(file: File | Blob, options: { path: string }): Promise<{ storageKey: string }>

  // 服务端直接读取（Agent/FFmpeg 用，不走 URL，全程流式避免 OOM）
  // 唯一的服务端媒体消费路径：流式落临时文件（大文件安全，避免 OOM）
  downloadToTempFile(storageKey: string): Promise<{ tempPath: string; cleanup: () => void }>

  // 客户端预览用（带 TTL 的临时 URL，不保存在业务状态中）
  getSignedUrl(storageKey: string, expiresIn?: number): Promise<string>

  // 删除媒体文件
  delete(storageKey: string): Promise<void>
}
```

> **Asset 身份与访问分离：** 每个媒体文件有一个不可变的 `storageKey`（如 `projects/abc/media/xyz.mp4`），这是资产的持久身份。Commands 和数据库中引用 `storageKey`，不存储 URL。服务端通过 `downloadToTempFile()` 流式落盘后消费（不在内存中持有大文件）。客户端通过 media URL resolver 按需获取 signed URL（支持续签、Range 请求、CORS），不把 signed URL 当成稳定引用保存在业务状态中。

**3.2.2 MediaManager 改造**

OpenCut 的 MediaManager 直接读写 IndexedDB。ChatCut 需要改为：
- 上传：`用户选择文件 → 上传到对象存储 → 数据库记录 storageKey`
- 读取：`客户端通过 signed URL 流式拉取 → VideoCache 缓存解码帧`
- Agent 访问：`Agent 服务通过 downloadToTempFile(storageKey) 读取，无需经过客户端`

**3.2.3 媒体上传 API**

**新增文件：** `src/app/api/media/upload/route.ts`

```
POST /api/media/upload-session → 签发上传凭证（presigned URL），不写 DB
                                 客户端直传对象存储（multipart presigned upload / tus resumable）
POST Agent服务/media/finalize  → 校验 checksum/size → 写 media_assets → 返回 { mediaId, storageKey }
GET  Agent服务/media/:id       → 返回 signed URL（客户端预览用）
DELETE Agent服务/media/:id     → 检查时间线引用 → 无引用则删除；有引用则拒绝（400）

> 媒体写入（finalize/delete）由 Agent 服务执行，Vercel 只签发上传凭证（只读）。
```

### 3.3 项目状态同步模型

Agent First 架构下，项目状态的流转需要明确定义：

**3.3.1 存储模型：快照 + 事件日志混合**

```
PostgreSQL
├── projects 表         → 项目元数据 + 最新时间线状态快照（JSON）
├── change_log 表       → 所有变更事件的持久化日志（append-only）
├── media_assets 表     → 媒体文件元数据 + storageKey（不可变资产标识）
└── agent_sessions 表   → Agent 会话记录
```

**每次 committed mutation 都在同一事务中更新快照 + Change Log（commitMutation）：**

```typescript
async function commitMutation(command: Command, changeEntry: ChangeEntry) {
  // 1. 克隆完整 runtime（timeline state + CommandManager history + pending boundary）
  const clonedRuntime = serverEditorCore.cloneRuntime();
  // 2. 在克隆 runtime 上执行 command（不修改 live runtime）
  clonedRuntime.executeCommand(command);
  // command 产生的 undo 元数据、history entry、boundary cursor 都在 clonedRuntime 中

  // 3. 持久化到数据库（事务）
  await db.transaction(async (tx) => {
    await tx.insert(change_log, changeEntry);
    await tx.update(projects, {
      timeline_snapshot: clonedRuntime.getTimelineState(),
      lastCommittedChangeId: changeEntry.id,
      snapshotVersion: sql`snapshot_version + 1`,
    });
  });

  // 4. 事务成功后，原子替换整个 live runtime
  serverEditorCore.replaceRuntime(clonedRuntime);
  // 如果事务失败（抛异常），live runtime 不变，与 DB 一致
}
```

**Clone-then-commit 的执行单位是完整 runtime**（不仅是 timeline snapshot）：包含 timeline state、CommandManager history 栈、pending boundary cursor、undo 元数据。事务成功后原子替换整个 runtime。事务失败时 live runtime 不变。

同样的语义适用于 approve()（克隆 → 事务 → 替换）和 reject()（从 committed 快照重建克隆 runtime → 事务 → 替换）。这确保 clone-then-commit 后 undo/redo 与 changeset 边界语义仍然正确。

**3.3.2 单一权威历史：所有变更经过服务端**

Agent First 架构下，服务端的 `ServerEditorCore` 持有唯一权威的 CommandManager 和时间线状态。人类和 Agent 的编辑都通过服务端执行，不存在客户端/服务端"双脑历史"：

```
人类在客户端编辑:
  UI 操作 → 客户端乐观渲染（即时反馈）
         → 发送 command intent 到 Agent 服务
         → ServerEditorCore 执行 → Change Log 追加（source: "human"）
         → PostgreSQL 持久化
         → SSE 广播给客户端 → 确认/校正乐观渲染

Agent 在服务端编辑:
  Agent tool call → ServerEditorCore 执行
    → Change Log 追加（source: "agent", changesetId: 当前 changeset）
    → PostgreSQL 持久化
    → SSE 广播给客户端 → UI 更新
```

两者走同一个 ServerEditorCore + CommandManager，单一权威历史栈。审批、冲突检测都基于这一个栈。

> **Undo/redo 是 session-scoped：** CommandManager 的 undo/redo 历史栈仅在当前服务进程生命周期内有效。服务重启后从最新 committed 快照重建，历史栈从空开始。这是可接受的——持久化的是快照和 Change Log（用于审计和 Agent 上下文），不是可重放的 command 历史。

> **单实例执行模型：** MVP 阶段每个 Agent 服务部署承载所有项目的 ServerEditorCore 实例（每个活跃项目一个实例，内存中）。不做多实例 scale-out。未来扩展策略：每个项目 sticky routing 到固定实例，或用 PostgreSQL advisory lock 实现 per-project single-writer 语义。

> **乐观渲染：** 客户端可以在发送 command 后立即本地渲染效果（降低感知延迟），服务端确认后更新。如果服务端拒绝（如冲突），客户端回滚乐观渲染。Agent First 产品中人类编辑频率低，网络延迟可接受。

**3.3.3 客户端加载/重连 Hydration**

```
客户端首次加载:
  GET Agent服务/project/:id → 返回最新 committed 快照 → Zustand store 初始化 → 渲染
  （不需要 replay，快照即完整状态）

客户端断线重连:
  GET Agent服务/project/:id → 返回最新 committed 快照 → 重新初始化
  （不做 command replay——Command.execute() 生成 UUID 和读取状态，重放不确定）
  快照与 lastCommittedChangeId 在同一事务中持久化，保证一致性

活跃审批会话中的客户端:
  SSE 接收 pending 状态的 Change Log 摘要（用于展示 Agent 提议效果）
  收到 approve/reject 事件后，拉取最新快照更新状态
```

### 3.4 从 OpenCut 搬运的模块

搬运优先级：先搬最小可用集（EditorCore + 基础 Commands + 渲染 + 存储），特效/动画/高级 UI 可后续补齐。

**搬运时的关键改造——ServerEditorCore 拆分：**

OpenCut 的 EditorCore 是浏览器端硬单例，Commands 通过 `EditorCore.getInstance()` 获取实例。ChatCut 需要拆分为：

```
ServerEditorCore（服务端，Agent + 人类编辑共用）
├── TimelineManager      — 轨道/元素 CRUD
├── CommandManager        — 命令执行 + undo/redo 历史栈
├── ScenesManager         — 多场景管理
├── MediaManager          — 媒体元数据（改造为对象存储）
├── ProjectManager        — 项目元数据
├── SelectionManager      — no-op 适配器（Commands 如 SplitElements 读写 selection）
├── SaveManager           — no-op 适配器（Commands 如 UpdateProjectSettings 调用 markDirty）
└── ChangeLog             — 变更日志（Phase 1 新增）

EditorCore（客户端，UI 预览用，继承 ServerEditorCore）
├── PlaybackManager       — 播放控制（浏览器 API）
├── RendererManager       — 渲染管线（Canvas + WebGL）
├── AudioManager          — 音频播放（Web Audio API）
├── SelectionManager      — 完整实现（覆盖 ServerEditorCore 的 no-op）
└── SaveManager           — 完整实现（覆盖 ServerEditorCore 的 no-op）
```

**具体改造工作量（经代码审计确认）：**

| 改造项 | 规模 | 说明 |
|--------|------|------|
| 去单例化 | 37 个 command 文件调用 `EditorCore.getInstance()` | 改为构造函数注入 `ServerEditorCore` 实例 |
| MediaAsset 去浏览器化 | `MediaAsset` 类依赖 `File` / `ObjectURL` | 改为 asset handle（immutable storage key），浏览器端按需生成 signed URL |
| Storage 抽象 | IndexedDB/OPFS 直接引用 | 服务端用 PostgreSQL + 对象存储，客户端保留 IndexedDB 作缓存 |
| Manager 隔离 | PlaybackManager 等引用 `window`/`document` | 通过接口隔离，ServerEditorCore 不加载浏览器 Manager |
| UI 组件审计 | `packages/ui/` 只含图标 | 实际 UI 组件在 `apps/web/src/components/ui/`，搬运时注意路径 |

| 状态 | 模块 | 来源路径 | 改造说明 |
|------|------|----------|----------|
| 重度改造 | EditorCore → ServerEditorCore + EditorCore | `core/` | 拆分数据层和浏览器层 |
| 重度改造 | Command 系统（37+ 文件） | `lib/commands/` | 去单例化，注入 ServerEditorCore 实例 |
| 改造 | MediaAsset / MediaManager | `core/managers/media-manager.ts` | File/ObjectURL → asset handle + 对象存储 |
| 直接搬运 | 渲染管线 | `services/renderer/` | 客户端预览用，不改 |
| 改造 | Video Cache | `services/video-cache/` | 从 signed URL 拉取替代本地 File |
| 改造 | Storage | `services/storage/` | 从主存储改为客户端缓存层 |
| 直接搬运 | 时间线 UI 组件 | `components/editor/` | — |
| 改造 | Zustand Stores | `stores/` | 改时间线状态的入口需经过 client adapter（command intent → server → SSE reconcile） |
| 改造 | Hooks | `hooks/` | 涉及 mutation 的 hooks 需走 command intent 路径 |
| 改造 | Actions 系统 | `lib/actions/` | 所有 editing actions 改为发送 command intent 到 Editor 服务 |
| 直接搬运 | Types + Constants | `types/`, `constants/` | — |
| 直接搬运 | Animation / Keyframe | `lib/animation/` | — |
| 直接搬运 | Effects | `lib/effects/` | — |
| 直接搬运 | Media 工具 | `lib/media/` | — |
| 直接搬运 | DB Schema + Auth | `lib/db/`, `lib/auth/` | — |
| 直接搬运 | UI 组件 | `components/ui/` (不是 `packages/ui/`) | 注意正确来源路径 |
| Phase 4 搬 | Transcription 服务 | `services/transcription/` | Phase 4 Audio Agent 开发前搬运 |
| 不搬 | Landing / Branding / Changelog 页面 | `app/(marketing)/` | — |

### 3.5 验证标准

- [ ] 新项目能启动，无编译/运行时错误
- [ ] 对象存储配置完成，能上传/下载/删除媒体文件
- [ ] 能创建新项目、上传视频到对象存储、添加到时间线
- [ ] 客户端能通过 signed URL 流式预览视频
- [ ] 能在时间线上执行基本操作（裁剪、分割、移动、删除）
- [ ] 能预览播放
- [ ] 能导出 MP4 视频（浏览器端，通过 WebCodecs + MediaBunny——服务端导出在 Phase 4 Playwright）
- [ ] undo/redo 正常工作
- [ ] 数据库连接正常，项目能保存和加载
- [ ] ServerEditorCore 能在 Node.js 环境实例化，不依赖浏览器 API
- [ ] Commands 通过注入的 ServerEditorCore 实例执行（不依赖 getInstance()）
- [ ] 测试框架（Vitest）配置完成，ServerEditorCore 冒烟测试通过
- [ ] Editor 服务 POST /commands 能接收 command intent 并执行
- [ ] 客户端 command intent → 服务端执行 → SSE 广播 → 客户端更新 链路跑通
- [ ] 大文件（>500MB）通过 presigned URL 直传对象存储成功
- **Failure-mode 验证：**
- [ ] 服务重启后从 committed 快照恢复，客户端重连后状态一致
- [ ] 对象存储上传成功但 DB finalize 失败时，不产生孤立媒体记录

---

## 四、Phase 1 — API 化 + Change Log

### 目标

让 EditorCore 从"只能被 UI 驱动"变成"可编程的视频编辑引擎"，同时植入 Change Log 作为 Human-in-the-Loop 的基础。

### 4.1 时间线状态序列化

**新增文件：** `src/agent/state-serializer.ts`

将时间线状态压缩为 token 友好的 JSON，只暴露 Agent 决策需要的字段：

```typescript
serializeTimeline(state: TProject): AgentTimelineView

// 输出示例：
{
  scenes: [{
    id, name,
    tracks: [{
      id, type, muted, hidden,
      elements: [{ id, name, type, startTime, duration, trimStart, trimEnd }]
    }]
  }],
  duration: 18.5,
  currentTime: 3.2
}
```

不传 transform 细节、动画数据、特效参数。Agent 需要时通过 `get_element_info` 单独查询。

### 4.2 EditorCore API 包装

**改造文件：** `src/core/index.ts`

在 EditorCore 上新增面向 Agent 的调用路径：

```typescript
class EditorCore {
  // 现有 UI 路径（不改）
  executeCommand(command: Command) {
    this.commandManager.execute(command, { source: "human" });
  }

  // 新增 Agent 路径（底层构建块）
  executeAgentCommand(command: Command, agentId: string) {
    this.commandManager.execute(command, { source: "agent", agentId });
  }
}
```

> **与 Phase 4 ChangesetManager 的关系：** `executeAgentCommand` 是底层 API，直接执行 Command。Phase 4 的 `ChangesetManager` 在其之上加审批层——`propose()` 内部调用 `executeAgentCommand` 临时执行（让用户预览效果），`approve()` 正式提交到历史，`reject()` 回滚。两者是分层关系，不是替代关系。

### 4.3 Change Log 模块

**新增文件：** `src/core/change-log.ts`

```typescript
// Change Log 是纯 append-only，没有 status 字段。
// 条目的 committed/pending/rejected 状态从决策事件派生。
interface ChangeEntry {
  id: string;
  timestamp: number;
  source: "human" | "agent" | "system";
  agentId?: string;
  changesetId?: string;          // 关联的 changeset（agent 操作 + review tweaks）
                                 // 无 changesetId 的 human 条目 = 自动 committed

  // 结构化动作（机器可读）
  action: { type, targetType, targetId, details };

  // 自然语言摘要（Agent 可读）
  summary: string;  // "用户删除了「咖啡师特写」"
}

// 决策事件（也是 ChangeEntry，用于标记 changeset 终态）
interface ChangesetDecisionEntry extends ChangeEntry {
  action: { type: "changeset_committed" | "changeset_rejected", targetType: "changeset", targetId: changesetId };
}

class ChangeLog {
  record(command, metadata, state): void       // append-only，不修改已有条目
  emitDecision(changesetId, decision): void    // 追加 changeset_committed / changeset_rejected 事件
  getAfter(lastId): ChangeEntry[]
  getCommittedAfter(lastId): ChangeEntry[]     // 派生视图，见下方语义定义
  subscribe(callback): unsubscribe
}
```

> **不可变原则：** Change Log 是 append-only。approve/reject 不修改已有 pending 条目的 status 字段，而是追加新的决策事件（`changeset_committed` / `changeset_rejected`）。客户端和 Agent 通过订阅这些事件感知审批结果。

**改造文件：** `src/core/managers/commands.ts`

- `execute()` 接受 `{ source, agentId }` 元数据
- 执行后写 Change Log
- ~25 种 Command 各一个模板字符串生成 summary

### 4.4 Job Queue 基础设施

**新增文件：** `src/agent/services/job-queue.ts`

长耗时操作（Gemini 分析、视频生成、FFmpeg 处理、Playwright 渲染）需要异步执行。使用 **pg-boss**（成熟的 PostgreSQL-native job queue 库）：

```typescript
import PgBoss from 'pg-boss';
const boss = new PgBoss(connectionString);

// 入队
await boss.send('generate-video', { projectId, prompt, provider }, {
  singletonKey: jobId,     // 幂等：相同 key 不重复入队
  retryLimit: 3,           // 自动重试
  retryBackoff: true,      // 指数退避
  expireInMinutes: 30,     // 超时 → 标记 failed
});

// 消费
await boss.work('generate-video', { newJobCheckInterval: 1000 }, async (job) => {
  // job.data = payload
  // 通过 SSE 推送进度
});
```

pg-boss 提供的开箱能力：
- `FOR UPDATE SKIP LOCKED` 消费模型（并发安全）
- Worker lease + heartbeat + stuck job 自动回收
- 取消支持（`boss.cancel(jobId)`）
- Dead letter queue（超时/重试超限）
- 持久化到 PostgreSQL `pgboss.*` 表（崩溃后可恢复）
- 幂等 `singletonKey`

Phase 2/3/4 的所有异步操作（generateVideo、analyzeVideo、exportVideo 等）都通过此 queue 执行。

### 4.5 帧序列提取 API

服务端和客户端使用不同的帧提取实现：

**服务端（Agent 使用）：** `src/agent/frame-extractor.ts`

```typescript
// 服务端用 FFmpeg 提取帧（不依赖浏览器 API）
async function extractFramesServer(options: {
  storageKey: string;
  timeRange: [start, end];
  fps?: number;
  maxWidth?: number;
}): Promise<{ frames: Buffer[], timestamps: number[] }>
// 内部流程：
// 1. objectStorage.downloadToTempFile(storageKey) → 流式落临时文件（不整块加载到内存）
// 2. ffmpeg -i <临时文件> -ss <start> -t <duration> -vf scale=<maxWidth>:-1 frame_%03d.png
// 3. 读取帧文件 → cleanup() 清理临时文件
```

> **服务端媒体读取统一方案：** 所有服务端媒体消费（FFmpeg、Gemini、Playwright）统一走 `objectStorage.downloadToTempFile(storageKey) → 流式落临时文件 → 工具消费 → cleanup()`。全程流式，不整块加载到内存，避免大文件 OOM。导出结果也写临时文件后上传到对象存储，返回 storageKey，不在内存中持有 ArrayBuffer。

依赖新增：`fluent-ffmpeg`（Node.js FFmpeg wrapper），Agent 服务器需安装 FFmpeg。

**客户端（预览用）：** 保留 VideoCache 的解码能力，从 signed URL 拉取视频流。

### 4.6 片段替换 API

**新增文件：** `src/agent/segment-replacer.ts`

```typescript
replaceSegment(options: {
  elementId: string;
  timeRange: [start, end];
  newMedia: Blob | string;
}): Promise<void>
```

**使用 ReplaceSegmentCommand（快照式 undo）：**

```typescript
class ReplaceSegmentCommand extends Command {
  private snapshot: { elements: TimelineElement[], tracks: Track[] };

  execute() {
    this.snapshot = deepClone(affectedRegion);
    // split → delete → insert 内部执行
  }

  undo() {
    restoreFromSnapshot(this.snapshot);
  }
}
```

**ReplaceSegment 替换不变量：**
- **音频：** 原片段的音频随视频一起被替换。如果生成片段无音频，替换后该段静音
- **时长不匹配：** 如果生成片段比原片段短/长，后续元素不做 ripple（不自动移位）。时长差在 ±0.5s 内自动调整 playbackRate 对齐；超出则保留原时长，生成片段自然结束
- **特效/关键帧：** 原片段上挂载的特效链保留到新片段上。关键帧时间重映射到新片段时长
- **转场：** 与相邻元素的转场保留（转场属于相邻关系，不属于被替换元素）
- **多轨道：** 只替换指定 element，其他轨道上同时间范围的元素不受影响

### 4.7 服务端 EditorCore

EditorCore + Commands + Change Log 在 Agent 服务端（纯 Node.js）可实例化运行。这是 Agent First 架构的基础——Agent 直接在服务端操作 EditorCore，不需要经过客户端。

- EditorCore 初始化路径不能依赖 `window`/`document`，需要条件导入或环境检测
- 媒体文件通过 downloadToTempFile(storageKey) 访问（Phase 0 已搭建）
- 渲染层（预览帧/导出）通过 Playwright 驱动（Phase 4 完整搭建）

### 4.8 Playwright Feasibility Spike

Playwright 无头渲染是高风险关键依赖（承担服务端预览和导出），在 Phase 1 末进行可行性验证：

- 验证项：10 分钟视频含音频+字幕+特效、多并发实例、浏览器资源隔离、内存上限
- 如果不达标：提前规划替代方案（客户端导出 + FFmpeg fallback）
- 结论记录到验证标准中

### 4.9 Memory Layer 基础（Phase 1 同步）

**详细设计：** [chatcut-memory-layer.md](./chatcut-memory-layer.md)

Phase 1 需要落地 Memory Layer 的基础设施，与 Change Log 同步推进：

- **Memory 文件格式规范**：定义 frontmatter schema（`memory_id`, `status`, `confidence`, `source`, `scope`, `scope_level`, `semantic_key`, `activation_scope`, `created_session_id` 等，详见 [§3.4](./chatcut-memory-layer.md#34-memory-文件格式)）
- **Memory Extractor 骨架**：挂在 Change Log 的 subscribe 上，Phase 1 只处理**显式输入**（用户通过 Chat UI 直接说的持久偏好）
  - 持久性分类逻辑（批次指令 vs 持久偏好）
  - 显式偏好写入 R2（`source: explicit, status: active`）
  - 批次指令存 task state（不进 R2）
- **查询模板**：实现 `batch-production` 和 `single-edit` 两个基础模板 + `loadCandidatesFromTemplate()` + `postLoadPipeline()`
- **R2 写入一致性**：ETag 乐观并发控制

### 4.10 验证标准

- [ ] `serializeTimeline()` 能输出完整时间线的压缩 JSON
- [ ] UI 操作自动标记为 `source: "human"`，Change Log 有记录
- [ ] `executeAgentCommand()` 标记为 `source: "agent"`，Change Log 区分来源
- [ ] Change Log 的 summary 对 ~25 种 Command 都能生成可读的自然语言描述
- [ ] `extractFrames()` 能从指定时间范围导出帧图片
- [ ] `replaceSegment()` 能替换片段且支持一次 undo 回滚（快照式）
- [ ] EditorCore 数据层能在 Node.js 环境实例化并执行 Command
- [ ] Job Queue：job 入队 → worker 处理 → 进度事件 → 完成
- [ ] Job Queue：worker 崩溃后 job 自动重试
- [ ] Job Queue：重复 jobId 提交返回已有结果（幂等）
- [ ] Playwright feasibility spike 完成并记录结论
- [ ] commitMutation 事务性：快照 + Change Log 在同一事务中更新
- **Memory Layer 验证：**
- [ ] 显式偏好通过 Chat UI 输入后写入 R2 memory（source: explicit, status: active）
- [ ] 批次指令不写入 R2（存入 task state）
- [ ] `loadCandidatesFromTemplate("batch-production", ...)` 能加载相关 memory 文件
- [ ] `postLoadPipeline()` 按 scope_level 正确合并（子级覆盖父级）
- [ ] R2 ETag 并发写入：两个并发写入，后者收到 412 并重试成功
- **Failure-mode 验证：**
- [ ] commitMutation 事务中途失败时，快照和 Change Log 都不更新（原子性）
- [ ] Job queue worker crash 后 stuck job 被自动回收并重试

---

## 五、Phase 2 — 生成链路 + Agent 骨架（与 Phase 3 并行）

### 目标

打通"提取 → 生成 → 替换"闭环，同时搭好 Agent 系统的骨架代码。

### 5.1 接入 creative-engine 生成 API

**新增文件：** `src/agent/services/generation-client.ts`

统一客户端，封装已有 REST 服务：

```typescript
class GenerationClient {
  generateVideo(options: {
    prompt: string;
    provider: "seedance" | "veo" | "kling";
    duration?: number;
    refImage?: string;
  }): Promise<{ taskId: string }>

  generateImage(options: { ... }): Promise<{ taskId: string }>

  checkStatus(taskId: string): Promise<{
    status: "pending" | "processing" | "completed" | "failed";
    progress?: number;
    resultStorageKey?: string;
  }>

  // waitForCompletion 内部流程：
  // 1. provider 返回临时 URL → 下载
  // 2. probe 媒体元数据（codec/fps/timebase/audio layout）
  // 3. 若不满足项目约束 → FFmpeg normalize 为统一 mezzanine 格式（H.264/AAC/CFR）
  // 4. 上传到对象存储 → 返回 storageKey
  waitForCompletion(taskId: string): Promise<{ resultStorageKey: string }>
}
```

**帧分辨率策略：** 发送前按 provider 最大输入分辨率自动适配，只在超出时降采样，保持宽高比。

### 5.2 端到端编辑链路

**新增文件：** `src/agent/services/content-editor.ts`

串联 Phase 1 的帧提取 + 替换 API 与生成客户端：

```typescript
class ContentEditor {
  async replaceWithGenerated(options: {
    elementId: string;
    timeRange: [start, end];
    prompt: string;
    provider?: string;
  }): Promise<{
    originalFrames: Blob[];
    generatedStorageKey: string;
    applied: boolean;
  }>
}
```

流程（全部在服务端执行）：extractFramesServer → 构造 prompt + ref image → generateVideo → waitForCompletion → replaceSegment。

### 5.3 前后对比预览

**新增文件：** `src/agent/services/comparison.ts`

```typescript
generateComparison(options: {
  elementId: string;
  time: number;
}): Promise<{ before: Blob; after: Blob }>
```

Phase 2 的对比是素材级别的——服务端用 FFmpeg 从原始媒体和生成片段各提取对应时间点的帧进行对比。这不包含时间线级 compositing（crop/transform/特效/字幕/多轨叠加），仅验证生成内容本身是否符合预期。完整的时间线级 composited before/after 对比需要 Playwright 渲染，在 Phase 4 实现。

### 5.4 Agent 骨架搭建

**为 Phase 4 铺路**——不实现完整 Agent 系统，只搭骨架：

```
src/agent/
├── services/              # 5.1-5.3 的服务
│   ├── generation-client.ts
│   ├── content-editor.ts
│   └── comparison.ts
├── schema/                # Agent tool 定义（JSON Schema）
│   ├── editor-tools.ts    # 16 个 Editor Agent tools 的 schema
│   ├── creator-tools.ts   # 5 个 Creator Agent tools 的 schema
│   ├── audio-tools.ts     # 6 个 Audio Agent tools 的 schema（stub）
│   └── asset-tools.ts     # 7 个 Asset Agent tools 的 schema（stub）
├── tools/                 # Tool 执行层（schema → EditorCore 调用）
│   ├── editor-tool-executor.ts
│   └── creator-tool-executor.ts
├── types.ts
└── index.ts
```

重点是 tool schema 定义和 tool executor——Agent 的"手"。Phase 4 接入 LLM 时直接可用。

### 5.5 CLI 验证工具

写一个服务端 CLI 脚本验证完整链路（依赖 FFmpeg，不依赖浏览器）：

```bash
npx chatcut-cli replace \
  --project-id proj_abc \
  --element element_abc \
  --time-range 3.2,8.7 \
  --prompt "把红外套换成黑皮夹克" \
  --provider kling
```

CLI 通过调用 Agent 服务 API（与生产一致的写路径：ContentEditor + ServerEditorCore + commitMutation），不直接写 DB。这确保 CLI 验证结果能证明真实架构可用。

### 5.6 Memory Extractor 隐式提取（Phase 2 同步）

Phase 2 在 Agent 骨架搭建的同时，扩展 Memory Extractor 支持隐式提取：

- **混合更新策略**：高置信度信号即时写入（`status: draft`），低置信度信号积攒到批次/session 结束后汇总（`source: observed, status: active`）
- **Session 门控**：同 session 内的强化只提升 confidence，不改 status（防止同 session 内 draft 提升为 active）
- **`onBatchComplete()` / `onSessionComplete()`**：汇总分析 pending signals，产出 `source: observed` 的 memory

详见 [chatcut-memory-layer.md §4](./chatcut-memory-layer.md#四memory-写入三个来源)。

### 5.7 验证标准

- [ ] GenerationClient 能调通至少一个 provider（Kling 或 Seedance）
- [ ] 端到端闭环：指定片段 → 生成 → 替换回时间线，一条命令跑通
- [ ] before/after 对比能输出两张截帧图
- [ ] Editor Agent 的 16 个 tool schema 定义完成
- [ ] Creator Agent 的 5 个 tool schema 定义完成
- [ ] Audio Agent 的 6 个 tool schema stub 定义完成
- [ ] Asset Agent 的 7 个 tool schema stub 定义完成
- [ ] CLI 工具能执行完整替换流程
- [ ] 生成模型 API 超时/失败时，能优雅报错并保持时间线不变
- [ ] 生成成功但替换失败时，能回滚到替换前状态
- **Memory Layer 验证：**
- [ ] 用户连续 reject 同类操作 3+ 次 → Memory Extractor 自动提取 draft memory
- [ ] draft memory 的 activation_scope 正确限定在当前批次/session
- [ ] 跨 session 强化后 draft 提升为 active
- [ ] 同 session 内强化只提升 confidence，不改 status
- [ ] onBatchComplete 后产出 source: observed, status: active 的汇总 memory

---

## 六、Phase 3 — 视频理解（与 Phase 2 并行）

### 目标

接入 Gemini，让系统能"看懂"视频——一步完成语义分割 + 内容描述。

### 6.1 Gemini 视频理解客户端

**新增文件：** `src/agent/services/vision-client.ts`

```typescript
class VisionClient {
  async analyzeVideo(options: {
    storageKey: string;       // 不可变资产标识（内部通过 downloadToTempFile → Gemini API 上传）
    focus?: string;
  }): Promise<VideoAnalysis>

  async locateScene(options: {
    analysis: VideoAnalysis;
    query: string;
  }): Promise<SceneMatch[]>
}

interface VideoAnalysis {
  scenes: Array<{
    start: number;
    end: number;
    description: string;
    objects: string[];
  }>;
  characters: string[];
  mood: string;
  style: string;
}
```

### 6.2 Prompt + JSON Schema 设计

Phase 3 的核心工作量——prompt engineering：

- 设计 Gemini system prompt，要求输出严格 JSON
- 定义 JSON Schema 约束输出格式（场景分割 + 角色 + 情绪）
- 处理边界情况：无对话视频、纯音乐、超短视频
- 调优时间戳精度（验收标准：±1s，优化目标：±0.5s）

### 6.3 分析结果缓存

**新增文件：** `src/agent/services/vision-cache.ts`

```typescript
class VisionCache {
  // 缓存 key = mediaHash + analysisSchemaVersion
  // 只缓存无 focus 的 canonical 全量分析
  get(mediaHash: string, schemaVersion: number): VideoAnalysis | null
  set(mediaHash: string, schemaVersion: number, analysis: VideoAnalysis): void
  // 持久化到 PostgreSQL
  persist(): Promise<void>
  restore(): Promise<void>
}
```

缓存策略：只缓存无 focus 的 canonical 全量分析。带 focus 的请求先查 canonical 缓存，再基于 canonical 结果 + focus 做聚焦后处理（不重新调 Gemini）。prompt/schema 版本变化时通过 schemaVersion 自动失效。

### 6.4 智能定位

用户说"主角出场的那段"→ 从分析结果中匹配时间范围。

Phase 3 先用简单方案：把 query + scenes 一起发给 LLM 做匹配（后续可优化为本地文本相似度）。

### 6.5 Vision Agent tool schema

**新增文件：** `src/agent/schema/vision-tools.ts`

为 Phase 4 准备 Vision Agent 的 3 个 tool 定义：

```typescript
const visionTools = [
  { name: "analyze_video", ... },
  { name: "locate_scene", ... },
  { name: "describe_frame", ... },
];
```

### 6.6 验证标准

- [ ] Gemini API 能接收视频并返回结构化 JSON（scenes + characters + mood）
- [ ] 时间戳精度在 ±1s 以内（对比人工标注）
- [ ] 分析结果缓存：同一视频第二次查询直接返回缓存
- [ ] `locateScene("主角出场")` 能从分析结果中返回正确的时间范围
- [ ] Vision Agent 的 3 个 tool schema 定义完成
- [ ] Gemini 返回无效 JSON 时，能重试或降级处理

---

## 七、Phase 4 — 多 Agent 系统 + Chat UI

### 目标

搭建 Master + 5 Sub-agent 架构，加上 Chat UI，让用户能用自然语言操控视频编辑。

### 7.1 依赖新增

```
claude-agent-sdk          # Master + 所有 Sub-agent 运行时（包名待确认）
@anthropic-ai/sdk         # NativeAPIRuntime fallback（SDK 未就绪时）
@google/generative-ai     # Vision Agent 的 analyze_video tool 内部调用
playwright                # Headless 渲染
```

> **注：** 所有 agent 面向 AgentRuntime 接口编程。Phase 2 用 NativeAPIRuntime（原生 API），Phase 4 切换到 ClaudeSDKRuntime（如果 SDK 就绪）。详见 [agent-system §2.2](./chatcut-agent-system.md)。

### 7.2 Sub-agent 实现

**权威设计：** [chatcut-agent-system.md](./chatcut-agent-system.md)

**新增目录：** `apps/agent/src/agents/`

所有 Sub-agent 通过 AgentRuntime 接口创建，按需实例化（dispatch 时创建，完成后释放）。共享 ProjectContext 访问其他 agent 的产物。

| Agent | 文件 | 模型 | Tools 来源 | 备注 |
|-------|------|------|-----------|------|
| Vision | `vision-agent.ts` | Claude Sonnet 4.6 | 4 tools（analyze_video 内部调 Gemini） | Gemini 是 tool 实现，不是 agent 运行时 |
| Editor | `editor-agent.ts` | Claude Sonnet 4.6 | 16 tools | Phase 2 EditorToolExecutor |
| Creator | `creator-agent.ts` | Claude Sonnet 4.6 | 5 tools（需 idempotencyKey） | 异步生成 |
| Audio | `audio-agent.ts` | Claude Sonnet 4.6 | 6 tools | 新建 |
| Asset | `asset-agent.ts` | Claude Haiku 4.5 | 7 tools | Phase 5 完善 |

每个 agent 结构一致：

```typescript
async function editorAgentLoop(task: string, skills?: string[]): Promise<string> {
  const system = buildSystemPrompt("editor", skills);
  const messages = [{ role: "user", content: task }];

  while (true) {
    const response = await claude.messages.create({
      model: "claude-sonnet-4-6",
      system,
      tools: editorToolSchemas,
      messages,
    });

    if (response.stop_reason === "end_turn") {
      return extractText(response);
    }

    const toolResults = await executeToolCalls(response, editorToolExecutor);
    messages.push(...toolResults);
  }
}
```

**Audio Agent tools（新建）：**

| Tool | 实现来源 |
|------|---------|
| `search_bgm` | 复用 OpenCut 已有的 Freesound API |
| `add_bgm` | EditorCore insert audio element |
| `set_volume` | EditorCore update element |
| `transcribe` | 复用 OpenCut 的 Whisper 转录服务 |
| `auto_subtitle` | transcribe + batch insert text elements |
| `generate_voiceover` | xAI TTS API（复用已有 skill） |

### 7.3 Master Agent

**新增文件：** `src/agent/master.ts`

基于 Agent SDK，通过进程内 MCP server 注册 dispatch 工具：

```typescript
const masterTools = [
  tool("dispatch_vision", ...),
  tool("dispatch_editor", ...),
  tool("dispatch_creator", ...),
  tool("dispatch_audio", ...),
  tool("dispatch_asset", ...),
  tool("explore_options", ...),      // Fan-out 探索（见 §7.13）
  tool("propose_changes", ...),
  tool("export_video", ...),
  tool("check_export_status", ...),
];
```

**调度策略（详见 [agent-system §5](./chatcut-agent-system.md)）：**
- **dispatch-scoped 写锁**：写操作的整个 dispatch 期间持有锁（不是 per-tool-call），确保 rollback 安全
- **读并行/写串行**：读 dispatch 不加锁可并行，写 dispatch 排队串行
- **乐观并发**：写操作携带 expectedSnapshotVersion，版本不匹配时触发 replan
- **per-dispatch taskId**：每个 dispatch 的 commands 打上 taskId，失败时按 taskId 精确回滚
- **副作用分级**：Tier 1（可逆编辑）/ Tier 2（预计算，需 idempotencyKey + costBudget）/ Tier 3（不可逆导出，独立确认）

**Memory Layer 集成：** Master Agent 和每个 Sub-agent 各自独立加载 memory：

```typescript
// 每个 agent 按 agentType 独立加载（确保 Skill 的 agent_type 过滤正确）
const masterCtx = await loadMemories(taskContext, "master");
// dispatch sub-agent 时：
const editorCtx = await loadMemories(taskContext, "editor");
// 所有 injectedMemoryIds/injectedSkillIds 追加到 changeset
```

详见 [chatcut-memory-layer.md §9.4](./chatcut-memory-layer.md#94-与-master-agent-的关系唯一-memory-写入者)。

### 7.4 Context Synchronizer

**新增文件：** `src/agent/context-sync.ts`

读 Change Log，将 Human 变更注入 Agent 上下文（Lazy Sync）：

```typescript
class ContextSynchronizer {
  buildContextUpdate(agentId: string): string | null {
    // 同步所有外部 committed 变更（不仅是 human，还包括其他 agent session 的已提交操作）
    const externalChanges = this.changeLog
      .getCommittedAfter(this.lastSyncedId[agentId])
      .filter(c => c.agentId !== agentId);  // 排除当前 agent 自己的操作

    if (!externalChanges.length) return null;

    return [
      "## 你上次操作后发生了以下变更：",
      ...externalChanges.map(c => `- [${c.source}] ${c.summary}`),
      "",
      "请基于当前最新状态继续工作。",
    ].join("\n");
  }
}
```

Master 每次收到用户新消息时，先调 `buildContextUpdate` 拼到 messages 前面。

### 7.5 Changeset 审批流

**新增文件：** `src/agent/changeset-manager.ts`

Agent 编辑操作通过 pending boundary 机制实现安全的暂存审批：

```typescript
class ChangesetManager {
  propose(commands: Command[]): ChangesetPreview
  approve(): void           // 清除 pending 标记，正式提交
  reject(): void            // undo 所有 pending boundary 之后的 commands
  approveWithMods(): void   // 人类在暂存基础上微调后再提交
  checkConflicts(): ConflictReport
}
```

**Pending Boundary 机制：**

```
propose():
  1. 在 CommandManager 记录 "pending boundary"（当前历史栈位置）
  2. 正常执行 commands（用户能看到预览效果）
  3. Change Log 追加执行事件（带 changesetId，状态从决策事件派生）
  4. 持久化 pending changeset 记录到 PostgreSQL：
     { changesetId, projectId, boundaryCursor, pendingChangeIds[] }
     （轻量记录——仅供崩溃恢复检测用，不支持跨进程 preview 恢复）

approve():
  1. 单一事务写入 PostgreSQL（复用 commitMutation 的版本语义）：
     - 追加 changeset_committed 决策事件
     - 持久化新快照 + lastCommittedChangeId + snapshotVersion + 1
     - 删除 pending changeset 记录
     （四者在同一事务中，保证原子性——包含版本号递增，确保后续 stale-write 检测有效）
  2. 事务提交成功后，才清除内存中的 pending boundary + review lock
     （锁在事务完成前不释放，防止排队的写操作在快照落盘前抢先执行）

reject():
  1. 从 PostgreSQL 读取最新 committed 快照到 clonedState（不修改 live state）
  2. 单一事务写入 PostgreSQL：
     - 追加 changeset_rejected 决策事件
     - 删除 pending changeset 记录
     （快照本身不需要更新——committed 快照未被 pending 操作修改过）
  3. 事务提交成功后，才原子替换 live ServerEditorCore 为 clonedState + 清除 pending boundary + review lock
     （与 commitMutation/approve 同样的 staged 模式：先 DB，成功后才换内存。事务失败则 live pending preview 保持不变）

approveWithMods():
  1. 用户在 agent 结果之上追加修改（追加在 agent commands 之后，不穿插）
  2. 如果某个 tweak command 执行失败：
     - 该 command 不进入 Change Log
     - changeset 保持 pending 状态，用户可以重试、继续修改、或 approve/reject
     - 已成功的 tweaks 保留在历史栈中（不回滚）
  3. 用户确认所有修改后，与 approve() 相同的提交流程

崩溃恢复:
  启动时查询 PostgreSQL 中是否有未完结的 pending changeset 记录
  → 检查是否已有对应的终态决策事件（changeset_committed / changeset_rejected）
  → 如果已有终态事件：仅清理 pending 记录（事务中间态，决策已落盘）
  → 如果无终态事件：从最新 committed 快照重建状态，追加 changeset_rejected 事件，
    删除 pending 记录（单一事务）
  注意：崩溃后内存中的 command 状态已丢失，恢复从 committed 快照重建，不需要"回滚"
```

**`getCommittedAfter()` 的语义（派生视图，统一定义）：**
- 返回不属于任何 changeset 的 `source="human"` 条目（直接操作，自动 committed）
- 返回属于已有 `changeset_committed` 决策事件的 changeset 中的所有条目（agent + review-time human tweaks 一起 committed）
- **不返回：** 仍在 pending changeset 中的条目（无论 source 是 human 还是 agent）
- **不返回：** 属于已有 `changeset_rejected` 决策事件的 changeset 中的条目

> 关键区分：review-time human tweaks（approveWithMods 路径）属于当前 changeset，是 pending 的，不是自动 committed。只有不属于任何 changeset 的直接人类操作才是自动 committed。

**Review Lock（服务端强制）：** pending changeset 存在期间，服务端对该 project 加 review lock：
- `POST /commands`（人类编辑 intent）返回 409 Conflict，要求客户端刷新后重试（不盲排队）
- 其他 Agent session 对同一 project 的写操作被阻止（返回 409，要求等审批结束后 replan）
  - MVP 简化：review 期间不允许新 agent session 启动
  - 已在运行的 agent session 的写操作也携带 baseSnapshotVersion，lock 释放后若版本已变则拒绝并 replan
- 只有当前 changeset 的 review-time tweaks（approveWithMods 路径）允许写入
- review-time tweaks 使用独立的写入契约：`{ changesetId, pendingRevision }`（不是 baseSnapshotVersion）
  - 服务端按当前 pending revision 校验，每次 pending command/tweak 后递增 pendingRevision
  - 过期的 review command 返回 409
  - baseSnapshotVersion 仅用于非 review mode 的 committed-state 写入
- 这确保 pending boundary 之后不会有非预期的写入混入

**Review Mode 约束（客户端 UI）：** 审批期间 UI 进入 review mode：
- 用户只能 approve / reject / 在 agent 结果之上追加修改
- 不能在 agent 操作中间穿插编辑（穿插会导致 LIFO 栈无法选择性 undo）
- 所有 review-time 编辑追加在 agent commands 之后
- reject 时 review tweaks 也一起回滚（合理——拒绝提议则基于提议的微调也应丢弃）

**冲突检测：** `propose()` 记录 changeset fingerprint（涉及的 element IDs、track IDs、时间范围）。`approve()` 前调用 `checkConflicts()` 检查：
- 这些 element 是否被 changeset 外部的操作修改过
- 涉及的 track 上是否有 changeset 外部的新操作
- changeset 影响的时间范围内是否有 changeset 外部的新操作
- **排除当前 changeset 内的 review-time tweaks**（这些是 approveWithMods 路径的正常操作，不是冲突）

```typescript
interface ChangesetFingerprint {
  elementIds: string[];
  trackIds: string[];
  timeRanges: Array<{ trackId: string; start: number; end: number }>;
}
```

如果有冲突，警告用户并展示冲突详情，用户决定是否继续。

**审批层位置：** 不在 dispatch 层拦截（否则 Creator/Audio 的时间线修改会绕过审批），而是在 ServerEditorCore 的 CommandManager 层——Agent session 期间所有 command 执行都自动进入 pending changeset。具体来说：

- Agent session 开始时，ChangesetManager 进入 pending 模式
- ServerEditorCore 执行的每个 command（无论来自哪个 Agent）都归入当前 changeset
- Agent session 结束时，整个 changeset 提交审批
- 这样 Editor、Creator、Audio 的时间线修改全部纳入同一审批流

### 7.6 Chat UI

**新增目录：** `src/components/editor/chat/`

```
chat/
├── chat-panel.tsx         # 主面板（消息列表 + 输入框）
├── message-bubble.tsx     # 单条消息（文本 + 图片预览）
├── changeset-review.tsx   # 审批卡片（before/after + approve/reject）
├── agent-status.tsx       # Agent 执行状态指示器
└── hooks/
    └── use-chat.ts        # 状态管理 + SSE 连接
```

布局：

```
┌─────────────────────────────────────────────────┐
│  ┌──────────┐  ┌──────────────────────────────┐ │
│  │ Chat     │  │       Preview                │ │
│  │ Panel    │  │   ┌───────┐  ┌───────┐       │ │
│  │          │  │   │Before │  │After  │       │ │
│  │ 消息列表  │  │   └───────┘  └───────┘       │ │
│  │          │  │   [Approve]  [Reject]         │ │
│  │          │  └──────────────────────────────┘ │
│  │          │  ┌──────────────────────────────┐ │
│  │ ┌──────┐ │  │  Timeline                    │ │
│  │ │输入框│ │  │                              │ │
│  └─┴──────┴─┘  └──────────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

### 7.7 Agent 服务 API

Agent 服务独立于 Vercel，客户端直连。API 端点：

```
Agent 服务（独立部署）
├── POST   /chat              — 发送消息，SSE 流式返回
├── POST   /commands          — 人类 command intent 提交
├── POST   /changeset/approve — 审批 changeset
├── POST   /changeset/reject  — 拒绝 changeset
├── GET    /status            — Agent 执行状态
├── GET    /project/:id       — 获取最新 committed 快照
├── GET    /events            — SSE 事件流（状态变更广播）
├── GET    /changeset/:id        — 查询 changeset 状态（pending/committed/rejected）；服务重启后 pending 一律 auto-reject，不恢复 preview
```

### 7.8 Skill 加载机制

**新增文件：** `src/agent/skills/loader.ts`

动态读取 skill 描述，注入 sub-agent 的 system prompt。**Skill 存储和加载以 [chatcut-memory-layer.md](./chatcut-memory-layer.md) 为权威设计。**

```typescript
async function loadSkills(agentType: string, options?: { brand?: string; series?: string }): Promise<string[]> {
  // 1. 读取系统预置 skills（Markdown 文件）
  // 2. 读取 R2 _skills/ 路径下的用户 Skill（Phase 5 完善）
  //    R2: chatcut-memory/{user-id}/brands/{brand}/_skills/*.md
  //    R2: chatcut-memory/{user-id}/brands/{brand}/series/{series}/_skills/*.md
  // 3. 按 agentType + skill_status 过滤
  //    agent_type 枚举：editor | creator | audio | vision | asset | master
  // 4. 返回 skill 描述文本数组
  //    skill_status: validated → 正常优先级
  //    skill_status: draft → 降权，放入 trial 块
}
```

Phase 4 先实现系统预置 skills + Memory Layer 的查询模板加载。用户 Skill 自动结晶留 Phase 5。

### 7.9 Playwright 无头渲染服务

**新增文件：** `src/agent/services/headless-renderer.ts`

Agent 服务端需要预览帧和导出视频时，通过 Playwright 驱动无头 Chromium：

```typescript
class HeadlessRenderer {
  // 管理 Playwright browser 实例池
  private browserPool: Browser[];

  // 截取指定时间点的预览帧
  async renderFrame(project: TProject, time: number): Promise<Blob>

  // 导出完整视频（写临时文件 → 上传到对象存储 → 返回 storageKey，不持有内存 ArrayBuffer）
  async exportVideo(project: TProject, options: ExportOptions): Promise<{ storageKey: string }>

  // 实例生命周期管理（按需启动，用完释放）
  async acquire(): Promise<BrowserContext>
  release(context: BrowserContext): void
}
```

渲染请求排队执行，避免同时启动过多 Chromium 实例。

### 7.10 运行时契约

Agent 服务与前端之间的通信需要明确以下契约：

| 要素 | 设计 |
|------|------|
| 会话 ID | 每个 Chat 会话一个 `conversationId`，持久化到 PostgreSQL，支持断线恢复 |
| Changeset ID | 每次 `propose` 生成唯一 `changesetId`，approve/reject 通过此 ID 操作 |
| SSE 重连 | 客户端断线后通过 `Last-Event-ID` 恢复，服务端缓存最近 N 条事件 |
| 审批状态 | pending changeset 轻量记录持久化到 PostgreSQL（changesetId + boundaryCursor + pendingChangeIds），服务重启自动回滚；approved/rejected 决策事件持久化到 Change Log |
| 跨服务认证 | 前端 → Agent 服务通过 JWT token 传递用户身份 |
| 任务幂等性 | 每个 Agent 任务有唯一 `taskId`，重复提交返回已有结果 |

### 7.11 部署架构

```
Vercel（只读 + 认证）
├── Next.js 前端（编辑器 UI + Chat UI 界面）
├── API Routes：认证、项目列表（只读）、上传凭证签发
├── **不写** 时间线/changeset/conversation/media metadata
├── 不处理 SSE/WebSocket/长连接

独立 Agent 服务（Railway / Fly.io / 自建）— **唯一写入者**
├── ServerEditorCore（单一权威历史）
├── Agent 运行时（Master + Sub-agents）
├── 所有 command 执行入口（人类 intent + Agent tool call）
├── 所有项目状态写入（时间线、changeset、conversation、media metadata）
├── SSE 推送（Agent 响应 + 状态变更广播）
├── Playwright 无头渲染
├── pg-boss 任务队列

客户端直连 Agent 服务:
├── Chat / SSE → Agent 服务（不经过 Vercel）
├── Command intent → Agent 服务（不经过 Vercel）
├── 认证 / 项目列表 → Vercel API Routes
```

### 7.12 MVP 安全基线

不做完整安全审计，但以下最小安全措施随 Phase 4 一起落地：

| 措施 | 说明 |
|------|------|
| 项目级授权 | 用户只能访问自己的项目和媒体 |
| 对象存储访问边界 | 服务端用 downloadToTempFile() 流式读取；客户端只通过 signed URL（TTL ≤ 1h） |
| 服务间认证 | 前端 → Agent 服务通过 JWT token 传递用户身份 |
| 第三方 provider 隔离 | 发送到 Gemini/Kling/Veo 的媒体仅限当前任务所需帧，不发送完整项目 |
| 日志脱敏 | Agent 对话日志不记录完整 prompt（可能含用户隐私），只记录 tool call 摘要 |

### 7.13 Fan-out 探索机制

**权威设计：** [chatcut-fanout-exploration.md](./chatcut-fanout-exploration.md)

当用户意图模糊时（"这段太拖了"、"让视频更有活力"），Master Agent 通过 `explore_options` tool 触发 fan-out 探索：

**核心流程：**
1. Master Agent 判断意图模糊 → 生成 4 个候选方案骨架（CandidateSkeleton）
2. Exploration Engine 物化骨架 → 完整 ExecutionPlan（不可变，所有产物已上传 R2）
3. 4 个 Daytona sandbox 并行渲染预览视频（5-10s）
4. Chat UI 展示 4 张候选卡片（视频预览 + 摘要 + 指标）
5. 用户选择 → propose() → 微调 → approve()

**关键组件：**
- **Exploration Engine** — 异步 pg-boss job，全局互斥（MVP），SSE 流式推送结果
- **Daytona Sandbox Pool** — 4 个 warm sandbox（Playwright + FFmpeg），共享媒体缓存卷，cancel 时 destroy + 补充
- **ExecutionPlan** — Canonical schema 贯穿全链路（tool input → pg-boss → sandbox → SSE → DB）
- **预览视频 API** — `GET /api/exploration/:id/preview/:candidateId` mint signed URL
- **Memory 信号** — 选择 = 强信号，跳过 ≠ 负面信号，展示顺序随机化防偏差
- **级联** — 支持最多 2 层 fan-out

**触发模式：** 混合（Master 自主判断 + 用户显式要求"给我几个方案"）

### 7.14 验证标准

- [ ] 用户在 Chat UI 输入"把第二段裁短到 3 秒"→ Editor Agent 执行 → changeset 出现在审批区
- [ ] 用户 approve → 变更生效；reject → 回滚
- [ ] 用户在 UI 手动修改后发新指令 → Agent 能感知 Human 的变更（Context Sync）
- [ ] "分析这个视频" → Master dispatch Vision Agent → 返回语义分割结果
- [ ] "把主角外套换成黑色" → Master 协调 Vision → Creator → Editor 的多 Agent 链路
- [ ] 独立子任务能并行执行（同时 dispatch Vision + Audio）
- [ ] Chat UI 流式显示 Agent 响应
- [ ] 至少 2 个系统预置 Skill 能被加载并影响 Agent 行为
- [ ] 简单单 Agent 任务（如"裁短到 3 秒"）端到端响应时间 < 15 秒
- [ ] Playwright 无头渲染：能通过 HeadlessRenderer 截取预览帧
- [ ] SSE 断线重连后，Agent 响应不丢失
- [ ] approve 时如果用户已修改了 changeset 涉及的元素，显示冲突警告
- [ ] review mode 下用户无法在 agent 操作中间穿插编辑
- [ ] 快照与 lastCommittedChangeId 在同一事务中持久化
- [ ] 服务重启后从 committed 快照恢复，pending changeset 自动 rejected
- [ ] review lock 期间人类写入返回 409；新 agent session 启动被拒绝；已有 agent session lock 释放后版本变化时写入失败并 replan
- [ ] 项目级授权：用户 A 无法访问用户 B 的项目/媒体
- **Fan-out 探索验证：**
- [ ] 用户说"这段太拖了" → Master Agent 自主触发 fan-out → 4 个候选卡片出现在 Chat UI
- [ ] 每张卡片有可播放的 5-10s 预览视频 + 文字摘要 + 指标
- [ ] 用户选择方案 C → timeline 切换到 C 的预览状态 → 可微调 → approve 整体提交
- [ ] 选择时 baseSnapshotVersion 不匹配 → 提示"时间线已变化"
- [ ] 并发 fan-out → 第二个请求被拒绝，提示稍等或取消
- [ ] 取消 fan-out → sandbox 销毁 + pool 补充 + SSE 停止推送
- [ ] fan-out 选择信号写入 Memory Layer（draft memory）
- [ ] 级联 fan-out：选了 C 后说"还能更紧凑" → 基于 C 再 fan-out（最多 2 层）
- **Agent System 验证：**
- [ ] AgentRuntime 封装层可在 NativeAPIRuntime 和 ClaudeSDKRuntime 间切换（改一行配置，不改业务代码）
- [ ] dispatch-scoped 写锁：写 dispatch 持有锁期间，其他写 dispatch 排队
- [ ] 乐观并发：写操作版本不匹配 → StaleStateError → agent 自动 replan
- [ ] per-dispatch rollback：agent 失败 → 只回滚该 taskId 的 commands，不影响其他 agent
- [ ] 共享 ProjectContext：Vision Agent 写入 videoAnalysis → Editor Agent 能读到
- [ ] Sub-agent 按需创建释放：dispatch 完成后实例释放，下次 dispatch 创建新实例
- [ ] 非幂等 tool（generate_video 等）携带 idempotencyKey → 重试不产生重复 job
- [ ] Tier 2 costBudget：session 内生成费用超过阈值 → 拒绝执行并提示用户
- [ ] Master Agent session 持久化：关闭项目 → 重新打开 → 对话历史恢复

---

## 八、Phase 5 — 资产管理系统

### 目标

实现跨项目的素材和工作流复用能力——Skill 存档 + 素材存档双机制。

### 8.1 Skill 存档

**权威设计：** [chatcut-memory-layer.md §8](./chatcut-memory-layer.md#八memory--skill-自动结晶)

**存储：** R2 `_skills/` 路径为唯一 Skill 存储（不另建数据库）。

**新增文件：** `src/agent/assets/skill-store.ts`

保存"怎么剪"——将编辑风格模板化。Schema 与 Memory Layer 的 Skill frontmatter 对齐：

```typescript
interface Skill {
  skill_id: string;
  name: string;
  description: string;
  agent_type: "editor" | "creator" | "audio" | "vision" | "asset" | "master";
  skill_status: "draft" | "validated" | "deprecated";
  applies_to: string[];     // 覆盖范围标签（merge key）
  scope_level: "brand" | "series";
  scope_ref: string;        // 如 "brand:coffee-lab"
  content: string;          // Markdown 格式
  source: "system" | "user" | "auto-crystallized";
  source_memories?: string[];  // 自动结晶来源的 memory_id 列表
  usage_count: number;
  validated_count: number;
}

class SkillStore {
  // 从 R2 _skills/ 路径加载
  loadSkills(agentType: string, options?: { brand?: string; series?: string }): Promise<Skill[]>
  save(skill): Promise<string>
  search(query, agentType?, options?: { brand?, series? }): Promise<Skill[]>
  load(skillId): Promise<Skill>
  delete(skillId): Promise<void>
}
```

**自动结晶（Phase 5 新增）：** Pattern Observer 定期扫描 memory，发现可结构化的模式后自动生成 Skill 草案（`skill_status: draft`）。经过实际生产验证后提升为 `validated`。详见 [chatcut-memory-layer.md §8.1-§8.3](./chatcut-memory-layer.md#81-机制)。

**系统预置 Skills（Markdown 文件）：**

```
src/agent/skills/presets/
├── editor/
│   ├── beat-sync-editing.md       # Beat 对齐剪辑
│   ├── j-cut-l-cut.md            # J-Cut / L-Cut 技法
│   ├── rhythm-curve.md           # 节奏曲线控制
│   └── safe-zone-crop.md         # 安全区裁切
├── creator/
│   ├── prompt-engineering.md      # 5 要素提示词公式
│   ├── model-routing.md           # 模型选择策略
│   ├── character-consistency.md   # 角色一致性
│   └── style-transfer.md         # 风格迁移
├── vision/
│   ├── viral-factor-analysis.md   # 爆款因子分析
│   ├── ad-structure.md            # 广告结构识别
│   └── content-safety.md          # 内容安全审查
├── audio/
│   ├── audio-ducking.md           # 音频闪避
│   ├── beat-detection.md          # 节拍检测
│   └── multilang-subtitle.md     # 多语言字幕
├── asset/
│   ├── smart-tagging.md           # 智能标签
│   └── dedup.md                   # 素材去重
└── master/
    ├── viral-replication.md       # 爆款复刻
    └── multi-platform-adapt.md    # 多平台适配
```

### 8.2 素材存档

**新增文件：** `src/agent/assets/asset-store.ts`

保存"用什么剪"——AI 生成素材带完整生成上下文：

```typescript
interface AssetEntry {
  id: string;
  type: "generated_video" | "generated_image" | "character" | "bgm" | "sound_effect" | "brand_asset";
  storageKey: string;
  thumbnail?: string;
  duration?: number;

  generation?: {
    prompt: string;
    provider: string;
    model: string;
    params: Record<string, any>;
    refImageStorageKey?: string;
  };

  name: string;
  description: string;
  tags: string[];
  projectIds: string[];
  usageCount: number;
}

class AssetStore {
  save(asset): Promise<string>
  search(query, type?): Promise<AssetEntry[]>
  regenerateSimilar(assetId, tweaks?): Promise<{ taskId: string }>
  getProjectAssets(projectId): Promise<AssetEntry[]>
  linkToProject(assetId, projectId): Promise<void>
}
```

### 8.3 角色库集成

**新增文件：** `src/agent/assets/character-store.ts`

对接 creative-engine 的 character-bank：

```typescript
class CharacterStore {
  search(query): Promise<Character[]>
  createFromFrame(options): Promise<Character>
  getConsistencyKeywords(characterId): string
}
```

### 8.4 品牌资产管理

**新增文件：** `src/agent/assets/brand-store.ts`

```typescript
interface BrandKit {
  id: string;
  name: string;
  logo: { light: string; dark: string };
  colors: string[];
  fonts: string[];
  introTemplate?: string;
  outroTemplate?: string;
}
```

### 8.5 Asset Agent tools 完善

Phase 4 搭建了 Asset Agent 骨架，Phase 5 补齐全部 7 个 tool 的完整实现：

| Tool | 对应 Store |
|------|-----------|
| `search_assets` | AssetStore.search |
| `save_asset` | AssetStore.save |
| `search_characters` | CharacterStore.search |
| `import_media` | MediaManager + AssetStore.save |
| `save_skill` | SkillStore.save |
| `list_skills` | SkillStore.search |
| `load_skill` | SkillStore.load → 注入 system prompt |

### 8.6 数据库 Schema 扩展

```sql
-- 所有可复用记录都带 user_id 租户字段，确保项目级授权

-- skills 表
skills (id, user_id, name, description, agent_type, content, tags, source, usage_count, created_at, updated_at)

-- assets 表
assets (id, user_id, type, storage_key, thumbnail, name, description, tags, usage_count, created_at)

-- asset_generation_context 表
asset_generation_context (asset_id, prompt, provider, model, params_json, ref_image_storage_key)

-- project_assets 关联表
project_assets (project_id, asset_id, linked_at)

-- brand_kits 表
brand_kits (id, user_id, name, logo_light, logo_dark, colors_json, fonts_json, intro_template_id, outro_template_id)

-- characters 表
characters (id, user_id, name, description, consistency_keywords, reference_images_json, created_at)
```

### 8.7 验证标准

- [ ] 用户说"把这个剪辑风格保存下来"→ 从 Change Log 提炼 Skill → 存入 R2 `_skills/`
- [ ] 用户说"用上次那个快节奏风格"→ `loadSkills(agentType, {brand})` 加载到 Agent system prompt → 影响剪辑行为
- [ ] Pattern Observer 自动结晶：5+ 条 high confidence memory 且标签交集 → 生成 Skill 草案（skill_status: draft）
- [ ] Skill 草案在生产中被使用并 approve → skill_status 提升为 validated
- [ ] `appliedSkillIds` 正确追踪：只有实际被使用的 Skill 在 approve 时被 promote
- [ ] AI 生成的素材自动记录完整生成上下文（prompt + model + params）
- [ ] "用上次那个樱花树下的片段"→ Asset Agent 搜索到对应素材并插入时间线
- [ ] "基于这个再生成一个类似的"→ 读取原生成上下文 → 微调 prompt → 重新生成
- [ ] 品牌资产配置后，Agent 生成视频自动应用 logo 和配色
- [ ] 系统预置 Skills（20 个）全部可加载

---

## 九、风险与缓解

| 风险 | 影响 | 缓解策略 |
|------|------|----------|
| Gemini 视频理解时间戳精度不够（>±1s） | 场景定位不准 | Phase 3 预留 PySceneDetect 做精确对齐 fallback |
| 生成模型延迟高（30s-2min） | 用户等待体验差 | 前端做好异步状态展示；支持后台生成、完成后通知 |
| Agent SDK API 变化或未发布 | Agent 系统无法用 SDK 能力 | AgentRuntime 封装层 + NativeAPIRuntime fallback（Phase 2 即可用，无 SDK 依赖） |
| OpenCut 代码搬运后隐性依赖断裂 | Phase 0 耗时超预期 | 验收标准明确：能编辑、预览、导出才算完成 |
| Playwright 无头渲染内存占用高 | 服务端资源紧张 | 按需启动 Playwright 实例，用完释放；渲染请求排队 |
| 多 Agent 链路延迟叠加 | 复杂操作响应慢 | 并行调度独立子任务；流式返回中间状态 |
| Daytona sandbox 不可用 | Fan-out 无法渲染预览 | 零 sandbox 降级为文字摘要；pool 自动补充；cancel 后异步重建 |

---

## 十、明确延后的功能

以下功能在架构文档中提及但不在本计划范围内，后续按需安排：

| 功能 | 来源 | 延后原因 |
|------|------|----------|
| SAM2 像素级精确分割 | architecture 2.2 | MVP 不需要，等用户反馈"模型改错地方"时再加 |
| PySceneDetect 帧精确对齐 | architecture 2.3 | 作为 Gemini 精度不够时的 fallback，按需启用 |
| Florence-2 ONNX 客户端轻量检测 | architecture 2.4 | 可选增强，非核心链路 |
| 基于分析结果的编辑建议 | architecture Phase 3 | 智能推荐功能，核心链路跑通后再做 |
| 5 层 REST API 平台化 | research 7.x | 本计划聚焦产品体验，API 平台化是独立项目 |
| Tauri Native 化 | research 6.x | 产品验证后再考虑桌面端 |
| 端到端管线 API（text-to-video、爆款复刻等） | research 7.5 | 依赖 creative-engine 管线引擎，独立项目推进 |
| 隐私/安全设计（数据保留、授权流程、日志脱敏） | Codex review | 产品验证后做安全审计和加固 |
