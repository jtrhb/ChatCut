# ChatCut 技术调研报告

基于 OpenCut 项目的技术调研，评估将其改造为 Agent 驱动的视频编辑产品 ChatCut 的可行性与路线。

---

## 一、OpenCut 项目概况

### 1.1 技术栈

| 层级 | 技术 |
|------|------|
| 前端框架 | Next.js 16.1 + React 19 + TypeScript 5.8 |
| 状态管理 | Zustand 5.0 |
| 视频处理 | MediaBunny 1.29（底层走 WebCodecs API 硬件加速） |
| 特效渲染 | WebGL Fragment Shader |
| Canvas 渲染 | OffscreenCanvas / HTMLCanvasElement 2D |
| 音频 | Web Audio API + WaveSurfer.js（波形可视化） |
| UI 组件 | Radix UI + 自定义组件 |
| 数据库 | PostgreSQL + Drizzle ORM |
| 认证 | Better Auth |
| 本地存储 | IndexedDB / OPFS |
| 包管理 | Bun + Turborepo（monorepo） |

### 1.2 代码规模

| 部分 | 文件数 | 代码行 |
|------|--------|--------|
| UI 组件 (React/TSX) | 114 | ~16,000 |
| 核心逻辑 (core/services/lib/types) | ~180 | ~24,000 |
| 其他 (路由/配置等) | ~130 | ~12,500 |
| **合计** | **424** | **~52,500** |

### 1.3 项目结构

```
OpenCut/
├── apps/web/src/
│   ├── core/                  # EditorCore 单例 + 各 Manager
│   │   ├── index.ts           # EditorCore 入口
│   │   └── managers/          # 10 个 Manager
│   ├── services/
│   │   ├── renderer/          # 渲染管线（Canvas + WebGL）
│   │   │   ├── canvas-renderer.ts
│   │   │   ├── scene-builder.ts
│   │   │   ├── scene-exporter.ts
│   │   │   ├── webgl-effect-renderer.ts
│   │   │   └── nodes/         # 渲染节点树
│   │   ├── video-cache/       # 视频帧缓存
│   │   └── storage/           # IndexedDB 持久化
│   ├── lib/
│   │   ├── commands/          # Command 模式（撤销/重做）
│   │   ├── effects/           # 特效定义与注册
│   │   ├── media/             # 媒体处理工具
│   │   └── animation/         # 关键帧动画系统
│   ├── components/editor/     # 编辑器 UI 组件
│   ├── stores/                # Zustand 状态管理
│   ├── hooks/                 # React Hooks
│   └── types/                 # TypeScript 类型定义
├── packages/
│   ├── ui/                    # 共享 UI 组件库
│   └── env/                   # 环境变量管理
└── docs/
```

---

## 二、视频编辑功能实现分析

### 2.1 核心架构：Manager 模式

EditorCore 是全局单例，通过 10 个 Manager 协调所有功能：

```
EditorCore (单例)
├── PlaybackManager    — 播放控制 (play/pause/seek, requestAnimationFrame 驱动)
├── TimelineManager    — 轨道和元素的增删改查
├── ScenesManager      — 多场景管理 + 书签
├── ProjectManager     — 项目生命周期（创建/保存/加载/导出）
├── MediaManager       — 媒体资源管理
├── RendererManager    — 渲染/导出协调
├── CommandManager     — 撤销/重做历史栈
├── AudioManager       — 音频处理
├── SelectionManager   — 元素和关键帧选择状态
└── SaveManager        — 自动保存（脏标记 + 定时刷盘）
```

### 2.2 时间线系统

**5 种轨道类型：** `video` | `text` | `audio` | `sticker` | `effect`

**元素通用字段：**

- `id`, `name` — 标识
- `startTime`, `duration` — 时间线上的位置和时长
- `trimStart`, `trimEnd`, `sourceDuration` — 源素材裁剪
- `transform` (position/scale/rotate) — 空间变换
- `opacity`, `blendMode` — 混合模式
- `effects[]` — 挂载的特效链
- `animations` — 关键帧动画数据

**时间映射公式：** `sourceTime = timelineTime - startTime + trimStart`

### 2.3 Command 模式

所有编辑操作封装为 Command，支持 execute / undo / redo：

