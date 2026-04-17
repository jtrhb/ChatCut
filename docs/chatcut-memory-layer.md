# ChatCut Memory Layer 设计文档

基于 [chatcut-architecture.md](./chatcut-architecture.md) 的 Agent 架构和 [chatcut-plan.md](./chatcut-plan.md) 的执行计划，设计 Memory Layer——Agent 系统的持久化认知层。

---

## 一、定位与动机

### 问题

ChatCut 的核心用户是批量生产视频的个人/小团队。Agent 需要在长期合作中积累对用户的理解——审美偏好、质量标准、品牌规范、内容模式——才能做到"越用越好"。

当前 Agent 架构中，每次会话的上下文在 session 结束后丢失。Change Log 记录了"发生了什么"，但没有沉淀"从中学到了什么"。

### Memory Layer 解决什么

- **认知持久化**：Agent 从交互中学到的知识跨 session 保留
- **飞轮效应**：approve/reject/修改 → 提炼记忆 → 下次决策更准 → 用户纠偏更少
- **个性化生产**：同一个 Agent 系统，为不同品牌/系列产出风格一致但互不干扰的内容
- **迁移成本**：用户积累的 memory 是护城河——换工具意味着从零教 AI

### 不是什么

- 不是 RAG 系统——不做向量检索（唯一例外见 §6）
- 不是配置文件——不是静态的 BrandProfile JSON
- 不是 Change Log 的替代——Change Log 记录事实，Memory 记录从事实中提炼的知识
- 不是会话记忆——session 内的短期上下文由 Context Synchronizer 处理

### 核心原则

1. **上下文优先写入** — 存 memory 时保留具体场景上下文（"快节奏段落中偏好硬切"），不急于抽象为通用规则（"偏好硬切"）。泛化交给读取时的 Agent 判断
2. **Master 单点写入** — 只有 Master Agent 有 memory 写入权。Sub-agent 的观察通过返回值上报，由 Master 统一决定是否沉淀。避免多 agent 写入冲突和噪音
3. **对用户透明** — 用户不直接看到/管理 memory 系统。冲突通过自然对话解决，不暴露"memory 管理"概念
4. **批量优先** — 架构围绕批量生产场景设计（一次出 20 条视频），而非单条视频编辑
5. **Memory → Skill 飞轮** — Memory 积累到一定程度后自动结晶为可复用的 Skill。Memory 是隐性知识，Skill 是显性知识

---

## 二、架构概览

```
                    写入路径                              读取路径
                    ────────                              ────────

Change Log ──→ Memory Extractor ──→                   Master Agent 接到任务
(approve/reject/modify 事件)        │                         │
                                    ▼                         ▼
用户显式输入 ──────────────────→ Memory Store          生成 memory 查询脚本
("品牌色是#1A2B3C")                (文件系统)                  │
                                    ▲                         ▼
Pattern Observer ─────────────→    │               Dynamic Worker 执行脚本
(跨 session 模式识别)               │               遍历 memory 文件系统
                                    │               筛选相关记忆片段
                                    │                         │
                                    │                         ▼
                                    │               返回 context payload
                                    │                         │
                                    │                         ▼
                                    │               注入 Sub-agent system prompt
                                    │
                        ┌───────────┴───────────┐
                        │     Memory 文件系统     │
                        │   语义路由 + 渐进式披露  │
                        └────────────────────────┘
```

---

## 三、Memory Store：语义路由文件系统

### 3.1 设计理念

Memory 组织为结构化的文件树，而非向量数据库。Agent 通过**路径语义**导航到相关区域，再读取具体文件。

**为什么不用传统 RAG：**

| 维度 | 向量检索（RAG） | 语义路由文件系统 |
|------|----------------|----------------|
| 可解释性 | 黑盒，不知道为什么匹配到这条 | 路径即语义，可审计 |
| 可调试 | 难以修正检索结果 | 直接编辑/移动/删除文件 |
| 精确控制 | 依赖 embedding 质量 | Agent 写脚本精确控制读取逻辑 |
| 结构化知识 | 扁平化，丢失层级关系 | 天然支持作用域继承 |
| 用户可参与 | 用户看不懂向量 | 用户可以直接浏览/编辑 memory 文件 |

### 3.2 目录结构

以下路径均相对于 R2 bucket 中的 `{user-id}/` 前缀（见 §10.1）。

```
{user-id}/                                 # R2 bucket 中的用户根目录
├── _index.md                              # 顶层索引：目录说明 + 导航指引
├── _schema.md                             # memory 文件格式规范
├── _conflicts/                            # 未解决的冲突标记（见 §7.2）
│
├── global/                                # 用户级（跨所有品牌/项目）
│   ├── _index.md
│   ├── aesthetic/                         # 审美偏好
│   │   ├── pacing.md                      # 节奏偏好
│   │   ├── transitions.md                 # 转场偏好
│   │   ├── color-grading.md               # 调色风格
│   │   ├── composition.md                 # 构图偏好
│   │   └── typography.md                  # 字幕/文字风格
│   ├── quality/                           # 质量标准
│   │   ├── approval-criteria.md           # 什么样的输出会被 approve
│   │   ├── rejection-patterns.md          # 常见 reject 原因
│   │   └── provider-preferences.md        # 生成模型偏好（Kling vs Seedance 等）
│   ├── workflow/                          # 工作流偏好
│   │   ├── review-style.md                # 审批习惯（严格/宽松、批量/逐条）
│   │   ├── communication.md               # 沟通风格（简洁/详细）
│   │   └── batch-preferences.md           # 批量生产偏好（每批数量、优先级）
│   └── technical/                         # 技术偏好
│       ├── export-settings.md             # 导出规格
│       └── tool-preferences.md            # 工具链偏好
│
├── brands/                                # 品牌级
│   ├── {brand-slug}/
│   │   ├── _index.md                      # 品牌概述
│   │   ├── _skills/                       # 品牌级自动结晶 Skill（见 §8）
│   │   ├── identity/                      # 品牌身份
│   │   │   ├── visual.md                  # 视觉规范（配色、字体、logo 用法）
│   │   │   ├── tone.md                    # 内容调性
│   │   │   └── guidelines.md              # 品牌指南要点
│   │   ├── audience/                      # 受众认知
│   │   │   ├── demographics.md            # 受众画像
│   │   │   └── engagement.md              # 什么内容效果好
│   │   ├── platforms/                     # 平台规则
│   │   │   ├── instagram.md
│   │   │   ├── youtube.md
│   │   │   ├── tiktok.md
│   │   │   └── {platform}.md
│   │   └── series/                        # 内容系列
│   │       ├── {series-slug}/
│   │       │   ├── _index.md              # 系列概述
│   │       │   ├── _skills/               # 系列级自动结晶 Skill
│   │       │   ├── style.md               # 系列特有风格（覆盖品牌默认）
│   │       │   ├── structure.md           # 内容结构模板
│   │       │   └── history.md             # 系列演变记录
│   │       └── .../
│   └── .../
│
└── projects/                              # 项目级（短期，项目结束后可归档）
    ├── {project-id}/
    │   ├── _index.md                      # 项目上下文
    │   ├── learned.md                     # 从本项目交互中学到的
    │   └── decisions.md                   # 本项目的关键决策记录
    │   # 注意：素材级 memory（material-notes/）延迟到 Phase 5 资产管理系统
    │   # 引入时需同步添加 materialId 检索上下文和递归加载规则
    └── .../
```

