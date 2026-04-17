# ChatCut 架构设计文档

基于 [chatcut-research.md](./chatcut-research.md) 的调研结论，记录 ChatCut 的架构决策与实施路线。

---

## 一、核心分层

```
Level 0: 基础设施（OpenCut 已有）
├── 视频编解码（MediaBunny / WebCodecs 硬件加速）
├── 渲染管线（Canvas 2D + WebGL Fragment Shader）
├── 存储（IndexedDB / OPFS）
└── 项目管理 / 自动保存

Level 1: 时间线编辑（OpenCut 已有，需 API 化）
├── 轨道 / 元素 CRUD
├── 裁剪 / 拼接 / 分割 / 变速
├── 特效 / 转场 / 关键帧动画
├── 文字 / 贴纸 / 音频混合
├── Command 系统（undo/redo）
├── 需新增：帧序列提取、片段替换、Headless 模式
└── 需新增：Change Log（带归因的变更历史，Human-in-the-Loop 基础）

Level 2: 视频理解（新建，Gemini 驱动）
├── 视频语义分析 — Gemini 2.5 Pro 直接输入完整视频
│   ├── 场景分割（带时间戳 + 语义描述）
│   ├── 对象 / 角色识别
│   ├── 情绪 / 风格分析
│   └── 结构化输出（JSON schema）
├── 智能定位 — 自然语言 → 时间范围
│   └── "主角出场的那段" → {start: 3.2, end: 8.7}
├── [可选] 帧精确对齐 — Gemini 时间戳 ±1s 窗口内
│   └── PySceneDetect / TransNetV2 找精确切点
└── [可选] SAM2 精确分割（后期像素级精度增强）

Level 3: 内容生成（新建，调外部 API）
├── 帧序列 + prompt → 生成模型（Kling / Veo / Runway / Seedance）
├── 生成结果质检（前后帧对比）
├── 替换回时间线
└── creative-engine 已有生成 API 封装可复用

Level 4: Agent 编排层（新建，Master Agent SDK + Sub-agent Claude API）
├── Master Agent（Opus 4.6）→ 意图解析 / 任务拆解 / 调度
├── 5 个 Sub-agent（Vision/Editor/Creator/Audio/Asset）
├── Changeset 暂存 / 审批（propose / approve / reject）
├── Context Synchronizer（Change Log → Agent 上下文同步）
└── Chat UI

跨层：资产管理系统（新建）
├── Skill 存档 — 编辑工作流可复用（借鉴 OpenStoryline）
├── 素材存档 — 生成/收集的素材可跨项目复用
│   ├── 角色素材（character-bank 已有 161+ 角色条目）
│   ├── 生成片段（带 prompt + 参数 + 来源模型，可追溯）
│   ├── 音乐 / 音效收藏
│   └── 品牌资产（logo、配色、字体、片头片尾模板）
└── 项目素材索引 — 记录每个项目用了哪些素材及来源
```

---

## 二、关键架构决策

### 2.1 基于 OpenCut，不做 Rust 全重写

**决策：** 在 OpenCut（Next.js + React + TypeScript，~52,500 行）基础上改造，不用 Rust 重写。

**理由：**

- 16,000 行 React 组件深度依赖 Radix UI、拖拽库、波形库，Rust GUI 生态无法替代
- 核心业务逻辑（Command 系统、Timeline Manager）不是性能瓶颈，TS/Rust 差异可忽略
- 视频编解码已走 WebCodecs 硬件加速，WASM 反而是纯 CPU，性能更差
- ChatCut 的核心价值在 AI 能力，不是渲染性能
- Native 化可走 Tauri 路线，渐进式下沉性能热点到 Rust

**OpenCut 实际未使用 WASM：** 虽然依赖了 `@ffmpeg/ffmpeg`（32MB wasm 文件），但代码中零引用——是死代码。所有视频处理由 MediaBunny + WebCodecs API 完成。

### 2.2 MVP 不需要 SAM2

**决策：** 视频内容编辑走"帧序列 + 文本 prompt"直送生成模型，不做像素级分割。

**理由：**

- 现代视频生成模型（Kling、Veo 3）文本理解能力已足够定位大部分编辑目标
- SAM2 需要 GPU 服务端部署，增加基础设施复杂度
- 需要配套 mask 可视化 + 手动修正的交互设计，UI 工作量大
- 大部分用户场景不需要像素级精度

**SAM2 的适用场景（后期加）：**

| 场景 | 纯 prompt 能否解决 | 需要 SAM2 |
|------|:---:|:---:|
| "把外套换成黑色" | 大部分 OK | 不需要 |
| "把左边那个人的外套换了"（多人歧义） | 可能改错 | 需要 |
| "把这个小 logo 去掉"（小目标） | 可能忽略 | 需要 |
| "只改脸不改发型"（精确边界） | 文字描述模糊 | 需要 |
| 模型 API 要求必须传 mask | 无法绕过 | 需要 |

**结论：** SAM2 作为精度增强手段，当用户发现"模型改错地方了"时提供"手动圈选"的 fallback 能力。

### 2.3 Gemini 驱动视频理解，一步完成语义分割

**决策：** 用 Gemini 2.5 Pro 直接输入完整视频，一次调用同时完成场景理解和语义分割，取代传统的"先切镜头再逐段理解"两步流程。

**理由：**