- **轨道操作：** AddTrack, RemoveTrack, ToggleTrackMute, ToggleTrackVisibility
- **元素操作：** InsertElement, DeleteElements, DuplicateElements, MoveElement, SplitElements, UpdateElement, UpdateElementTrim, UpdateElementDuration, UpdateElementStartTime
- **动画操作：** UpsertKeyframe, RemoveKeyframe, RetimeKeyframe
- **特效操作：** AddClipEffect, RemoveClipEffect, UpdateClipEffectParams, ToggleClipEffect, ReorderClipEffects
- **场景操作：** CreateScene, DeleteScene, RenameScene
- **批量操作：** BatchCommand（原子化多命令）

### 2.4 渲染管线

#### 场景构建（scene-builder.ts）

将时间线数据转换为渲染节点树：

```
RootNode
├── ColorNode / CompositeEffectNode  — 背景层
├── VideoNode   — 视频帧（通过 VideoCache 按需解码）
├── ImageNode   — 静态图片
├── TextNode    — 文字（支持样式/背景/对齐）
├── StickerNode — SVG/Emoji 贴纸
└── EffectLayerNode — 全局特效层
```

#### 视觉节点渲染流程（visual-node.ts）

1. 解析关键帧动画 → 计算当前 transform / opacity
2. Contain 缩放到画布尺寸
3. 应用旋转
4. 如果有特效 → 创建临时 OffscreenCanvas → 逐个 WebGL pass 处理
5. 应用混合模式 → 绘制到主 Canvas

#### 视频帧缓存（video-cache/service.ts）

全局单例 `videoCache`，每个媒体资源一个独立的 `CanvasSink` 解码器：

```
getFrameAt(mediaId, file, time)
├── 1. 命中预取帧 nextFrame → 直接返回
├── 2. 当前帧仍有效 → 返回 currentFrame
├── 3. 前向迭代（< 2秒窗口） → 顺序读 iterator
└── 4. Seek（昂贵） → 销毁迭代器，从新位置重建
```

特点：预取深度仅 1 帧，无帧池上限，无 LRU 淘汰。

### 2.5 导出流程（scene-exporter.ts）

严格串行的逐帧循环：

```typescript
for (let i = 0; i < frameCount; i++) {
    await renderer.render({ node: rootNode, time: i / fps });  // 解码 + 合成
    await videoSource.add(time, 1 / fps);                       // 编码
}
```

通过 MediaBunny 的 `Output` 写入 MP4 (H.264) 或 WebM (VP9)。音频一次性混合到 `AudioBuffer` 后整体编码。

### 2.6 特效系统

- 特效定义在 `lib/effects/definitions/` 中（目前有 blur）
- WebGL Fragment Shader 实现 GPU 加速
- 支持多 pass 渲染
- 特效参数支持关键帧动画

---

## 三、性能瓶颈分析

按严重程度排序：

### 3.1 导出逐帧循环（最严重）

**位置：** `scene-exporter.ts:130-142`

10 分钟 30fps = 18,000 帧，每帧串行执行：解码所有可见视频帧 → Canvas 合成 → 编码。解码和编码之间没有流水线并行。

### 3.2 带特效的视觉渲染

**位置：** `visual-node.ts:112-151`

每帧每个有特效的元素都会：
- 创建临时 OffscreenCanvas（无复用）
- 多次 WebGL 上下文切换
- 多个元素叠加时呈乘法级增长

### 3.3 视频帧 Seek

**位置：** `video-cache/service.ts:133-178`

拖动进度条时，每次跳跃需要销毁旧迭代器 + 重建 + 找关键帧 + 逐帧解码到目标位置。多视频同时可见时成倍放大。

### 3.4 音频一次性混合

**位置：** `mediabunny.ts:70-115`

导出前将整个时间线音频一次性混到 `Float32Array`。10 分钟/44100Hz/双声道 ≈ 200MB 内存占用。

### 3.5 多视频/长视频的结构性问题

| 问题 | 原因 |
|------|------|
| 无解码器数量上限 | `sinks` Map 只增不减 |
| 预取深度只有 1 帧 | 高帧率播放可能不够 |
| 预览无分辨率降级 | 视频元素预览和导出用同一分辨率解码 |
| 无 Web Worker | 所有解码/渲染都在主线程 |

---

## 四、关于 FFmpeg.js 与 Rust WASM 的评估

### 4.1 实际情况

OpenCut 虽然依赖了 `@ffmpeg/ffmpeg`，但代码中**核心视频处理全部由 MediaBunny 完成**（解封装、解码、编码、导出）。MediaBunny 底层使用浏览器 WebCodecs API，已有硬件加速。