### 3.3 `_index.md` 的作用

每个目录包含一个 `_index.md`，描述：
- 该目录包含什么类型的 memory
- 子目录/文件列表及简要说明
- 何时应该读取该目录

这是**渐进式披露**的核心——Agent 先读 `_index.md`（几十个 token），决定是否需要深入读取子文件（可能几百到几千 token）。

```markdown
# 示例：brands/coffee-lab/_index.md

品牌：Coffee Lab（精品咖啡品牌）
创建时间：2026-02-15
活跃系列：3 个

## 子目录
- identity/ — 品牌视觉规范和调性（核心，每次生产必读）
- audience/ — 受众画像和内容效果数据
- platforms/ — 平台特定规则（按目标平台选读）
- series/ — 内容系列（按当前任务的系列选读）
  - weekly-recipe — 每周咖啡食谱（最活跃，周更）
  - behind-scenes — 幕后故事（月更）
  - product-launch — 新品发布（不定期）
```

### 3.4 Memory 文件格式

每个 memory 文件是 Markdown，带结构化 frontmatter：

```markdown
---
memory_id: mem_a1b2c3d4             # 稳定标识符（UUID 短码），不随路径变化
type: preference | rule | pattern | knowledge | decision
status: draft | active | stale | deprecated    # Memory 状态：draft=隐式待验证, active=已验证生效
# 注意：Skill 草案使用独立的 skill_status 字段（见 §8.2），不复用此 status
confidence: high | medium | low
source: implicit | explicit | observed
created: 2026-03-15
updated: 2026-03-26
reinforced_count: 12                # 被多少次交互验证过
last_reinforced_at: 2026-03-26      # 最近一次被验证的时间
last_used_at: 2026-03-25            # 最近一次被注入 agent prompt 的时间
source_change_ids: [chg_x1, chg_x2] # 产生此 memory 的 Change Log 条目
used_in_changeset_ids: [cs_y1]       # 注入此 memory 后产生的 changeset（用于追踪因果）
created_session_id: sess_abc123      # 创建此 memory 的 session（用于 draft→active 门控）
last_reinforced_session_id: sess_def456  # 最近一次强化发生在哪个 session
scope: global | brand:coffee-lab | platform:instagram | series:weekly-recipe | project:xxx
scope_level: global | brand | platform | series | project    # 归一化层级，用于合并优先级判定
activation_scope:                    # draft memory 的生效范围（status: draft 时**必填**，写入时校验）
  project_id: proj_abc               # 限定在哪个项目（可选，有则匹配）
  batch_id: batch_2026-03-26-001     # 限定在哪个批次（可选，有则匹配）
  session_id: sess_abc123            # 限定在哪个会话（可选，有则匹配）
  # 规则：三个字段至少填一个。匹配逻辑：只检查存在的字段，全部匹配才通过
semantic_key: aesthetic/pacing          # 语义域标识（用于跨作用域 merge 冲突检测）
                                        # 约定：从文件路径派生，如 global/aesthetic/pacing.md → "aesthetic/pacing"
                                        # 同 semantic_key 的 memory 在不同 scope_level 间按优先级覆盖
tags: [pacing, rhythm, editing]
---

# 节奏偏好

## 核心规则
- 单个片段不超过 4 秒（除非是慢镜头特写）
- 每 15 秒至少一次节奏变化（转场、音乐变化、或画面切换）
- 静态画面超过 3 秒必须加动效（Ken Burns 或轻微 zoom）

## 上下文
- 最初从 2026-02-20 的 3 次连续 reject 中提炼（用户把所有 >5s 的静态段都砍了）
- 2026-03-10 用户明确说过"我的观众注意力很短，3 秒没变化就划走了"
- 慢镜头特写是例外——2026-03-15 用户 approve 了一个 6 秒的拉花特写

## 应用方式
Editor Agent 在安排片段时长时参考。Creator Agent 生成内容时控制时长。
```

### 3.5 作用域继承与覆盖

Memory 沿作用域链向下继承，子级可覆盖父级：

```
global/aesthetic/transitions.md        → "偏好硬切"
brands/coffee-lab/identity/visual.md   → （未提及转场，继承 global）
brands/coffee-lab/series/behind-scenes/style.md → "幕后系列用慢溶解转场"
                                                   ↑ 覆盖 global 的硬切偏好
```

Agent 查询脚本需要处理这个继承链。**确定性合并规则：**

```
合并优先级（低→高，后者覆盖前者）：
  1. global/          — 最低优先级，通用默认
  2. brands/{brand}/  — 品牌级覆盖
  3. platforms/{plat}/ — 平台特定规则
  4. series/{series}/  — 系列特定规则
  5. projects/{proj}/  — 项目级（最高优先级）

同一层级内的冲突：
  - confidence: high > medium > low
  - source: explicit > observed > implicit
  - updated 时间更近的优先
  - 有未解决 conflict marker 的 memory 降权但不排除

Skill vs Memory（注意：Skill 使用 skill_status 字段，不是 status）：
  - skill_status: validated 的 Skill 优先级等同于其所在作用域的 memory
  - skill_status: draft 的 Skill 降权（只在无其他 memory 覆盖时生效）
  - skill_status: deprecated 的 Skill 排除，不参与合并

Prompt 序列化顺序（注入 system prompt 时）：
  1. 品牌身份 / 视觉规范（identity/）
  2. 已验证 Skill（_skills/ skill_status: validated）
  2b. [可选] 试用 Skill（_skills/ skill_status: draft，独立 prompt 块，见下）
  3. 审美偏好（aesthetic/）
  4. 平台规则（platforms/）
  5. 质量标准（quality/）
  6. 冲突提示（_conflicts/，用于自然对话解决）
```

---

## 四、Memory 写入：三个来源

### 4.1 隐式提取（Memory Extractor）

挂在 Change Log 上，监听审批事件，自动提炼 memory。

**触发条件：**

| Change Log 事件 | Memory Extractor 行为 |
|-----------------|---------------------|
| `changeset_rejected` | 分析被 reject 的操作，提取"什么不该做" |
| `changeset_committed` + 有人类修改 | 对比 agent 原始提议和最终版本，提取"怎么做更好" |
| `changeset_committed` + 无修改 | 强化已有 memory 的置信度 |

**提取流程：**

```typescript
class MemoryExtractor {
  // 挂在 Change Log 的 subscribe 上
  async onChangesetDecision(event: ChangesetDecisionEntry) {
    const changeset = await this.getChangesetDetails(event.targetId);

    if (event.action.type === "changeset_rejected") {
      // 分析 reject 原因
      const analysis = await this.analyzeRejection(changeset);
      // analysis 包含：被 reject 的操作、可能的原因、建议的 memory
      await this.proposeMemory(analysis);
    }

    if (event.action.type === "changeset_committed") {
      const humanMods = changeset.entries.filter(e => e.source === "human");
      if (humanMods.length > 0) {
        // 对比 agent 原始提议和人类修改后的版本
        const diff = await this.analyzeDiff(changeset);
        await this.proposeMemory(diff);
      } else {
        // 无修改通过——强化相关 memory
        await this.reinforceRelatedMemories(changeset);
      }
    }
  }

  // Memory 提取本身也是 Agent 任务
  // 用 LLM 分析 changeset，生成结构化 memory 提议
  private async analyzeRejection(changeset: Changeset): Promise<MemoryProposal> {
    const response = await claude.messages.create({
      model: "claude-haiku-4-5",  // 轻量模型，控制成本
      system: MEMORY_EXTRACTION_PROMPT,
      messages: [{
        role: "user",
        content: JSON.stringify({
          rejectedOperations: changeset.entries,
          timelineContext: changeset.snapshotBefore,
          existingMemories: await this.getRelatedMemories(changeset),
        })
      }],
    });
    return parseMemoryProposal(response);
  }
}
```