- Gemini 2.5 Pro 支持直接输入视频（最长 1 小时），能输出带时间戳的结构化场景描述
- 一次调用 = 场景分割 + 内容理解 + 对象识别，不需要 TransNetV2 等独立模型
- 分割本身就带语义（"主角入场"而非"第 3.2 秒画面变化"），对 Agent 更有价值
- 不需要自建模型或部署推理服务，开发量小，重点在 prompt engineering 和结果结构化

**与传统方案的对比：**

```
传统路线（OpenStoryline 的做法）：
  视频 → TransNetV2 按画面变化盲切 → LLM 逐片段理解
  两步、两个模型、切分不带语义

ChatCut 路线：
  视频 → Gemini 直接看完整视频 → 输出语义分割 + 内容描述
  一步到位、切分即理解
```

**Gemini 输出示例：**

```json
{
  "scenes": [
    {"start": 0.0, "end": 3.2, "description": "品牌 logo 渐入，白底"},
    {"start": 3.2, "end": 8.7, "description": "主角穿红色外套走进咖啡店，中景"},
    {"start": 8.7, "end": 12.1, "description": "咖啡师特写，拉花"},
    {"start": 12.1, "end": 18.5, "description": "主角坐下，和对面的人对话，双人镜头"}
  ],
  "characters": ["红衣女生（主角）", "咖啡师", "对话男生"],
  "mood": "温暖、日常"
}
```

**精度补偿：** Gemini 的时间戳精度约 0.5-1 秒。如果需要帧精确的切割点（如精确到某个转场的第一帧），在 Gemini 时间戳 ±1 秒窗口内用 PySceneDetect / TransNetV2 做精确对齐。大部分场景下 Gemini 的精度已经够用。

**TransNetV2 / AutoShot 的保留场景：**

| 场景 | 用 Gemini | 用传统模型 |
|------|:---------:|:----------:|
| 需要语义理解的分割 | 首选 | 不适合 |
| 超长视频（>1 小时） | 受限于 API 上限 | 适合 |
| 高频批量处理（成本敏感） | API 费用高 | 本地推理更省 |
| 需要帧精确切点 | 精度 ~0.5-1s | 帧级精度 |

### 2.4 混合部署架构

**决策：** 浏览器端做轻量交互，服务端做重计算。

```
浏览器端                          服务端
────────                          ──────
时间线编辑 UI                      视频语义理解（多模态 API）
帧预览 / 播放                      内容生成（Kling / Veo API）
用户交互（点选、确认）               [可选] SAM2 精确分割
生成结果预览                        Headless 渲染 / 导出
轻量检测（Florence-2 ONNX，可选）    批量处理 / 任务队列
```

### 2.5 两类编辑操作的本质区别

OpenCut 的 Command 系统操作粒度是**元素/属性级**，最小单位是单个元素的单个属性。这覆盖了时间线编辑，但无法处理帧内像素级修改。

```
时间线编辑（Level 1，OpenCut Command 系统）
  操作对象：片段、轨道、特效、关键帧
  粒度：元素 / 属性级
  例："把第二段裁短到 3 秒"

内容编辑（Level 2 + 3，新建）
  操作对象：视频帧内的像素、对象、区域
  粒度：帧序列 / 对象级
  例："把主角的红外套换成黑皮夹克"
  链路：提取帧序列 → prompt + frames → 生成模型 → 新片段 → 替换回时间线
```

Agent 层需要能识别用户意图属于哪类，并路由到对应链路。

### 2.6 ~~混合 SDK 策略~~ → 全部 Agent SDK（已更新）

> **注：** 此决策已在 [chatcut-agent-system.md](./chatcut-agent-system.md) 中更新为全部 Agent SDK。Gemini 降级为 Vision Agent 的 tool 实现，不再作为 agent 运行时。以下为原始决策记录，保留作为决策演变参考。

**原始决策：** Master Agent 基于 Claude Agent SDK 实现（复用其上下文管理、session 持久化、hooks 能力），Sub-agent 内部用 Claude API 实现（保持模型选择自由度和精细控制）。

**理由：**

Agent SDK 提供的关键能力（自动 compaction、session 恢复、token 预算控制、hooks 拦截）如果自己从零实现工作量大且容易出 bug。但 Agent SDK 的 subagent 模型限制所有 agent 必须用 Claude，而 ChatCut 的 Vision Agent 需要用 Gemini。

混合方案取两者之长：

```
Master Agent（Agent SDK 运行时）
├── 复用：上下文管理、session 持久化、hooks、token 预算
├── 工具通过进程内 MCP server 注册（不是外部 MCP，无网络开销）
└── dispatch_* 工具内部用 Claude API / Gemini API 跑独立 sub-agent loop

Sub-agents（Claude API / Gemini API）
├── Vision Agent → Gemini 2.5 Pro（视频理解 Gemini 更强）
├── Editor Agent → Claude Sonnet 4.6（工具调用为主）
├── Creator Agent → Claude Sonnet 4.6（参数构造和 API 调用）
├── Audio Agent → Claude Sonnet 4.6
└── Asset Agent → Claude Haiku 4.5（简单 CRUD）
```

**不用外部 MCP 的立场不变：** 进程内 MCP server（`create_sdk_mcp_server`）只是 Agent SDK 的工具注册机制，和部署外部 MCP server 通过协议通信是完全不同的事。不涉及额外进程、网络开销或协议解析。