### 4.2 Rust WASM 的适用场景

| 适合 | 不适合 |
|------|--------|
| 像素级滤镜（色彩校正、锐化） | 视频编解码（WebCodecs 有硬件加速，WASM 是纯 CPU） |
| 容器格式解封装 | Canvas 渲染 |
| 音频处理（重采样、混音） | 简单的数据拼接 |
| 自定义编解码器 | |

### 4.3 推荐架构

```
视频编解码  →  WebCodecs API（硬件加速）
容器解封装  →  WASM 或 JS
特效处理    →  WebGL Shader（GPU）
音频处理    →  Web Audio API + 可选 WASM
像素级计算  →  Rust WASM（CPU 密集型）
```

---

## 五、ChatCut 产品改造方案

### 5.1 产品定位

Agent 驱动的视频编辑器，AI 完成主要剪辑工作，人类在环偶尔微调。

### 5.2 架构设计

```
┌─────────────────────────────────────────────────┐
│  Agent (LLM)                                    │
│  "把第二个片段缩短到3秒，加模糊转场"               │
└──────────────┬──────────────────────────────────┘
               │ tool_calls (结构化)
               ▼
┌──────────────────────────────────────┐
│  ChatCut Agent API  ← 新增          │
│  ├── 操作映射层（intent → commands） │
│  ├── 状态序列化（让 agent 看到时间线）│
│  └── 变更暂存区（pending changeset） │
└──────────────┬───────────────────────┘
               │ commands
               ▼
┌──────────────────────────────────────┐
│  EditorCore  ← 基本不改             │
│  CommandManager / TimelineManager    │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│  Preview → 人类审批 → commit/rollback│
└──────────────────────────────────────┘
```

### 5.3 需要新增的模块

#### Agent 操作协议（`src/agent/schema.ts`）

暴露给 Agent 的 tool 定义，粒度比 UI 操作更粗：

```
查询类：get_timeline_state / get_element_info / preview_frame
操作类：insert_clip / trim_clip / split_clip / delete_clip /
       move_clip / set_text / add_effect / set_volume / set_transform
批量类：batch_operations
导出类：export_video
```

#### 状态序列化（`src/agent/state-serializer.ts`）

将时间线状态压缩为 Agent 可理解的最小 JSON，控制 token 消耗。只暴露 agent 决策需要的字段（id、类型、时间、名称），不传递 transform 细节或动画数据。

#### 变更暂存管理（`src/agent/changeset.ts`）

Agent 操作不立即提交，而是进入暂存区：

```
propose(commands[])   → 临时应用，进入审批模式
approve()             → 正式推入 CommandManager 历史
reject()              → 回滚所有暂存变更
approveWithMods()     → 人类微调后再提交
```

#### Agent 执行引擎（`src/agent/engine.ts`）

接收 Agent 的 tool call，映射到 EditorCore 的具体操作，通过 ChangesetManager 提交。

### 5.4 UI 改造

```
┌──────────────────────────────────────────────────┐
│  ┌─────────────┐  ┌────────────────────────────┐ │
│  │             │  │        Preview             │ │
│  │   Chat      │  │   ┌──────┐  ┌──────┐      │ │
│  │   Panel     │  │   │Before│  │After │      │ │
│  │  （新增）    │  │   └──────┘  └──────┘      │ │
│  │             │  │   [Approve] [Reject]       │ │
│  │             │  └────────────────────────────┘ │
│  │             │  ┌────────────────────────────┐ │
│  │             │  │   Timeline（保留现有）       │ │
│  │             │  │   人类可直接拖动微调         │ │
│  └─────────────┘  └────────────────────────────┘ │
└──────────────────────────────────────────────────┘
```

### 5.5 对现有代码的改动（极少）

| 文件 | 改动 | 原因 |
|------|------|------|
| `core/index.ts` | 注册 agentEngine 和 changeset | 新增 manager |
| `core/managers/commands.ts` | 加 `pushWithoutExecute()` | 暂存模式需要 |
| `stores/editor-store.ts` | 加 `reviewMode` 状态 | UI 审批模式 |
| `components/editor/layout` | 加 Chat Panel 位置 | 布局调整 |
| `app/api/` | 加 `/api/agent/execute` | 外部 agent HTTP 接入 |

核心的 TimelineManager、Command 系统、渲染管线完全不需要修改。

### 5.6 Agent 接入方式