**关键设计：Memory 提取用 Haiku，不用 Opus。** 这是高频操作（每次审批都触发），用轻量模型控制成本。提取出的 memory 如果质量不够，会在后续交互中被自然淘汰（低置信度 + 无强化 → 衰减）。

**混合更新策略（批量生产场景）：**

Memory Extractor 有两种运行模式，根据信号置信度自动选择：

**显式输入的持久性分类（在任何写入之前执行）：**

用户显式说的话并非都是持久偏好。**必须先分类，再决定存储路径。** 分类在即时更新之前执行，确保批次指令永远不进入 R2。

```
用户显式输入
    ↓
  持久性分类（Master Agent 判断）：
    ├── 批次/任务指令（"这批都不要淡入"、"这次用竖版"）
    │     → 不写入 R2 memory，永远不进入即时更新流程
    │     → 存入 Context Synchronizer 的 task state（session 结束即失效）
    │     → 通过批次 snapshot 传递给当前批次的所有视频
    │
    └── 持久偏好（"我们品牌色是 #1A2B3C"、"字幕永远不要遮人脸"）
          → 进入即时更新流程（见下方）
```

**分类信号：**
- 包含"这次"/"这批"/"今天"等时间限定词 → 批次指令
- 包含"永远"/"以后"/"所有"等持久限定词 → 持久偏好
- 不确定时 → Master Agent 自然地追问："这个是只限这次，还是以后都这样？"

```
即时更新（高置信度信号）——立即持久化，但 status 取决于 source：
├── 经持久性分类确认的显式持久偏好（"字幕永远不要遮人脸"）
│     → source: explicit, status: active → 立即写入 R2 + 追加到 snapshot
│     → 唯一可以直接 active 的路径
├── 用户连续 reject 同类问题（3+ 次同类型 reject）
│     → source: implicit, status: draft → 立即写入但仅 activation_scope 内生效
│     → 写入时必须携带 activation_scope（至少一个作用域标识，缺失则拒绝写入）
└── 用户主动修改了 Agent 的核心决策（如整体风格调整）
      → source: implicit, status: draft → 立即写入但仅 activation_scope 内生效
      → 写入时必须携带 activation_scope（至少一个作用域标识）

**安全约束：即时持久化 ≠ 即时激活。**
- source: explicit + 持久性分类通过 → status: active（用户亲口说的持久偏好，无需验证）
- source: implicit → status: draft（无论置信度多高，首次创建必须是 draft）
- status: draft 写入时**必须**携带 activation_scope（至少一个作用域标识：project_id/batch_id/session_id），缺失则拒绝写入
- draft memory 只在 activation_scope 匹配时生效
- draft → active 提升要求**跨 session** 强化（见下方 session 门控规则）

**Session 门控规则（防止同 session 内 draft 提升为 active）：**
- 每条 draft memory 创建时记录 `created_session_id`
- 同一 session 内的 approve/强化只提升 `confidence`（low → medium → high），不改变 `status`
- `status: draft → active` 要求 `last_reinforced_session_id !== created_session_id`
- 即：至少在另一个 session 中被再次验证

汇总更新（低置信度信号）：
├── 单次 approve/reject（可能是随机偏好，也可能是趋势）
├── 微调（改了个参数值，不确定是通用偏好还是个案）
└── 隐含模式（需要多次数据才能判断）
    → 积攒到批次结束
    → 批次结束后 Pattern Observer 汇总分析
    → 提炼出有统计支撑的 memory 再写入 R2
```

```typescript
class MemoryExtractor {
  // 实时模式：高置信度信号立即写入
  async onChangesetDecision(event: ChangesetDecisionEntry) {
    const signal = this.classifySignal(event);

    if (signal.confidence === "high") {
      await this.writeMemoryImmediate(signal);
      this.batchSnapshot?.append(signal.memory);
    } else {
      this.pendingSignals.push(signal);  // 积攒到批次结束
    }
  }

  // 批次模式：批次结束后汇总分析
  async onBatchComplete(batchId: string) {
    const signals = this.pendingSignals.filter(s => s.batchId === batchId);
    if (signals.length === 0) return;
    const analysis = await this.analyzeSignalBatch(signals);  // LLM 汇总
    // 汇总分析产出的 memory 使用 source: observed, status: active
    // 汇总分析本身就是跨多次交互的统计结果，不走 draft 路径
    for (const memory of analysis.proposedMemories) {
      memory.source = "observed";
      memory.status = "active";
      memory.confidence = "medium";
      await this.writeMemory(memory);
    }
    this.pendingSignals = this.pendingSignals.filter(s => s.batchId !== batchId);
  }

  // 非批量场景：session 结束后汇总分析
  // 注意：只处理没有 batchId 的信号（有 batchId 的由 onBatchComplete 处理）
  async onSessionComplete(sessionId: string) {
    const signals = this.pendingSignals.filter(s =>
      s.sessionId === sessionId && !s.batchId  // 排除属于 batch 的信号
    );
    if (signals.length === 0) return;
    const analysis = await this.analyzeSignalBatch(signals);
    // 汇总分析产出的 memory 使用 source: observed, status: active
    // （不走 draft 路径——汇总分析本身就是跨多次交互的统计结果，已有足够证据）
    for (const memory of analysis.proposedMemories) {
      memory.source = "observed";
      memory.status = "active";
      memory.confidence = "medium";
      // scope 从分析结果中派生（如果所有信号都来自同一品牌 → brand scope）
      await this.writeMemory(memory);
    }
    this.pendingSignals = this.pendingSignals.filter(s =>
      !(s.sessionId === sessionId && !s.batchId)
    );
  }
}
```

### 4.2 显式输入

用户通过 Chat UI 直接告诉 Agent 的信息。

```
用户："记住，我们品牌的视频片头固定用 3 秒的 logo 动画"
  ↓
Master Agent 识别为 memory 写入意图
  ↓
写入 brands/{brand}/identity/visual.md
  ↓
confidence: high, source: explicit
```

显式输入直接写入，不需要置信度积累。

### 4.3 模式观察（Pattern Observer）

跨 session 分析，发现用户自己可能没意识到的模式。

**触发方式：** 不实时运行。在以下时机触发：

- 每 N 个 session 结束后（如每 10 个 session）
- 用户手动触发（"分析一下我的编辑习惯"）
- 批量生产完成后的回顾

**观察维度：**

```
统计型模式：
  - "最近 20 次生成，Seedance 的通过率 78%，Kling 只有 45%"
  - "用户平均每条视频修改 3.2 次才 approve"
  - "背景音量被手动调整过 15 次，中位数目标值 28%"

行为型模式：
  - "用户总是在周五批量审批，周一到周四很少操作"
  - "超过 60 秒的视频 reject 率显著高于短视频"
  - "用户倾向先审批视觉，最后才调音频"
```

---