**参考：** [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) 采用外部 MCP 架构是因为它定位为通用工具平台，需要对接多种 LLM 客户端。ChatCut 定位为一体化产品，不需要这层抽象。

### 2.7 Agentic 而非 Workflow：不用 DAG 编排

**决策：** Agent 层采用完全 agentic 的架构，不采用 OpenStoryline 的 DAG/节点管线模式。

**理由：**

OpenStoryline 的节点管线是预定义流程（load → split → understand → group → plan → render），LLM 只负责填参数，本质上是参数化的 pipeline。ChatCut 需要的是对话式编辑——用户随时改主意、追加需求、要求回退，只有 agentic 模式才能处理。

| 维度 | Workflow (DAG) | Agentic（ChatCut） |
|------|---------------|-------------------|
| 执行顺序 | 预定义，固定 | Agent 动态决定 |
| 工具选择 | 按 DAG 依赖自动触发 | Agent 根据上下文选 |
| 错误处理 | 失败就报错 | Agent 换策略重试 |
| 回退/循环 | 不支持 | 可以反复调整 |
| LLM 角色 | 填参数的表单 | 决策者 |

### 2.8 Human-in-the-Loop：双向上下文同步

**决策：** 借鉴 Vue 双向数据绑定思想，通过 Change Log + Context Synchronizer 实现 Human 操作和 Agent 上下文的自动同步。

**问题：** Human 和 Agent 都操作同一个 Timeline State（通过 OpenCut EditorCore），但 Agent 的上下文（messages）只包含自己的操作。Human 在 UI 上的修改对 Agent 不可见，导致 Agent 基于过时状态做决策。

```
当前（单向）：
  Human UI ──→ EditorCore ──→ Timeline State ──→ UI 重渲染 ✓
  Agent     ──→ EditorCore ──→ Timeline State ──→ UI 重渲染 ✓
  Human UI ──→ EditorCore ──→ Agent Context   ✗ ← 缺失！

目标（双向，类 Vue）：
  Timeline State (reactive)
    ↕ 双向同步
  Human UI          ← OpenCut Observer（已有）
  Agent Context     ← Change Log + Context Synchronizer（新增）
```

**核心机制：Event-Sourced Context**

所有变更（Human + Agent）记录到同一个 Change Log，带来源归因。Agent 每次行动前读取 Human 的变更作为上下文增量。

```
UI 操作 / Agent Tool
        ↓
CommandManager.execute(command, {source: "human" | "agent"})
        ↓
  ┌─ 1. command.execute()        ← 修改 state（已有）
  ├─ 2. changeLog.record(...)     ← 写 Change Log + 语义化描述（新增）
  └─ 3. notify observers          ← 通知 UI 重渲染（已有）
```

**关键设计：Command 即语义。** OpenCut 的 Command 系统天然是 UI 操作的语义化表达（MoveElementCommand、TrimClipCommand 等），不需要额外的翻译层。ChangeLog 从 Command 对象 + Timeline State 直接生成人类/Agent 可读的摘要。

**同步策略：Lazy Sync。** Agent 下一次被调用时，在 messages 前注入 Human 变更摘要。不实时推送（太吵、太贵），Agent 本身不是实时系统。

详见第三章 3.12 节。

### 2.9 双存档机制：Skill 存档 + 素材存档

**决策：** 同时实现编辑工作流存档和素材资产存档，支持跨项目复用。

**背景：** [FireRed-OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) 只有 Skill 存档（保存编辑工作流），没有素材存档。ChatCut 需要补齐素材侧。

**Skill 存档（借鉴 OpenStoryline）：**

保存"怎么剪"——编辑工作流可复用。

```
例：保存"快节奏产品展示"技能
├── 剪辑节奏模式（每段 2-3 秒，beat 对齐）
├── 转场风格（快速切换 + 缩放）
├── 字幕样式（底部居中，粗体白字黑底）
└── 配乐风格偏好（electronic, upbeat）
```

**素材存档（ChatCut 新增）：**

保存"用什么剪"——生成/收集的素材可跨项目复用。

| 素材类型 | 存储内容 | 复用场景 |
|---------|---------|---------|
| 角色素材 | 角色描述 + 一致性关键词 + 参考图 | 同一角色出现在多个视频中 |
| 生成片段 | 视频/图片 + prompt + 参数 + 来源模型 | "上次生成的那个片段效果很好，再用一次" |
| 音乐/音效 | 文件 + 元数据 + 使用记录 | 品牌固定 BGM |
| 品牌资产 | logo、配色方案、字体、片头片尾模板 | 所有品牌视频统一视觉 |

**生成片段的可追溯性：** 每个 AI 生成的素材都记录完整的生成上下文（prompt、模型、参数、种子），支持"基于这个再生成一个类似的"。

---

## 三、多 Agent 架构

### 3.1 总体结构

```
                         ┌─────────────────────────┐
                         │     Master Agent         │
              用户 ◄────►│     (Agent SDK 运行时)    │
                         │     Claude Opus 4.6      │
                         │     adaptive thinking    │
                         └────────────┬─────────────┘
                                      │
               ┌──────────┬───────────┼───────────┬──────────┐
               ▼          ▼           ▼           ▼          ▼
          ┌─────────┐┌─────────┐┌──────────┐┌─────────┐┌─────────┐
          │ Vision  ││ Editor  ││ Creator  ││ Audio   ││ Asset   │
          │ Agent   ││ Agent   ││ Agent    ││ Agent   ││ Agent   │
          │ Gemini  ││ Sonnet  ││ Sonnet   ││ Sonnet  ││ Haiku   │
          └─────────┘└─────────┘└──────────┘└─────────┘└─────────┘
              │           │          │           │          │
          Claude API  Claude API  Claude API  Claude API  Claude API
          (或 Gemini)
```