```
模式 A：内置 Agent（前端直连 LLM API）
  适合个人用户，低延迟

模式 B：外部 Agent（HTTP API）
  POST /api/agent/execute → AgentEngine → WebSocket 推送预览
  适合自动化流水线、批量处理
```

### 5.7 实施优先级

```
Phase 1（MVP，1-2 周）:
  ├── state-serializer     — 让 agent 看到时间线
  ├── agent schema + engine — 5-6 个核心操作
  ├── changeset manager     — propose / approve / reject
  └── chat panel（简版）    — 输入框 + 消息列表

Phase 2（体验优化）:
  ├── before/after 预览对比
  ├── 人类微调后再审批
  ├── batch operations
  └── agent 可调用 preview_frame 查看效果

Phase 3（自动化）:
  ├── HTTP API 模式
  ├── 模板系统（agent 套用剪辑模板）
  └── 自动字幕 + 配乐推荐
```

---

## 六、Native App 路线评估

### 6.1 四种方案对比

#### 方案 A：Tauri（推荐）

Rust 后端 + 保留现有 React 前端。

```
前端：现有 React 代码基本保留（UI + EditorCore + Agent 层）
Rust 后端：FFmpeg binding 编解码 / 文件系统 / GPU 渲染(wgpu)
```

- 工作量：小，前端几乎不改
- 性能：好，视频处理走原生 FFmpeg
- 包体积：15-30MB
- 跨平台：macOS / Windows / Linux
- 风险：低，渐进式迁移

#### 方案 B：Electron

直接包装现有 web app。

- 工作量：最小
- 性能：一般，仍走 WebCodecs
- 包体积：150MB+
- 风险：最低

#### 方案 C：Rust 全部重写（不推荐）

UI 用 egui / iced / slint，逻辑全 Rust。

- 工作量：巨大（5 万行 TS 重写，6-12 个月）
- 性能：理论最好，但收益集中在视频处理部分（可单独用 Rust 解决）
- Rust GUI 生态不成熟，复杂交互 UI（拖拽时间线、多面板联动）实现难度极高
- 风险：极高，期间无法迭代产品

#### 方案 D：Rust 核心 + Swift/Kotlin 原生 UI

每个平台写一套原生 UI，共享 Rust 核心库。

- 工作量：最大，维护成本长期翻倍
- 性能和体验：最好
- 适合：资源充足的大团队

### 6.2 推荐路线：Tauri + 性能热点下沉

```
Phase 1（先跑起来，1-2 周）:
  Tauri 包装现有 web app → 立刻有 native app

Phase 2（性能下沉，4-6 周）:
  迁移到 Rust sidecar：
  ├── 视频导出（FFmpeg binding 替代 MediaBunny WebCodecs 导出）
  ├── 音频混合（替代 JS 逐采样 Float32Array 操作）
  ├── 缩略图/波形生成
  └── 视频帧解码缓存

Phase 3（可选深度优化）:
  ├── wgpu 替代 WebGL 做特效渲染
  └── Rust 侧实现完整渲染管线（解码 → 特效 → 编码流水线化）
```

### 6.3 不建议 Rust 全部重写的理由

1. **UI 重写代价最大、收益最小** — 16,000 行 React 组件深度依赖 Radix UI、拖拽库、波形库等，Rust GUI 生态无法替代
2. **核心业务逻辑不是性能瓶颈** — Command 系统、Timeline Manager 是业务逻辑，TS/Rust 性能差异可忽略
3. **视频处理有成熟方案** — FFmpeg C 库通过 `ffmpeg-next` crate 调用即可，不需要重写
4. **ChatCut 的核心价值在 AI 能力** — 用户付费是为 Agent 智能剪辑，不是渲染性能。把半年花在重写上是错误的优先级
5. **渐进式迁移更安全** — Tauri 方案可以在保持产品迭代的同时，逐步将性能热点下沉到 Rust

---

## 七、对外 API 能力规划

ChatCut 的 API 能力来自两个系统的结合：OpenCut 的视频编辑能力 + creative-engine 的 AI 创意生产能力。二者形成从创意到成片的完整管线。

### 7.1 能力全景

```
creative-engine（前期制作）              ChatCut / OpenCut（后期制作）
───────────────────────                 ─────────────────────────
video-intel    分析/拆解参考视频  ──┐
content-ops    策略/Brief/质检     │
storyboard     分镜/角色一致性     ├──→  时间线编排
cinematography 镜头设计/提示词     │     特效/转场/动画
creative-api   生成图片和视频素材 ──┘     字幕/音频混合
character-bank 角色素材库管理            导出成片
production-line 端到端管线编排           模板渲染/批量导出
```