## 五、Memory 读取：Agent 脚本查询

### 5.1 渐进式披露流程

```
Master Agent 接到任务：
  "给 Coffee Lab 的 weekly-recipe 系列做 5 条 Instagram Reels"
          │
          ▼
Step 1: 读顶层 _index.md（了解 memory 有哪些区域）
          │
          ▼
Step 2: 生成查询脚本
  "我需要：global 审美偏好 + Coffee Lab 品牌规范 +
   weekly-recipe 系列风格 + Instagram 平台规则"
          │
          ▼
Step 3: Dynamic Worker 执行脚本
  遍历文件系统，按作用域继承规则合并 memory
  返回精简的 context payload
          │
          ▼
Step 4: 注入 Sub-agent system prompt
```

### 5.2 查询脚本示例

Agent 生成的 JS 脚本，在 Dynamic Worker 中执行：

```javascript
// Agent 生成的 memory 查询脚本
// Dynamic Worker bindings: { memoryFS, task }

const task = bindings.task;
// task = { brand: "coffee-lab", series: "weekly-recipe", platform: "instagram", type: "batch-reels" }

const fs = bindings.memoryFS;
const memories = [];

// 辅助函数：加载目录下所有 memory 文件（排除 _index.md 和子目录）
async function loadDir(dir, fallbackLevel) {
  const entries = await fs.readDir(dir);
  const results = [];
  for (const entry of entries) {
    if (entry.name === "_index.md") continue;
    if (entry.isDirectory) continue;  // 不递归进子目录（如 _skills/），需要显式加载
    const parsed = await fs.readParsed(entry.path);
    parsed.scope_level = parsed.scope_level || fallbackLevel;
    results.push(parsed);
  }
  return results;
}

// 1. 加载 global 审美偏好 + 质量标准（始终需要）
memories.push(...await loadDir("global/aesthetic/", "global"));
memories.push(...await loadDir("global/quality/", "global"));

// 2. 加载品牌身份（始终需要）
memories.push(...await loadDir(`brands/${task.brand}/identity/`, "brand"));

// 3. 加载品牌级 Skills（如果有）
const brandSkillsDir = `brands/${task.brand}/_skills/`;
if (await fs.exists(brandSkillsDir)) {
  memories.push(...await loadDir(brandSkillsDir, "brand"));
}

// 4. 加载平台规则（按目标平台选读）
const platformFile = `brands/${task.brand}/platforms/${task.platform}.md`;
if (await fs.exists(platformFile)) {
  const parsed = await fs.readParsed(platformFile);
  parsed.scope_level = parsed.scope_level || "platform";
  memories.push(parsed);
}

// 5. 加载系列风格 + 系列级 Skills（如果有）
const seriesDir = `brands/${task.brand}/series/${task.series}/`;
if (await fs.exists(seriesDir)) {
  memories.push(...await loadDir(seriesDir, "series"));
  // 系列级 Skills
  const seriesSkillsDir = `${seriesDir}_skills/`;
  if (await fs.exists(seriesSkillsDir)) {
    memories.push(...await loadDir(seriesSkillsDir, "series"));
  }
}

// 6. 加载未解决的冲突标记（用于自然对话解决）
if (await fs.exists("_conflicts/")) {
  memories.push(...await loadDir("_conflicts/", "global"));
}

// 6. 加载项目级 memory（如果有 projectId）
if (task.projectId) {
  const projectDir = `projects/${task.projectId}/`;
  if (await fs.exists(projectDir)) {
    memories.push(...await loadDir(projectDir, "project"));
  }
}

// === Dynamic Worker 到此结束，返回原始候选列表 ===
// 后续 filter/merge/truncate/serialize 由共享 post-load 管线执行（见 §5.4）
return {
  candidates: memories,
  scopeChain: ["global", "brand", "platform", "series", ...(task.projectId ? ["project"] : [])],
};
```

### 5.3 为什么用 Dynamic Worker 执行

| 需求 | Dynamic Worker 的优势 |
|------|---------------------|
| Agent 生成的查询脚本不可信 | 沙箱隔离，不能访问 DB/网络 |
| 查询逻辑可能很复杂（条件过滤、合并、裁剪） | 完整 JS 运行时 |
| 不同任务需要不同的查询策略 | 每次生成不同脚本 |
| 需要快速执行 | V8 isolate 毫秒级启动 |
| Memory 文件系统是纯文本 | 不需要浏览器 API |

**binding 设计：**

```typescript
// Dynamic Worker 只暴露受控的文件系统 API
const bindings = {
  memoryFS: {
    readDir(path: string): Promise<FileEntry[]>,     // 列目录
    readFile(path: string): Promise<string>,          // 读文件原文
    readParsed(path: string): Promise<ParsedMemory>,  // 读文件并解析 frontmatter
    exists(path: string): Promise<boolean>,           // 检查路径存在
    search(query: string): Promise<FileEntry[]>,      // 按文件名/标签搜索
    // 注意：没有 write——查询脚本只读
  },
  task: TaskContext,  // 当前任务的上下文信息
};
```

### 5.4 查询模板 + 自定义脚本混合

大部分场景不需要每次都生成自定义查询脚本（浪费 token）。采用预定义模板覆盖常见任务类型，只在复杂场景才走 Dynamic Worker：

```typescript
// 预定义查询模板（覆盖 ~80% 场景）
const QUERY_TEMPLATES = {
  // TaskContext 必填字段：brand, platform, agentType
  // 可选字段：series, projectId, batchId（批量生产时必填）
  // 注意：memory 加载按 agentType 独立执行（Master/Editor/Creator 各自加载一次，
  //        确保 agent_type 过滤正确且 Skill 不会注入到错误的 agent）

  "batch-production": (params: { brand: string; series?: string; platform: string; projectId?: string; agentType: string; batchId?: string }) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${params.brand}/identity/*`,
    `brands/${params.brand}/platforms/${params.platform}.md`,
    `brands/${params.brand}/_skills/*`,                                              // 品牌级 Skills
    ...(params.series ? [
      `brands/${params.brand}/series/${params.series}/*`,                            // 系列 memory
      `brands/${params.brand}/series/${params.series}/_skills/*`,                     // 系列级 Skills
    ] : []),
    ...(params.projectId ? [`projects/${params.projectId}/*`] : []),                  // 项目级（最高优先级）
    "_conflicts/*",                                                                   // 未解决的冲突
  ],

  "single-edit": (params: { brand: string; projectId: string }) => [
    "global/aesthetic/*",
    "global/quality/approval-criteria.md",
    `brands/${params.brand}/identity/*`,
    `projects/${params.projectId}/*`,
  ],

  "new-brand-onboarding": (params: {}) => [
    "global/**/*",          // 递归加载所有 global memory
  ],

  "style-exploration": (params: { brand: string }) => [
    "global/**/*",          // 递归加载所有 global memory
    `brands/${params.brand}/**/*`,  // 递归加载品牌下所有 memory + skills
  ],
};
```

**Master Agent 流程：**

```
1. 判断任务类型 → 匹配模板
2. 填入参数（brand, series, platform, projectId 等）
3. 模板生成查询路径列表
4. Agent 服务从 R2 批量读取
5. ──→ 进入共享 post-load 管线（见下方）
6. 如果模板不够（跨品牌对比、条件过滤等复杂场景）
   → Master 生成自定义 JS 脚本 → Dynamic Worker 执行
   → Dynamic Worker 返回的结果也进入同一 post-load 管线