Sub-agent 之间不直接通信，所有协调经过 Master。Master 通过 Agent SDK 的 hooks 拦截编辑操作，实现 changeset 审批流。

### 3.2 Tool 与 Skill 的区别

| 维度 | Tool | Skill |
|------|------|-------|
| 本质 | 原子操作，有明确输入/输出 | 专业知识，指导 agent 怎么用 tools |
| 运行时 | agent 直接调用 | 加载到 agent 的 system prompt 中 |
| 类比 | 剪刀、调色板、时间线 | "知道怎么剪婚礼视频" |
| 数量 | 固定（产品能力边界） | 增长（用户保存 + 系统预置 + 社区共享） |
| 来源 | 代码定义 | 数据（JSON/Markdown 描述） |

Tool 是固定的能力集，Skill 是可增长的知识库。同样的 tools，加载不同的 skill 会产出完全不同的剪辑风格。

### 3.3 Master Agent

**职责：** 理解用户意图，拆解任务，调度 sub-agent，管理对话上下文和审批流程。不直接操作视频。

**运行时：** Claude Agent SDK（复用上下文管理、session、hooks）

**模型：** Claude Opus 4.6 + adaptive thinking

**Tools：**

| Tool | 说明 |
|------|------|
| `dispatch_vision` | 调度 Vision Agent，传入分析任务 |
| `dispatch_editor` | 调度 Editor Agent，传入编辑任务 |
| `dispatch_creator` | 调度 Creator Agent，传入生成任务 |
| `dispatch_audio` | 调度 Audio Agent，传入音频任务 |
| `dispatch_asset` | 调度 Asset Agent，传入素材管理任务 |
| `propose_changes` | 将一组操作打包提交用户审批 |
| `export_video` | 提交导出任务 |
| `check_export_status` | 查询导出进度 |

**Skills：**

| Skill | 来源 | 说明 |
|-------|------|------|
| 快节奏产品展示 | 用户保存 | 节奏、转场、时长的完整规范 |
| Vlog 日常剪辑 | 用户保存 | 叙事结构、配乐风格、字幕样式 |
| 爆款复刻 | 系统预置 | 分析参考视频 → 提取结构 → 按模式重建 |
| 多平台适配 | 系统预置 | 横版→竖版的裁切、字幕重排策略 |

**并行调度：** Claude API 支持一次响应返回多个 tool_use block。Master 识别独立子任务后同时返回多个 dispatch 调用，代码层用 `asyncio.gather` 真正并行执行：

```python
# Master 返回两个并行 tool_use
tool_blocks = [b for b in response.content if b.type == "tool_use"]
# dispatch_vision 和 dispatch_audio 同时跑
results = await asyncio.gather(*[execute(b) for b in tool_blocks])
```

### 3.4 Vision Agent（视频理解）

**职责：** 看懂视频内容，提供语义级的场景分割和定位。

**模型：** Gemini 2.5 Pro（不是 Claude——视频理解 Gemini 更强）

**Tools：**

| Tool | 输入 | 输出 |
|------|------|------|
| `analyze_video` | video_file, focus? | scenes[], characters[], mood |
| `locate_scene` | query | {start, end, description}[] |
| `describe_frame` | time | description, objects[] |

**Skills：**

| Skill | 说明 |
|-------|------|
| 爆款因子分析 | 分析 hook 强度、节奏曲线、情感转折（来自 creative-engine video-intel） |
| 广告结构识别 | 识别 CTA、产品展示、testimonial 等广告段落结构 |
| 内容安全审查 | 检查敏感内容、品牌侵权风险 |

### 3.5 Editor Agent（时间线编辑）

**职责：** 操作 OpenCut 的时间线，执行所有裁剪、拼接、变换操作。

**模型：** Claude Sonnet 4.6

**Tools（16 个）：**

| 类别 | Tool | 说明 |
|------|------|------|
| 查询 | `get_timeline_state` | 当前时间线完整状态 |
| | `get_element_info` | 单个元素详情 |
| | `preview_frame` | 某时间点截图 |
| | `preview_clip` | 某时间范围预览 |
| 编辑 | `insert_clip` | 插入元素 |
| | `trim_clip` | 裁剪头尾 |
| | `split_clip` | 分割 |
| | `delete_clip` | 删除 |
| | `move_clip` | 移动 |
| | `set_speed` | 变速 |
| | `update_element` | 更新任意属性 |
| | `add_text` | 添加文字 |
| | `add_effect` | 添加特效 |
| | `batch_edit` | 批量操作（合并独立写操作，减少往返） |
| | `undo` | 撤销 |
| | `redo` | 重做 |

**Skills：**

| Skill | 说明 |
|-------|------|
| Beat 对齐剪辑 | 片段切换点吸附到 BGM 节拍（借鉴 OpenStoryline plan_timeline） |
| J-Cut / L-Cut | 音频先于/晚于画面切换的专业剪辑技法 |
| 节奏曲线控制 | 根据情绪弧线调整片段时长 |
| 安全区裁切 | 竖屏适配时保留重要内容在安全区内 |