### 7.2 creative-engine 子 Skill 概览

| 子 Skill | 职责 | 来源 |
|----------|------|------|
| **video-intel** | 视频分析（爆款因子报告）、拆解（角色表+镜号表+元提示词）、多平台下载（抖音/TikTok/IG/YT/B站/小红书/快手/X） | ai-mega-tools |
| **content-ops** | Brief 生成、AI 味检测（5 轮 QC）、UGC 脚本、模型选择矩阵、系统提示词、内容策略 | ai-mega-tools |
| **cinematography** | 10 维交互式镜头设计、场景设计、光影控制、构图、转场设计、提示词生成（5 要素公式）、高级技巧（VFX/越轴/正反打/复杂叙事/动画） | ai-mega-tools |
| **storyboard** | 故事→镜号表、角色一致性关键词（15-25 词）、跨镜头身份锁定 | ai-mega-tools |
| **production-line** | 5 条端到端管线协议（文字转视频/短视频/爆款复刻/批量生产/商业广告） | ai-mega-tools |
| **creative-api** | 统一生成网关：jimeng/Seedance 2.0 + flow4api/Gemini/Veo 3 + Kling，支持文生图/文生视频/图生视频/转场视频/多镜头叙事/音效生成 | ai-mega-tools (已有 REST 服务) |
| **character-bank** | 角色素材库（161+ JSON 角色条目）、搜索/创建/修复角色、多视角网格图生成 | ai-mega-tools |

共享基础层（`_foundations/`）：3 个核心原则（电影语言、提示词架构、视频运动模型）+ 7 个分类词表（景别、运镜、组合运动、灯光、构图、风格、相机参数）。

### 7.3 API 分层设计

#### 第一层：原子操作 API（视频编辑基础设施）

等同于"可编程的视频编辑器"，直接映射 OpenCut 的 EditorCore 操作。

```
项目管理
  POST   /projects                        创建项目（画布尺寸、帧率、背景）
  GET    /projects/:id                    获取项目状态
  DELETE /projects/:id                    删除项目

媒体管理
  POST   /projects/:id/media              上传媒体（视频/图片/音频）
  GET    /projects/:id/media              列出媒体资产
  GET    /projects/:id/media/:mid/info    获取媒体信息（时长/分辨率/帧率）
  DELETE /projects/:id/media/:mid         删除媒体

时间线操作
  GET    /projects/:id/timeline           获取完整时间线状态
  POST   /projects/:id/tracks            添加轨道
  DELETE /projects/:id/tracks/:tid       删除轨道
  POST   /projects/:id/elements          插入元素（视频/图片/文字/贴纸/音频）
  PATCH  /projects/:id/elements/:eid     更新元素属性
  DELETE /projects/:id/elements/:eid     删除元素
  POST   /projects/:id/elements/:eid/split    分割元素
  POST   /projects/:id/elements/:eid/trim     裁剪元素
  POST   /projects/:id/elements/:eid/move     移动到新位置/轨道

特效与动画
  POST   /projects/:id/elements/:eid/effects           添加特效
  PATCH  /projects/:id/elements/:eid/effects/:fid      更新特效参数
  POST   /projects/:id/elements/:eid/keyframes         添加关键帧
  DELETE /projects/:id/elements/:eid/keyframes/:kid    删除关键帧

预览
  GET    /projects/:id/preview?time=3.5                获取某时间点截图（PNG）
  GET    /projects/:id/preview/clip?start=0&end=5      获取片段预览（低分辨率 GIF/MP4）

导出
  POST   /projects/:id/export             提交导出任务（格式/质量/帧率）
  GET    /exports/:jobId                  查询导出进度
  GET    /exports/:jobId/download         下载成品

批量操作
  POST   /projects/:id/batch              原子执行多个操作
```

#### 第二层：AI 驱动 API（核心差异化）

结合 Agent 层和 creative-engine 的 AI 能力。