```

**共享 post-load 管线（模板和 Dynamic Worker 共用）：**

无论通过模板路径还是 Dynamic Worker 获取的候选列表，都进入同一个管线处理：

```typescript
function postLoadPipeline(candidates: ParsedMemory[], task: TaskContext): MemoryContext {
  // Step 1: 分类 — 三种候选类型分别处理
  const conflicts = candidates.filter(m => m.type === "conflict-marker" && m.status === "unresolved");
  const skills = candidates.filter(m => m.type === "skill-draft");
  const memories = candidates.filter(m => m.type !== "conflict-marker" && m.type !== "skill-draft");

  // Step 1a: 过滤 Skills — 按 skill_status + agent_type
  const filteredSkills = skills.filter(s => {
    if (s.skill_status === "deprecated") return false;
    if (s.agent_type && s.agent_type !== task.agentType) return false;  // 只加载匹配当前 agent 的 Skill
    return true;
  });

  // Step 1b: 过滤 Memories — 按 status + activation_scope
  const filteredMemories = memories.filter(m => {
    if (m.status === "stale" || m.status === "deprecated") return false;
    if (m.status === "draft") {
      // activation_scope 是 draft 的必填字段，缺失则排除
      const scope = m.activation_scope;
      if (!scope) return false;
      // 至少一个作用域标识
      if (!scope.project_id && !scope.batch_id && !scope.session_id) return false;
      // 只检查存在的字段，全部匹配才通过
      if (scope.project_id && scope.project_id !== task.projectId) return false;
      if (scope.batch_id && scope.batch_id !== task.batchId) return false;
      if (scope.session_id && scope.session_id !== task.sessionId) return false;
    }
    // 注意：不做额外的 confidence+时间 过滤
    // 低置信度 memory 的衰减由 §7.3 的后台衰减任务统一管理
    // 查询时只检查 status，不重复判定 confidence+时间
    return true;
  });

  // Step 1c: 冲突标记 — 只保留与当前候选集相关的冲突
  const relevantConflicts = conflicts.filter(c => {
    // 只保留 target_memory_id 在当前候选集中存在的冲突
    const targetExists = filteredMemories.some(m => m.memory_id === c.target_memory_id);
    if (!targetExists) return false;
    // 或 target_scope_ref 匹配当前任务作用域
    // （防止加载不相关品牌/系列的冲突）
    return true;
  });
  for (const c of relevantConflicts) {
    const target = filteredMemories.find(m => m.memory_id === c.target_memory_id);
    if (target) target._conflicted = true;  // merge 时降权但不排除
  }

  const filtered = [...filteredMemories, ...filteredSkills];

  // Step 2: 合并 — 先按 semantic_key 分组，再按 scope_level 优先级解决覆盖
  // 同一 semantic_key 的 memory 在不同 scope_level 间按优先级覆盖（子级覆盖父级）
  // 不同 semantic_key 的 memory 互不影响，各自独立保留
  const SCOPE_PRECEDENCE = ["global", "brand", "platform", "series", "project"];
  // Skill 优先级权重：validated=0（正常）, draft=1（降权）
  // 降权含义：同 scope_level 内存在 validated skill 或 active memory 时，draft skill 被覆盖
  // 仅当该 scope_level + tag 组合无其他覆盖时，draft skill 才保留
  const SKILL_PRIORITY = { validated: 0, draft: 1 };
  const merged = mergeByScope(filtered, SCOPE_PRECEDENCE, {
    skillPriority: SKILL_PRIORITY,
    // Skill 与 Memory 的 merge key：Skill 的 applies_to 与 Memory 的 tags 做交集匹配
    // 如果 validated Skill 的 applies_to 完全覆盖某 draft Skill，draft 被 shadow
    // 同层级冲突排序: confidence(high>med>low) > source(explicit>observed>implicit) > updated
  });

  // Step 3: 分离 draft Skills → 独立 trial 块
  const { mainEntries, trialSkills } = separateTrialSkills(merged);
  // trialSkills = skill_status: draft 的 Skill，不与 validated Skill/memory 混排
  // 注入方式：主 prompt 末尾追加独立 "Trial Skill" 块，明确标注为"试用，效果待验证"
  // Token 预算：trialSkills 最多占总预算的 10%（如 400 token）

  // Step 4: Token 预算裁剪（三部分共享总预算）
  const totalBudget = task.tokenBudget || 4000;
  const conflictBudget = Math.min(relevantConflicts.length * 100, Math.floor(totalBudget * 0.05));  // 最多 5%
  const trialBudget = Math.floor((totalBudget - conflictBudget) * 0.1);                              // 主体的 10%
  const mainBudget = totalBudget - conflictBudget - trialBudget;                                      // 剩余给主体
  const budgetedMain = fitTokenBudget(mainEntries, mainBudget);
  const budgetedTrial = fitTokenBudget(trialSkills, trialBudget);
  const budgetedConflicts = fitTokenBudget(relevantConflicts, conflictBudget);

  // Step 5: Prompt 序列化（按 §3.5 定义的顺序 + trial 块 + 冲突提示块）
  return serializeForPrompt(budgetedMain, budgetedTrial, budgetedConflicts);
}
```

**共享候选加载契约（模板和 Dynamic Worker 共用）：**

无论模板还是 Dynamic Worker，加载文件时都执行相同的规范化：

```typescript
// 模板路径展开 + 规范化（Agent 服务实现，Phase 初期无需 Dynamic Worker）
async function loadCandidatesFromTemplate(
  paths: string[], r2: R2Client, userPrefix: string
): Promise<ParsedMemory[]> {
  const candidates = [];
  for (const pattern of paths) {
    // 路径展开：
    //   "global/aesthetic/*"       → r2.list(prefix: "global/aesthetic/", delimiter: "/")  单层
    //   "global/**/*"              → r2.list(prefix: "global/")  递归（无 delimiter）
    //   "brands/x/platforms/y.md"  → r2.get() 单文件
    const files = await expandPattern(`${userPrefix}/${pattern}`, r2);
    // expandPattern 内部：
    //   含 "**" → r2.list(prefix, 无 delimiter) 递归列出所有文件
    //   含 "*"  → r2.list(prefix, delimiter="/") 单层列出
    //   无通配符 → r2.get() 直接读取单文件

    for (const file of files) {
      if (file.key.endsWith("/_index.md")) continue;     // 跳过索引
      if (file.key.endsWith("/")) continue;                // 跳过目录标记
      const parsed = await r2.getParsed(file.key);
      // 从路径推断 scope_level（如果 frontmatter 未指定）
      if (!parsed.scope_level) {
        parsed.scope_level = inferScopeLevel(file.key);
        // inferScopeLevel: "global/..." → "global", "brands/x/..." → "brand",
        //   "brands/x/platforms/..." → "platform", "brands/x/series/..." → "series",
        //   "projects/..." → "project"
      }
      candidates.push(parsed);
    }
  }
  return candidates;  // 进入 postLoadPipeline
}
```

Phase 初期只用模板 + `loadCandidatesFromTemplate`，后期加入 Dynamic Worker 自定义脚本。两者返回的候选列表都进入同一 `postLoadPipeline`，切换无成本。

---

## 六、多模态 Embedding：视频语义搜索（唯一的向量检索场景）

### 6.1 场景

当用户/Agent 需要**用视频搜视频**时，文件系统的文本路由无法满足：

- "找一条跟这个风格类似的我之前做过的视频"
- "这个参考视频的节奏，在我的作品里有没有类似的"
- Agent 自动发现"这条新视频的风格跟之前某条很像，可以复用那次的编辑策略"

### 6.2 技术方案

使用 Google 的多模态 embedding 模型，将视频直接 embed 为向量，支持跨模态搜索：

```
视频 → 多模态 embedding → 向量
文本 → 多模态 embedding → 向量
图片 → 多模态 embedding → 向量