**并行说明：** Editor 内部工具执行是顺序的（OpenCut CommandManager 每次 snapshot 整个 tracks）。`batch_edit` 可合并多个独立写操作为一次原子提交。读操作（preview_frame 等）可并行。

### 3.6 Creator Agent（内容生成）

**职责：** 调用外部 AI 生成模型，产出新的视频/图片内容。

**模型：** Claude Sonnet 4.6

**Tools：**

| Tool | 输入 | 输出 |
|------|------|------|
| `generate_video` | prompt, provider?, duration?, ref_image? | task_id |
| `generate_image` | prompt, provider?, dimensions? | image_url |
| `replace_segment` | element_id, prompt, time_range? | task_id |
| `generate_transition` | prompt, first_image, last_image | task_id |
| `check_generation_status` | task_id | status, progress, result_url? |

**Skills：**

| Skill | 说明 |
|-------|------|
| 提示词工程 | 5 要素公式（Subject+Action+Scene+Camera+Style），来自 creative-engine cinematography |
| 模型选择策略 | 人物用 Kling、风景用 Veo、商业用 Seedance 的路由规则 |
| 角色一致性 | 跨镜头保持同一角色外观的关键词策略（来自 character-bank） |
| 风格迁移 | 从参考视频提取视觉风格并应用到生成中 |

### 3.7 Audio Agent（音频处理）

**职责：** 处理配乐、音效、语音、字幕。

**模型：** Claude Sonnet 4.6

**Tools：**

| Tool | 输入 | 输出 |
|------|------|------|
| `search_bgm` | mood?, genre?, bpm_range? | bgm_list[] |
| `add_bgm` | bgm_id_or_url, volume? | element_id |
| `set_volume` | element_id, volume | ok |
| `generate_voiceover` | text, voice_style? | audio_url, duration |
| `transcribe` | media_id, language? | captions[] with timestamps |
| `auto_subtitle` | captions, style? | element_ids[] |

**Skills：**

| Skill | 说明 |
|-------|------|
| 音频闪避 (Ducking) | 有旁白时自动降低 BGM 音量 |
| 节拍检测 | 分析 BGM 的 BPM 和节拍点，供 Editor 的 beat 对齐使用 |
| 多语言字幕 | 自动翻译 + 调整不同语言的字幕时长和换行 |

### 3.8 Asset Agent（素材管理）

**职责：** 管理跨项目的素材库和工作流模板。

**模型：** Claude Haiku 4.5（最简单的 CRUD 操作）

**Tools：**

| Tool | 输入 | 输出 |
|------|------|------|
| `search_assets` | query, type? | assets[] |
| `save_asset` | file_or_url, metadata, tags? | asset_id |
| `search_characters` | query | characters[] |
| `import_media` | url_or_file | media_id |
| `save_skill` | name, description | skill_id |
| `list_skills` | query? | skills[] |
| `load_skill` | skill_id, target_agent | loaded skill content |

**Skills：**

| Skill | 说明 |
|-------|------|
| 智能标签 | 保存素材时自动生成标签和描述 |
| 素材去重 | 检测重复或高度相似的素材 |

### 3.9 汇总

| Agent | 模型 | Tools | Skills | 职责 |
|-------|------|:-----:|:------:|------|
| **Master** | Opus 4.6 | 8 | 4+ | 编排 / 审批 / 导出 |
| **Vision** | Gemini 2.5 Pro | 3 | 3+ | 视频理解 / 场景分割 |
| **Editor** | Sonnet 4.6 | 16 | 4+ | 时间线操作 |
| **Creator** | Sonnet 4.6 | 5 | 4+ | AI 内容生成 |
| **Audio** | Sonnet 4.6 | 6 | 3+ | 音频 / 配乐 / 字幕 |
| **Asset** | Haiku 4.5 | 7 | 2+ | 素材 / 技能管理 |
| **合计** | | **45** | **20+** | |

### 3.10 并行策略

| 层级 | 策略 | 收益 |
|------|------|------|
| Agent 间 | Master 同时 dispatch 独立子任务（asyncio.gather） | **大**（Creator 30s + Audio 2s → 并行 30s） |
| Tool 批量 | Editor 的 `batch_edit` 合并独立写操作 | **中**（减少往返，一次 snapshot） |
| 读操作 | 多个 preview/query 并发 | **小**（毫秒级） |
| Tool 写操作 | **不并行**，保持顺序（CommandManager 约束） | — |

### 3.11 Human-in-the-Loop：双向上下文同步

Human 和 Agent 共享同一个 Timeline State，需要双向感知对方的操作。

#### 3.11.1 Change Log 数据结构

```typescript
interface ChangeEntry {
  id: string;
  timestamp: number;
  source: "human" | "agent" | "system";
  agentId?: string;

  // 结构化动作（机器可读）
  action: {
    type: "insert" | "delete" | "update" | "trim" | "split" | "move" | ...;
    targetType: "element" | "track" | "effect" | "keyframe";
    targetId: string;
    details: Record<string, any>;
  };

  // 自然语言摘要（Agent 可读）
  summary: string;  // "用户删除了「咖啡师特写」"
}
```

#### 3.11.2 变更归因：谁改的？

改造 CommandManager，execute 时带来源标记：