```
自然语言编辑（ChatCut Agent 层）
  POST   /projects/:id/agent/edit
  {
    "instruction": "把开头5秒的空镜头删掉，结尾加上公司logo淡入",
    "approve_mode": "auto" | "manual"
  }
  → 返回 changeset（改了什么、改前/改后预览帧）

提示词生成（cinematography 的 prompt-generation）
  POST   /prompts/generate
  {
    "description": "女孩在樱花树下回头微笑",
    "style": "日系清新",
    "provider": "seedance" | "veo" | "kling"
  }
  → 返回结构化提示词（Subject + Action + Scene + Camera + Style）

分镜生成（storyboard）
  POST   /storyboards/generate
  {
    "script": "一段 30 秒的产品广告...",
    "shot_count": 6,
    "style": "commercial"
  }
  → 返回镜号表 + 角色一致性关键词 + 每镜头提示词

Brief 生成（content-ops）
  POST   /briefs/generate
  {
    "product": "新款跑鞋",
    "audience": "18-25 运动爱好者",
    "channel": "tiktok",
    "goal": "brand_awareness"
  }
  → 返回 7 段式结构化 Brief 文档

AI 味检测（content-ops QC）
  POST   /content/quality-check
  {
    "text": "这款产品采用了创新性的设计理念..."
  }
  → 返回 QC 报告（5 轮检查结果 + 改进建议）

UGC 脚本生成（content-ops）
  POST   /scripts/ugc
  {
    "product": "...",
    "format": "testimonial" | "unboxing" | "tutorial" | "before_after" | "day_in_life",
    "tone": "casual" | "professional" | "urgent"
  }
  → 返回口播脚本（含 hook + 痛点 + 转折 + CTA）

智能粗剪（ChatCut Agent 层）
  POST   /agent/rough-cut
  {
    "media": ["interview.mp4", "broll1.mp4", "broll2.mp4"],
    "instruction": "剪一个3分钟的采访视频，穿插B-roll画面",
    "style": "documentary" | "vlog" | "corporate" | "fast-paced"
  }
  → 返回完整项目（时间线已编排好）

平台适配（结合画布预设 + Agent）
  POST   /agent/adapt
  {
    "source_project": "proj_abc",
    "target": {
      "platform": "tiktok" | "youtube_shorts" | "instagram_reels" | "bilibili",
      "duration": 60,
      "aspect_ratio": "9:16"
    }
  }
  → 横版长视频自动改编为竖版短视频

多语言适配
  POST   /agent/localize
  {
    "source_project": "proj_abc",
    "target_languages": ["en", "ja", "es"],
    "subtitle_style": { ... }
  }
  → 自动翻译字幕、替换文字层、调整布局
```

#### 第三层：内容理解 API

video-intel 的分析能力 + OpenCut 已有的转录能力，可独立售卖。

```
视频分析（video-intel 分析模式）
  POST   /analysis/viral-factors
  {
    "video_url": "https://www.tiktok.com/@xxx/video/123"
  }
  → 返回爆款因子报告（结构化 JSON：hook、节奏、情感曲线、视觉策略）

视频拆解（video-intel 拆解模式）
  POST   /analysis/reverse-engineer
  {
    "video_url": "https://..."
  }
  → 返回复刻蓝图：角色表 + 镜号表 + 结构图 + 元提示词模板

视频下载（video-intel fetch）
  POST   /media/fetch
  {
    "url": "https://...",
    "platform": "auto"
  }
  → 支持抖音/TikTok/Instagram/YouTube/Bilibili/小红书/快手/X

自动转录/字幕（OpenCut 已有 Whisper 集成）
  POST   /media/transcribe
  {
    "file": "interview.mp4",
    "language": "zh" | "en" | "auto",
    "model": "whisper-small" | "whisper-large-v3-turbo",
    "words_per_caption": 3
  }
  → 返回带时间戳的逐句/逐词转录

缩略图/关键帧提取（OpenCut 已有）
  POST   /media/thumbnails
  {
    "file": "video.mp4",
    "count": 10,
    "strategy": "uniform" | "scene-change" | "best-quality"
  }
  → 返回缩略图列表
```

#### 第四层：AI 素材生成 API

直接包装 creative-api 的已有 REST 服务。