查询：视频/文本/图片 → embedding → 在视频向量库中检索最近邻
```

### 6.3 存储

以下路径相对于 R2 bucket `chatcut-memory/{user-id}/`：

```
{user-id}/
└── _vectors/                          # 向量索引（不在语义文件系统中暴露）
    ├── video-embeddings.index         # 向量索引文件
    └── video-metadata.json            # 向量 → 视频资产的映射
```

向量索引独立于语义文件系统——文件系统是 Agent 的主要读取路径，向量只在"视频搜视频"这个特定场景下使用。

### 6.4 集成点

```
用户/Agent 发起视频相似性搜索
        ↓
Vision Agent 调用 search_similar_videos tool
        ↓
多模态 embedding → 向量检索 → 返回相似视频列表
        ↓
Agent 读取这些视频关联的 memory（编辑决策、风格笔记等）
        ↓
复用历史经验
```

### 6.5 不早期引入的原因

- 需要额外的向量数据库基础设施
- 多模态 embedding API 成本较高
- 文件系统路由能覆盖 90% 的 memory 读取场景
- 建议在 Phase 5（资产管理系统）中引入

---

## 七、Memory 生命周期

### 7.1 状态流转

**两条创建路径：**

```
显式创建（用户亲口说的持久偏好，经过持久性分类）：
  → status: active, confidence: high, source: explicit
  → 无需验证，直接生效
  注意：批次/任务指令不走此路径，存入 task state（见 §4.1 持久性分类）

隐式创建（从交互中提取的）：
  → status: draft, confidence: low, source: implicit
  → 需要跨 session 强化才能变为 active
```

**后续生命周期（两条路径合流）：**

```
status: active（无论来源）
  │
  ├── 被后续交互验证 → 强化（confidence: medium → high）
  │                     reinforced_count +1, last_reinforced_at 更新

status: draft（仅 source: implicit）
  │
  ├── 同 session 内被验证 → 只提升 confidence（low → medium → high），不改 status
  │                          reinforced_count +1, last_reinforced_at 更新
  │                          last_reinforced_session_id 更新（但 == created_session_id，不触发提升）
  │
  ├── 跨 session 被验证（last_reinforced_session_id ≠ created_session_id）
  │     → status: draft → active + confidence 提升
  │     → reinforced_count +1, last_reinforced_at 更新
  │
  ├── 与新交互矛盾 → 冲突处理（见 §7.2）
  │
  ├── 长期无验证 → 衰减（confidence 降级）
  │                 不删除，降低在查询中的权重
  │
  └── 用户主动否定 → 标记删除或归档
      "别再用硬切了" → transitions.md 更新
```

### 7.2 冲突处理

当新交互与已有 memory 矛盾时：

**场景示例：**
- 已有 memory："偏好硬切转场"（confidence: high, reinforced_count: 12）
- 新交互：用户连续 3 次把硬切改成了溶解转场

**处理策略：自然融入对话（不暴露 memory 系统的存在）**

```
1. 检测冲突
   Memory Extractor 发现新信号与已有 memory 矛盾
       ↓
   不直接更新 memory
       ↓
   创建 conflict marker 存入 _conflicts/（相对于 {user-id}/ 前缀）：

   Conflict marker 文件格式（type: conflict-marker）：
   ```yaml
   type: conflict-marker
   conflict_id: conf_x1y2z3
   target_memory_id: mem_a1b2c3d4       # 被冲突的已有 memory
   target_scope_level: global            # 被冲突 memory 的作用域层级
   target_scope_ref: global              # 被冲突 memory 的具体作用域
   new_signal_summary: "最近 3 次将转场从硬切改为溶解"
   status: unresolved | resolved
   created: 2026-03-26
   resolved_at: null
   ```

2. Agent 下次决策时
   查询脚本发现有未解决的 conflict marker
       ↓
   Master Agent 在合适时机自然地提问：

   ✗ 不说："我的记忆库里有冲突，你偏好硬切还是溶解？"
   ✓ 说："我注意到你最近几个视频都用了溶解转场，
          之前你好像更喜欢硬切。这个系列用溶解更合适对吧？"

3. 用户回应后
   ├── "对，这个系列用溶解" → 在 series 作用域新建 memory，global 不动
   ├── "对，我现在都喜欢溶解了" → 更新 global memory
   └── "没有，硬切就行" → 丢弃新信号，强化原 memory
       ↓
   清除 conflict marker
```

**关键：用户感受到的是"AI 在认真了解我的偏好"，而不是"系统在管理配置项"。**

### 7.3 衰减规则

```
每 30 天（或每 N 个 session）运行一次衰减检查：

confidence: high + last_reinforced_at > 30 天前 → 降为 medium
confidence: medium + last_reinforced_at > 60 天前 → 降为 low
confidence: low + last_reinforced_at > 90 天前 → status: stale（查询时默认排除）

source: explicit 的 memory 不衰减（用户明确说的，除非用户明确否定）
status: draft 的 memory 如果 30 天未被强化为 active → status: deprecated
```

---

## 八、Memory → Skill 自动结晶

### 8.1 机制

Memory 积累到一定程度后，Pattern Observer 自动将反复验证的偏好模式结晶为可复用的 Skill（编辑工作流模板）。

```
Memory 积累（多条 high confidence memory + 标签交集）
    ↓
Pattern Observer 定期扫描（每 N 个 session 或批次结束后）
    ↓
发现可结构化的模式（如"这个系列的视频结构总是相似的"）
    ↓
自动生成 Skill 草案
    ↓
存入 brands/{brand}/series/{series}/_skills/ 或 brands/{brand}/_skills/
    ↓
后续生产中 Agent 尝试使用草案 Skill
    ↓
用户 approve → Skill 正式生效（skill_status: validated）
用户 reject/修改 → 更新草案或废弃（skill_status: deprecated）
```

### 8.2 Skill 草案格式

```markdown
---
type: skill-draft
skill_id: skill_f1g2h3                          # 稳定标识符
skill_status: draft | validated | deprecated    # 独立于 memory 的 status 字段，避免混淆
agent_type: editor | creator | audio | vision | asset | master  # 权威枚举（与架构文档 §3.1 一致）
applies_to: [pacing, transitions, structure]    # 覆盖范围标签（merge key）
scope_level: brand | series                     # 归一化层级（与 memory 的 scope_level 一致，用于 merge）
scope_ref: brand:coffee-lab | series:weekly-recipe  # Skill 归属的具体作用域
usage_count: 0                                  # 被使用的总次数（含 draft 试用）
created: 2026-03-26
source_memories:
  - global/aesthetic/pacing.md
  - brands/coffee-lab/series/weekly-recipe/style.md
  - brands/coffee-lab/identity/visual.md
validated_count: 0     # 被成功使用并 approve 的次数
---

# Skill: Coffee Lab 周更食谱视频