```typescript
// EditorCore 包装层，UI 代码零修改
class EditorCore {
  // UI 调用（默认 human）
  executeCommand(command: Command) {
    this.command.execute(command, { source: "human" });
  }

  // Agent tool 调用
  executeAgentCommand(command: Command, agentId: string) {
    this.command.execute(command, { source: "agent", agentId });
  }
}
```

现有 UI 代码全部通过 `editor.executeCommand()` 调用，自动标记为 human。Agent 的 tool 执行层通过 `editor.executeAgentCommand()` 调用。

#### 3.11.3 语义化：Command → 自然语言摘要

不需要 LLM 翻译。Command 种类有限（约 25 种），每种一个模板字符串即可覆盖：

```typescript
class ChangeLog {
  record(command: Command, metadata: CommandMetadata, state: TimelineState) {
    this.entries.push({
      id: generateId(),
      timestamp: Date.now(),
      source: metadata.source,
      agentId: metadata.agentId,
      action: this.extractAction(command),
      summary: this.buildSummary(command, state),
    });
  }

  private buildSummary(command: Command, state: TimelineState): string {
    // 从 state 解析 element 名称
    const resolve = (id: string) => findElement(state, id)?.name || id;

    if (command instanceof MoveElementCommand)
      return `移动了「${resolve(command.elementId)}」到 ${formatTime(command.newStartTime)}`;
    if (command instanceof DeleteElementsCommand)
      return `删除了 ${command.elementIds.map(resolve).join("、")}`;
    if (command instanceof UpdateElementTrimCommand)
      return `裁剪了「${resolve(command.elementId)}」（${formatTime(command.trimStart)} - ${formatTime(command.trimEnd)}）`;
    if (command instanceof SplitElementsCommand)
      return `在 ${formatTime(command.splitTime)} 处分割了「${resolve(command.elementId)}」`;
    if (command instanceof AddClipEffectCommand)
      return `给「${resolve(command.elementId)}」添加了 ${command.effectType} 特效`;
    if (command instanceof InsertElementCommand)
      return `插入了新${typeLabel(command.element.type)}「${command.element.name}」`;
    // ... 每种 Command 一个模板，BatchCommand 递归展开子命令
  }
}
```

#### 3.11.4 Context Synchronizer：注入 Agent 上下文

Agent 每次被调用前，读取 Change Log 中自上次行动以来的所有 Human 变更，生成摘要注入 messages：

```python
class ContextSynchronizer:
    def __init__(self, change_log):
        self.change_log = change_log
        self.last_synced_id: dict[str, str] = {}  # agent_id → last seen change_id

    def build_context_update(self, agent_id: str) -> str | None:
        """构建注入 agent context 的变更摘要"""
        last_id = self.last_synced_id.get(agent_id)
        human_changes = [
            c for c in self.change_log.get_after(last_id)
            if c.source == "human"
        ]
        if not human_changes:
            return None

        summaries = [c.summary for c in human_changes]
        self.last_synced_id[agent_id] = human_changes[-1].id

        return (
            "## 用户在你上次操作后做了以下修改：\n"
            + "\n".join(f"- {s}" for s in summaries)
            + "\n\n请基于当前最新状态继续工作。"
        )
```

#### 3.11.5 实际交互流程

```
用户: "把主角出场那段加个电影感滤镜"

  Master → dispatch_vision → dispatch_editor → 完成

  ──── Agent 等待中，用户在 UI 上修改 ────
  用户手动：删除 element_Y，移动 element_Z，调 BGM 音量
  Change Log 自动记录 3 条 human 变更

  ──── 用户输入新指令 ────

用户: "再把结尾缩短 2 秒"

  Master 收到的 messages:
  [
    {"role": "assistant", "content": "已完成电影感滤镜..."},
    {"role": "user", "content":
      "## 用户在你上次操作后做了以下修改：\n"
      "- 删除了「空镜头」（2.3-5.1秒）\n"
      "- 移动了「产品特写」从 track_1 到 track_2\n"
      "- 将 BGM 音量调整为 0.3\n\n"
      "## 用户新指令：\n"
      "再把结尾缩短 2 秒"
    }
  ]
```

#### 3.11.6 与 Vue 双向绑定的对应关系

```
Vue                          ChatCut
─────────────────            ─────────────────
reactive(data)         ←→    Timeline State + Change Log
v-model（双向绑定）     ←→    Command 归因 + Context Synchronizer
computed（派生状态）    ←→    Agent 的 get_timeline_state 工具
watch（监听变化）       ←→    Change Log 的 subscribe
template（渲染视图）   ←→    UI 渲染 + Agent Context 构建
```

#### 3.11.7 对 OpenCut 的改动

| 改动 | 文件 | 说明 |
|------|------|------|
| Command 加 source 字段 | `core/managers/commands.ts` | `execute(cmd, {source, agentId})` |
| Change Log 模块 | 新增 `core/change-log.ts` | 带归因的变更历史 |
| CommandManager hook | `core/managers/commands.ts` | execute 后写 Change Log |
| Context Synchronizer | 新增 `agent/context-sync.ts` | 读 Change Log，生成 Agent 上下文增量 |
| EditorCore 包装 | `core/index.ts` | `executeCommand` / `executeAgentCommand` 区分来源 |

核心代码（TimelineManager、渲染管线、UI 组件）不需要修改。UI 组件继续调用原有的 `editor.executeCommand()`，自动标记为 human。

### 3.12 技术实现骨架