```
文生图（jimeng/Seedance + flow4api/Veo）
  POST   /generate/image
  {
    "prompt": "...",
    "provider": "seedance" | "veo",
    "dimensions": "1920x1080"
  }

图生图
  POST   /generate/image/transform
  {
    "prompt": "...",
    "image_url": "https://...",
    "provider": "seedance" | "veo"
  }

文生视频（三引擎）
  POST   /generate/video
  {
    "prompt": "...",
    "provider": "seedance" | "veo" | "kling",
    "duration": 5
  }

图生视频
  POST   /generate/video/from-image
  {
    "prompt": "...",
    "image_url": "https://...",
    "provider": "seedance" | "veo" | "kling"
  }

转场视频（jimeng）
  POST   /generate/video/transition
  {
    "prompt": "...",
    "first_image_url": "...",
    "last_image_url": "..."
  }

多镜头叙事视频（Kling）
  POST   /generate/video/multi-shot
  {
    "prompt": "...",
    "model": "kling-v3-omni",
    "multi_shot": true
  }

音效生成（Kling）
  POST   /generate/sound
  {
    "prompt": "...",
    "duration": 5
  }

任务状态轮询
  GET    /generate/status/:taskId

角色搜索
  POST   /characters/search
  { "query": "warm indoor brunette selfie energy" }

角色创建
  POST   /characters/create
  { "reference_image": "...", "description": "..." }
  → 返回结构化角色 JSON（含一致性关键词）
```

#### 第五层：端到端管线 API（最高商业价值）

对应 production-line 的 5 条管线，串联 creative-engine 全部子 skill + ChatCut 编辑能力。

```
文字转视频
  POST   /pipelines/text-to-video
  {
    "script": "一个女孩在樱花树下回头微笑...",
    "style": "日系清新",
    "duration": 15,
    "provider": "seedance"
  }
  → 自动走：分镜 → 角色设计 → 镜头设计 → 提示词 → 生成 → 编辑合成 → 导出

爆款复刻
  POST   /pipelines/replicate-viral
  {
    "source_url": "https://www.tiktok.com/@xxx/video/123",
    "adaptation": "换成我们的产品",
    "brand_assets": { "logo": "...", "colors": ["#FF5733"] }
  }
  → 自动走：下载 → 分析 → 拆解 → 改编分镜 → 重新生成 → 编辑 → 导出

商业广告
  POST   /pipelines/commercial
  {
    "product": "新款跑鞋",
    "audience": "18-25 运动爱好者",
    "platform": "tiktok",
    "style": "UGC 口播",
    "budget_tier": "mid"
  }
  → 自动走：Brief → 脚本 → 分镜 → 镜头设计 → 生成 → 编辑 → 导出

批量生产
  POST   /pipelines/batch-produce
  {
    "template_project": "proj_abc",
    "variants": [
      { "product_name": "产品A", "hero_image": "..." },
      { "product_name": "产品B", "hero_image": "..." }
    ],
    "count": 10
  }
  → 基于模板批量生成变体视频

短视频全流程
  POST   /pipelines/short-video
  {
    "concept": "记录一天的咖啡制作过程",
    "platform": "tiktok",
    "duration": 30,
    "shots": 5
  }
  → 会话式状态机：CONCEPT → STRUCTURE → SETUP → SHOT_DESIGN × N → TRANSITIONS → OUTPUT

多平台适配
  POST   /pipelines/platform-adapt
  {
    "source_project": "proj_abc",
    "targets": ["tiktok_9:16", "youtube_shorts", "instagram_reels", "bilibili"]
  }
  → 一条视频自动适配多平台

管线状态
  GET    /pipelines/:pipelineId/status    查询进度
  POST   /pipelines/:pipelineId/approve   人工审批节点
  POST   /pipelines/:pipelineId/cancel    取消

Webhook 回调
  POST   /webhooks
  {
    "url": "https://your-app.com/callback",
    "events": ["pipeline.complete", "pipeline.review_needed", "export.complete"]
  }
```

### 7.4 现有能力与新建工作对照

| API 能力 | creative-engine 已有 | OpenCut 已有 | 需要新建 |
|----------|:---:|:---:|:---:|
| AI 素材生成（图/视频） | creative-api REST 服务 | — | 加鉴权和计费 |
| 视频下载 | fetch-video.py 脚本 | — | HTTP 接口包装 |
| 角色搜索/创建 | search_bank.py + 161 JSON | — | HTTP 接口包装 |
| 提示词生成 | cinematography 5 要素公式 + 7 分类词表 | — | AI 包装层 |
| 分镜生成 | storyboard + character-design | — | AI 包装层 |
| 视频分析/拆解 | video-intel 两种模式 | — | AI 包装层 |
| Brief / QC / UGC 脚本 | content-ops 全套 | — | AI 包装层 |
| 时间线/元素 CRUD | — | EditorCore 全套 | HTTP 接口层 |
| 特效/动画/关键帧 | — | 有（目前仅 blur） | 需扩充特效库 |
| 导出 MP4/WebM | — | 有 | 改为服务端 headless 渲染 |
| 预览截图 | — | 有 saveSnapshot() | 加 HTTP 接口 |
| 自动字幕/转录 | — | Whisper 集成 | 加 HTTP 接口 |
| 音效/配乐搜索 | — | Freesound API 集成 | 直接暴露 |
| 贴纸/图标 | — | Iconify 集成 | 直接暴露 |
| 自然语言编辑 | — | — | Agent 层（核心新建） |
| 端到端管线 | production-line 5 条协议 | — | 管线执行引擎 + 编辑集成 |
| 模板渲染 | — | — | 模板系统（需新建） |