## 结构模板
1. Hook（0-3s）：成品特写 + 标题文字
2. 食材展示（3-8s）：俯拍 + 逐个标注
3. 制作过程（8-25s）：3-4 个步骤，每步 4-5s
4. 成品展示（25-28s）：慢镜头 + 环绕
5. CTA（28-30s）：品牌 logo + "关注获取更多"

## 风格规则
- 转场：步骤间用硬切，成品展示前用慢溶解
- 配乐：轻快原声吉他，音量 25%
- 字幕：Noto Sans SC Bold，白字 + 半透明黑底
- 调色：暖色调，高饱和

## 来源
从 12 次 weekly-recipe 生产的 memory 中提炼
```

### 8.3 结晶触发条件

- 同一作用域下有 5+ 条 `confidence: high` 的 memory 且标签有交集
- 或同一系列连续 3+ 批次的生产模式高度相似（由 Pattern Observer 检测）

### 8.4 与架构文档 §2.9 Skill 存档的关系

架构文档中的 Skill 存档是手动保存的编辑工作流。Memory Layer 的自动结晶是同一概念的自动化实现——Memory 是隐性知识（分散在多个文件中的偏好），Skill 是显性知识（结构化的可复用模板）。

**Skill Store 桥接：** Memory 文件系统中的 `_skills/` 是自动结晶 Skill 的**唯一源**。Phase 5 的 `SkillStore` / `loadSkills()` API 直接从 R2 的 `_skills/` 路径加载，不另建数据库。具体地：

```
R2: chatcut-memory/{user-id}/brands/{brand}/_skills/*.md  ← 唯一存储
                    ↓
SkillStore.loadSkills(agentType, { brand?, series? })  ← 读取 R2，按 skill_status + agent_type 过滤
                    ↓
Agent 使用：skill_status: validated 的 → 正常使用
            skill_status: draft 的   → 低优先级试用
```

手动保存的 Skill 也存入同一路径，格式一致，`source_memories` 字段为空（非自动结晶）。这确保所有 Skill 通过统一的 `SkillStore` API 加载，无需双数据源同步。

**跨文档权威性声明：** 本文档是 Skill 存储和加载的**唯一权威设计**。`chatcut-plan.md` 中的 SkillStore 相关描述应以本文档为准。具体变更：

| 维度 | chatcut-plan.md 原设计 | 本文档权威设计 |
|------|----------------------|---------------|
| 存储 | 数据库 | R2 `_skills/` 路径 |
| API | `loadSkills(agentType)` | `loadSkills(agentType, { brand?, series? })` |
| Schema | 简单 | 完整 frontmatter（`skill_id`, `skill_status`, `agent_type`, `scope_level`, `scope_ref`, `applies_to`, `usage_count`） |
| agent_type | editor/creator/audio/asset | editor/creator/audio/asset/vision/**master** |

`chatcut-plan.md` Phase 5 章节需同步更新以上变更。在 Phase 5 实施前，由实施者在开始前对齐两份文档。

---

## 九、与现有架构的集成

### 9.1 与 Change Log 的关系

```
Change Log（Phase 1）              Memory Layer
──────────────────                 ────────────
记录"发生了什么"                     记录"从中学到了什么"
append-only 事件流                  可更新的知识文件
所有变更的完整日志                    提炼后的认知精华
短期参考（Context Sync）             长期积累（跨 session）
```

Memory Extractor 订阅 Change Log，但不修改 Change Log。两者独立存储、独立生命周期。

### 9.2 与 Context Synchronizer 的关系

```
Context Synchronizer（Phase 4）    Memory Layer
───────────────────────────        ────────────
同步"这次 session 里发生了什么"       提供"历史上积累的知识"
读 Change Log 的 recent entries     读 memory 文件系统
注入 messages（短期上下文）           注入 system prompt（长期认知）
每次 Agent 调用都触发                 每次新任务开始时触发
```

两者在 Agent 的 prompt 中占据不同位置：

```
System Prompt:
  ├── 角色定义（固定）
  ├── Tool schema（固定）
  ├── Memory context（从 memory 文件系统加载）  ← Memory Layer
  └── 当前时间线状态

Messages:
  ├── Context update（最近的 human 变更）        ← Context Synchronizer
  └── 用户的新请求
```

### 9.3 与 Changeset Manager 的关系

```
Changeset Manager（Phase 4）       Memory Layer
────────────────────────           ────────────
propose() → 执行                    无交互
approve() → 提交                    触发 Memory Extractor（强化/无修改通过）
reject() → 回滚                    触发 Memory Extractor（提取 reject 原因）
approveWithMods() → 修改后提交       触发 Memory Extractor（对比原始 vs 修改后）
```

### 9.4 与 Master Agent 的关系（唯一 Memory 写入者）

Master Agent 是 Memory Layer 的主要消费者：

```typescript
// Master Agent 接到新任务时
async function handleUserRequest(request: string, taskContext: TaskContext) {
  // 1. 加载 Master Agent 的 memory 和 skill
  //    注意：每个 agent 独立加载（agentType 不同 → skill 过滤不同）
  const masterContext = await loadMemories(taskContext, "master");

  // 2. 构建 system prompt（含 memory）
  const systemPrompt = buildSystemPrompt({
    role: MASTER_AGENT_ROLE,
    tools: masterTools,
    memory: masterContext.promptText,  // ← Memory Layer 提供
    timelineState: currentState,
  });

  // 3. 构建 messages（含 Context Sync）
  const contextUpdate = contextSynchronizer.buildContextUpdate(agentId);
  const messages = [
    ...(contextUpdate ? [{ role: "user", content: contextUpdate }] : []),
    { role: "user", content: request },
  ];

  // 4. Agent 执行
  const response = await agentSDK.run({ system: systemPrompt, messages });

  // 5. 如果产生 changeset，将注入的 ID 列表持久化到 changeset 上
  //    每个 sub-agent dispatch 时也独立调用 loadMemories(ctx, agentType)
  //    并将各自的 injectedMemoryIds/injectedSkillIds 追加到 changeset
  //    → approve 时用于 reinforceRelatedMemories() 和更新 Skill usage_count/validated_count
  //    → reject 时用于分析哪些 memory/skill 导致了错误决策
  if (response.changeset) {
    response.changeset.injectedMemoryIds = masterContext.injectedMemoryIds;
    response.changeset.injectedSkillIds = masterContext.injectedSkillIds;
    // Sub-agent dispatch 时追加各自的 IDs:
    // editorContext = await loadMemories(ctx, "editor");
    // changeset.injectedMemoryIds.push(...editorContext.injectedMemoryIds);
    // changeset.injectedSkillIds.push(...editorContext.injectedSkillIds);

    // Skill 归因精细化：Agent 在 tool call 响应中标注实际使用了哪些 Skill
    // （通过 response 中的 skill_applied 标记，而非仅靠注入列表）
    // approve 时只 promote 实际被 applied 的 Skill，不盲目 promote 所有注入的 Skill
    response.changeset.appliedSkillIds = response.appliedSkillIds || [];
  }
}
```

### 9.5 数据流全景

```
用户通过 Chat UI 发出请求
        │
        ▼
Master Agent
  ├── 读 Memory（通过 Dynamic Worker 脚本查询）
  ├── 读 Context Sync（Change Log 近期事件）
  ├── 读 Timeline State（当前项目状态）
  │
  ├── 决策 + 调度 Sub-agents
  │     ├── Sub-agent 的 system prompt 中注入相关 memory
  │     └── Sub-agent 执行 tool calls
  │
  ├── propose() → Changeset Manager
  │
  └── 用户审批
        ├── approve → Change Log 记录 → Memory Extractor 强化
        ├── reject  → Change Log 记录 → Memory Extractor 提取教训
        └── modify  → Change Log 记录 → Memory Extractor 对比学习
```

---

## 十、存储实现

### 10.1 纯 R2 对象存储

Memory 文件全部存储在 R2（与 ChatCut 的媒体文件同一基础设施），`_index.md` 即索引，无需额外数据库。

```
R2 bucket: chatcut-memory
└── {user-id}/
    ├── _index.md
    ├── _conflicts/                # 未解决的冲突标记
    ├── global/
    │   ├── _index.md
    │   ├── aesthetic/...
    │   ├── quality/...
    │   └── ...
    ├── brands/
    │   └── {brand-slug}/
    │       ├── _index.md
    │       ├── _skills/           # 自动结晶的 Skill 草案
    │       ├── identity/...
    │       └── series/
    │           └── {series}/
    │               ├── _skills/   # 系列级 Skill 草案
    │               └── ...
    └── projects/...

写入：Master Agent → Agent 服务 → R2 PutObject
读取：
  常规场景 → 查询模板生成路径列表 → Agent 服务批量 R2 GetObject
  复杂场景 → Dynamic Worker + R2 binding → 直接读取（同数据中心零网络延迟）
```

**写入一致性模型：**

Memory 写入只有一个入口——Master Agent（通过 Agent 服务）。但多个会话（不同项目）可能并发，衰减后台任务也可能同时写入。采用 **ETag 乐观并发控制**：

```
写入流程：
  1. 读取目标文件 → 获取当前 ETag
  2. 本地修改内容
  3. PutObject with If-Match: <ETag>
     ├── 成功 → 写入完成
     └── 412 Precondition Failed → 重新读取、合并、重试（最多 3 次）
```

批次级 snapshot 与 R2 的一致性：
- Snapshot 创建时记录所有文件的 ETag
- 即时更新同时写 R2 和 snapshot，保持同步
- 如果后台衰减任务修改了 snapshot 中的文件，snapshot 中的该文件标记为 stale，下次读取时刷新

**为什么选 R2 而非 PostgreSQL：**
- Memory 文件数量有限（一个品牌几十个文件），R2 list 操作延迟（~50-100ms）可接受
- `_index.md` 天然是索引，不需要 SQL 查询
- 与 ChatCut 的媒体存储统一基础设施
- Dynamic Worker 天然有 R2 binding
- 纯文件，无状态，易于备份/导出/迁移

### 10.2 批次级 Memory Snapshot

批量生产场景下（一次出 20 条视频），每条都查询 R2 浪费 I/O。采用批次级 snapshot：

```
批次开始
    ↓
Agent 服务一次性从 R2 list + get 相关 memory 文件
    ↓
构建 MemorySnapshot 对象（内存中）
    ↓
20 条视频共用这个 snapshot
    ↓
批次期间的即时更新（高置信度）：
  同时写 R2 + 追加到 snapshot → 后续视频立即受益
    ↓
批次结束 → snapshot 释放
```

### 10.3 远期：独立 Memory 服务

如果 memory 规模增长到单个 Agent 服务无法承载：

```
Memory Service（独立部署）
├── REST API：CRUD + 查询
├── R2 对象操作封装
├── 衰减 / 冲突检测后台任务
└── 向量索引（Phase 5+）
```

---

## 十一、开放问题

### 11.1 Memory 可迁移性

用户能否导出 memory？如果 ChatCut 提供 memory 导出（JSON/Markdown 文件包），用户可以：
- 备份自己的审美认知
- 在不同 ChatCut 实例间同步
- 甚至迁移到其他工具（如果其他工具支持类似格式）

**初步倾向：** 支持导出。Memory 是用户的资产，不锁定。但飞轮效应（memory 格式 + Agent 系统的深度集成）本身就是护城河。

### 11.2 命名空间与团队共享

**MVP 命名空间（单用户）：**

```
R2 bucket: chatcut-memory
└── {user-id}/
    ├── global/        # 用户个人偏好
    ├── brands/        # 用户管理的品牌
    └── projects/      # 用户的项目
```

MVP 阶段所有 memory 归属单个 user-id，无跨用户访问。`memoryFS` binding 在创建时绑定到特定 user-id 前缀，无法越权读写。

**多租户扩展路径（post-MVP）：**

```
R2 bucket: chatcut-memory
├── orgs/{org-id}/                    # 组织级
│   ├── brands/{brand}/               # 组织共享品牌 memory
│   │   └── _acl.md                   # 访问控制：谁能读/写
│   └── shared/                       # 组织共享偏好
├── users/{user-id}/
│   ├── global/                       # 个人偏好（叠加在 org 之上）
│   └── overrides/{brand}/            # 个人对品牌 memory 的覆盖
```

- 品牌 memory 由 org owner 管理，成员只读 + 个人覆盖层
- 个人覆盖层的合并优先级高于 org 品牌 memory
- GDPR 删除：删除 `users/{user-id}/` 下所有内容 + org 共享 memory 中该用户贡献的条目（通过 `source_change_ids` 追溯）

### 11.3 Memory 的 token 预算

Memory 注入 system prompt 会占用 token 预算。如何平衡"给 Agent 足够的认知"和"留够空间给任务本身"？

**初步倾向：** 设置 memory token 上限（如 4000 token），按优先级裁剪：
1. 显式规则（source: explicit）优先
2. 高置信度（confidence: high）优先
3. 与当前任务相关度高的优先（由查询脚本的排序逻辑决定）

### 11.4 Memory 的准确性验证

隐式提取的 memory 可能不准确（LLM 误解了 reject 原因）。如何验证？

**初步倾向：**
- 低置信度 memory 在首次影响决策时，Agent 在输出中注明"基于之前的交互，我认为你偏好 X，如果不对请告诉我"
- 用户确认/否认后更新置信度
- 不做自动验证——让飞轮自然转，不准的 memory 会在后续交互中被自然纠正或衰减

### 11.5 隐私与安全

Memory 包含用户的品牌信息、受众数据、商业偏好。需要：
- 加密存储
- 访问控制（谁能读哪些 memory）
- GDPR 合规（用户要求删除时完全清除）

---

## 十二、实施节奏

| 阶段 | 内容 | 依赖 |
|------|------|------|
| Phase 1 同步 | Memory 文件格式规范 + R2 存储路径设计 | Phase 0 R2 配置 |
| Phase 2 同步 | Memory Extractor 骨架（只处理显式输入）+ 查询模板 | Phase 1 Change Log |
| Phase 4 集成 | 完整 Memory Extractor（混合更新策略）+ 查询模板读取 + 注入 Agent prompt + 冲突 marker 机制 | Phase 4 Agent 系统 |
| Phase 4 后期 | Dynamic Worker 自定义脚本查询 + 批次级 snapshot | Dynamic Worker 集成 |
| Phase 5 | Pattern Observer + Memory → Skill 自动结晶 + 多模态 embedding | Phase 5 资产管理 |
| 持续 | 衰减/冲突检测后台任务 | Memory 积累到一定规模后 |