```python
from claude_agent_sdk import tool, create_sdk_mcp_server, ClaudeSDKClient, ClaudeAgentOptions
import anthropic
import asyncio

gemini_client = ...  # Gemini API client
claude_client = anthropic.AsyncAnthropic()

# ===== Sub-agent loops（Claude API / Gemini API）=====

async def vision_agent_loop(task: str) -> str:
    """Vision Agent: 用 Gemini 跑独立 loop"""
    # 调用 Gemini 2.5 Pro 分析视频
    response = await gemini_client.generate(task, ...)
    return response.text

async def editor_agent_loop(task: str, skills: list[str] = None) -> str:
    """Editor Agent: 用 Claude Sonnet 跑独立 agentic loop"""
    system = "你是专业视频剪辑师..."
    if skills:
        system += "\n\n## Loaded Skills\n" + "\n".join(skills)
    messages = [{"role": "user", "content": task}]
    while True:
        response = await claude_client.messages.create(
            model="claude-sonnet-4-6", max_tokens=4096,
            system=system, tools=editor_tools, messages=messages,
        )
        if response.stop_reason == "end_turn":
            return next(b.text for b in response.content if b.type == "text")
        # ... 执行 tool calls，继续 loop

# ===== Master 的 dispatch 工具（进程内 MCP 注册）=====

@tool("dispatch_vision", "调度视频理解 Agent", {"task": str})
async def dispatch_vision(args):
    result = await vision_agent_loop(args["task"])
    return {"content": [{"type": "text", "text": result}]}

@tool("dispatch_editor", "调度时间线编辑 Agent", {"task": str})
async def dispatch_editor(args):
    skills = await load_skills_for("editor")
    result = await editor_agent_loop(args["task"], skills)
    return {"content": [{"type": "text", "text": result}]}

# ... dispatch_creator, dispatch_audio, dispatch_asset 同理

master_server = create_sdk_mcp_server("chatcut", tools=[
    dispatch_vision, dispatch_editor, dispatch_creator,
    dispatch_audio, dispatch_asset, propose_changes, export_video,
])

# ===== Master Agent（Agent SDK 运行时）=====

async def main(user_message: str):
    async with ClaudeSDKClient(options=ClaudeAgentOptions(
        system_prompt="你是 ChatCut 的主编排 Agent...",
        model="claude-opus-4-6",
        mcp_servers={"chatcut": master_server},
        hooks={
            "PreToolUse": [HookMatcher(
                matcher="dispatch_editor",
                hooks=[changeset_interceptor],  # 拦截编辑操作，进入审批
            )],
        },
    )) as client:
        await client.query(user_message)
        async for message in client.receive_response():
            # 处理响应...
```

---

## 四、实施路线

### Phase 1：Level 1 API 化 + Change Log（1-2 周）

把 OpenCut 的 EditorCore 包装成可编程接口，同时植入 Change Log 基础设施。

**具体交付：**

- [ ] 帧序列提取 API：给定时间范围，导出帧图片或视频片段
- [ ] 片段替换 API：将外部生成的视频片段写回时间线指定位置
- [ ] 时间线状态序列化：将当前时间线导出为结构化 JSON（供 Agent / 外部系统读取）
- [ ] Headless 模式：EditorCore 脱离 UI 运行，服务端可调用
- [ ] Change Log 模块：CommandManager 改造，execute 带 source 标记，变更写入 Change Log
- [ ] EditorCore 包装：`executeCommand`（human 默认）/ `executeAgentCommand`（agent 标记）

**为什么先做：**

- 这是连接 Level 1（时间线）和 Level 3（生成模型）的桥梁
- Change Log 是 Human-in-the-Loop 的基础，越早植入越好（后面所有 Phase 都依赖它）
- 改动最小，OpenCut 已有 90% 的能力
- 做完即可被脚本 / API / CLI 调用

### Phase 2：Level 3 核心链路打通（2-3 周）

验证"提取 → 生成 → 替换"的完整闭环。

**具体交付：**

- [ ] 接入 creative-engine 生成 API（Kling / Veo / Seedance，已有 REST 封装）
- [ ] 编辑链路：帧序列 + prompt → 生成模型 → 返回新片段
- [ ] 替换链路：新片段自动替换回时间线对应位置
- [ ] 前后对比预览
- [ ] CLI 工具验证完整链路

**为什么第二做：**

- creative-engine 已有 API 封装，不用从零建
- 这是产品核心价值的最短验证路径
- 一个 CLI 脚本就能跑通，不需要 UI

### Phase 3：Level 2 视频理解（2-3 周）

让系统能"看懂"视频内容，一步完成语义分割。

**具体交付：**

- [ ] 接入 Gemini 2.5 Pro 视频理解 API
- [ ] 设计 prompt + JSON schema，实现一次调用输出：场景分割（带时间戳）、角色识别、情绪分析
- [ ] 智能定位：用户说"主角出场的那段"→ 自动从 Gemini 分析结果中匹配时间范围
- [ ] 视频分析结果缓存：同一视频不重复分析，结果持久化供 Agent 反复查询
- [ ] [可选] 帧精确对齐：Gemini 时间戳 ±1s 窗口内用 PySceneDetect 找精确切点
- [ ] [可选] 编辑建议：基于分析结果建议可优化的点

**为什么第三做：**

- Phase 2 已验证生成链路可行，这里是提升智能程度
- 以调 Gemini API 为主，开发量集中在 prompt engineering 和结果结构化
- 没有这层也能用（手动指定时间范围），有了更智能