### 7.5 API 产品矩阵

```
                    低价值/通用 ←─────────────→ 高价值/独特
                         │                         │
  基础设施    第一层：原子操作 API                     │
  (按量)     "可编程的剪辑器"                         │
                         │                         │
  AI 生成     第四层：素材生成 API                     │
  (按次)     "统一的 AI 生成网关"                     │
                         │                         │
  智能编辑    ────── 第二层：AI 驱动 API ──────────────
  (按调用)              "说一句话就剪好"               │
                         │   ↑ 护城河                │
  内容理解    第三层：理解 API                         │
  (按时长)   "看懂视频 + 拆解爆款"                    │
                         │                         │
  全链路      ────── 第五层：管线 API ─────────────────
  (按pipeline)          "从一句话到一条成片"
              ↑ 市面上没有竞品覆盖这条完整链路
```

### 7.6 实施优先级

```
优先级 1 — 有现成能力，加 HTTP 壳就能卖:
  ├── creative-api 生成接口       ← REST 服务已运行
  ├── video-intel 视频下载        ← 脚本已有
  ├── character-bank 角色搜索     ← 脚本已有
  ├── 转录/字幕 API               ← OpenCut 已有 Whisper
  └── 原子操作 API                ← EditorCore 直接映射

优先级 2 — 核心差异化，需要 AI 包装层:
  ├── 提示词生成 API              ← cinematography prompt-generation
  ├── 视频分析/拆解 API           ← video-intel 两种模式
  ├── 分镜生成 API                ← storyboard 核心能力
  ├── 自然语言编辑 API            ← ChatCut Agent 层（灵魂功能）
  └── Brief / QC / UGC 脚本 API  ← content-ops

优先级 3 — 最高商业价值，需要管线引擎:
  ├── text-to-video 全链路        ← "说一句话出一条视频"
  ├── replicate-viral 复刻链路    ← "一键复刻爆款"
  ├── commercial 广告链路         ← 对接 hellyeah 广告业务
  └── platform-adapt 多平台适配   ← MCN/跨境电商需求强

优先级 4 — 规模化:
  ├── batch-produce 批量生产
  ├── 模板渲染系统
  └── Webhook + 异步任务队列
```

### 7.7 与 hellyeah 广告业务的协同

creative-engine 原本就是为 hellyeah 的广告创意生成设计的。ChatCut 的管线 API 可以直接对接 hellyeah 的 AIMA agent，形成闭环：

```
hellyeah AIMA (对话式营销 agent)
  ├── "帮我做一个 TikTok 广告"
  │    ↓ 调用 ChatCut 管线 API
  │    commercial pipeline → Brief → 分镜 → 生成 → 编辑 → 导出
  │    ↓ 返回成品视频
  ├── approve_creative → 推送到 Managed Ads 投放
  └── 投放数据 → creative versioning → 优化下一轮创意
```

这意味着 ChatCut 的管线 API 不仅是独立产品，也是 hellyeah 生态的基础设施。

---

## 八、总结

| 维度 | 结论 |
|------|------|
| 基础项目 | OpenCut 架构良好，Command 模式天然适合 Agent 驱动 |
| Agent 改造 | 加一层 Agent API + 审批层即可，核心代码几乎不改 |
| 性能瓶颈 | 导出串行循环 > 特效渲染 > 视频 Seek > 音频混合 |
| Native 化 | 推荐 Tauri，不建议 Rust 全部重写 |
| creative-engine | 7 个子 skill 覆盖前期制作全链路，其中 creative-api 已有 REST 服务 |
| API 差异化 | creative-engine + ChatCut = 从一句话到成片的全链路 API，市面无竞品覆盖 |
| 优先级 | 先包装已有能力出 API → 再建 Agent 层 → 再串管线 → 最后规模化 |
| 与 hellyeah 协同 | 管线 API 直接对接 AIMA agent，成为广告创意基础设施 |