### Phase 4：Level 4 多 Agent 系统（4-5 周）

搭建 Master + 5 Sub-agent 架构，让用户用自然语言操控一切。

**具体交付：**

- [ ] Master Agent：基于 Agent SDK，进程内 MCP 注册 dispatch 工具
- [ ] Vision Agent：Gemini 2.5 Pro，独立 loop，3 个视频理解工具
- [ ] Editor Agent：Claude Sonnet 4.6，独立 agentic loop，16 个时间线工具
- [ ] Creator Agent：Claude Sonnet 4.6，独立 loop，5 个生成工具
- [ ] Audio Agent：Claude Sonnet 4.6，独立 loop，6 个音频工具
- [ ] Asset Agent：Claude Haiku 4.5，独立 loop，7 个素材管理工具
- [ ] 并行调度：Master dispatch 多个独立 sub-agent 时用 asyncio.gather
- [ ] Changeset 审批：通过 Agent SDK hooks 拦截编辑操作（propose / approve / reject）
- [ ] Context Synchronizer：读取 Change Log，将 Human 变更注入 Agent 上下文（Lazy Sync）
- [ ] Skill 加载机制：动态读取 skill 描述，注入 sub-agent 的 system prompt
- [ ] Chat UI 面板

**为什么最后做：**

- Agent 是胶水层，底下能力越丰富它越有用
- 前三个 Phase 都可用 CLI / 脚本验证
- Master 的上下文管理由 Agent SDK 提供，不用从零搭建

### Phase 5：资产管理系统（2-3 周）

跨项目的素材和工作流复用能力。

**具体交付：**

- [ ] Skill 存档：保存编辑工作流为可复用模板（节奏、转场、字幕风格等）
- [ ] 素材存档：生成片段带完整生成上下文（prompt + 模型 + 参数），支持追溯和再生成
- [ ] 角色库集成：对接 character-bank，角色素材跨项目复用
- [ ] 品牌资产管理：logo / 配色 / 字体 / 片头片尾模板
- [ ] 项目素材索引：记录每个项目的素材来源和使用情况
- [ ] Agent 可调用：Agent 能搜索素材库（"用上次那个樱花树下的片段"）

**为什么这个阶段做：**

- 核心链路（Phase 1-4）跑通后，复用能力才有意义
- 需要积累一定量的生成素材后，存档才能体现价值
- 对批量生产和品牌一致性场景是关键差异化

---

## 五、与调研报告的关系

本文档基于 [chatcut-research.md](./chatcut-research.md) 的调研结论，做了以下延伸和修正：

| 调研报告结论 | 本文档决策 |
|-------------|-----------|
| OpenCut 依赖了 @ffmpeg/ffmpeg | 经验证代码中零引用，是死代码 |
| Agent 层操控 Command 系统即可 | Command 粒度只覆盖时间线编辑，内容编辑需要新的链路（帧序列 + 生成模型） |
| 推荐 Tauri 做 Native 化 | 维持此结论，但优先级排在 Agent 能力之后 |
| API 分五层设计 | 维持此结论，本文档聚焦 Level 1-4 的技术实现 |

### 与 FireRed-OpenStoryline 的关系

[OpenStoryline](https://github.com/FireRedTeam/FireRed-OpenStoryline) 是一个 AI 视频编辑 Agent，与 ChatCut 方向相似但定位互补：

| 维度 | OpenStoryline | ChatCut |
|------|--------------|---------|
| 强项 | Agent 编排 + MCP + 技能存档 | 完整时间线编辑器 + GUI |
| 弱项 | 无时间线编辑器 GUI | Agent 层从零建 |
| 架构 | DAG 节点管线（workflow 模式） | Multi-agent（agentic 模式） |
| 协议 | 外部 MCP（通用工具平台定位） | Agent SDK + 进程内 MCP（一体化产品） |
| 视频理解 | TransNetV2 盲切 + LLM 逐段理解 | Gemini 一步语义分割 |
| 素材管理 | 无（只有 Skill 存档） | Skill + 素材双存档 |
| 渲染 | MoviePy + FFmpeg（Python） | WebCodecs + Canvas + WebGL（浏览器原生） |

**借鉴点：**
- Skill 存档机制（编辑工作流可复用）
- plan_timeline 的 beat 对齐算法（可移植到 Editor Agent 的 skill 中）
- BaseNode 的依赖管理思路（require_prior_kind）

**差异点：**
- ChatCut 不采用 DAG 编排，而是完全 agentic
- ChatCut 不用外部 MCP，用 Agent SDK 进程内注册
- ChatCut 用 Gemini 替代 TransNetV2 做视频理解
- ChatCut 补齐素材存档能力

---

## 六、待定问题

- [ ] Headless 模式的具体实现方案：Node.js + OffscreenCanvas？还是用 Playwright 驱动？
- [ ] 帧序列提取的格式与分辨率策略：发给生成模型的帧是否需要降分辨率？
- [ ] 生成模型返回的片段与原始视频的画质 / 分辨率 / 帧率对齐策略
- [ ] 内容编辑的 undo 机制：替换后的片段在 Command 系统中如何回滚？
- [ ] 多段内容编辑的一致性：同一对象在不同时间段被修改时如何保持连贯
- [ ] 生成模型的延迟与成本：长视频大量帧序列的处理策略（分批？降采样？）
