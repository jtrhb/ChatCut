# ChatCut UX Design — AI 视频编辑交互范式

## 设计原则

传统 chat panel + timeline 分离的模式不适合视频编辑。用户不信任纯文字描述的编辑结果，需要看到视觉变化才能判断。

核心理念：**对话、空间指向、时间指向三位一体，所有 Agent 操作先以 Ghost 形式可视化，用户确认才生效。**

---

## 交互范式：三合一

### 范式 1：Timeline-first + 浮动对话

Timeline 是主角，对话不是独立面板，而是锚定在 timeline 操作位置的 contextual bubble。

```
┌─────────────────────────────────────────┐
│ [视频预览区]                              │
│                                         │
│    ┌─────────────────┐                  │
│    │ Agent: 我在 3.2s │                  │
│    │ 处切了一刀，看下  │                  │
│    │ 效果？           │                  │
│    └────────┬────────┘                  │
├─────────────┼───────────────────────────┤
│ ──●━━━━━━━━╋━━━━━━━━●── timeline ──── │
│   clip A   ↑切点    clip B              │
│         (可拖动)                         │
├─────────────────────────────────────────┤
│ [💬 对话输入: "再往前 0.5 秒"]           │
└─────────────────────────────────────────┘
```

- Agent 对话气泡锚定在 timeline 操作位置
- 用户眼睛不用在 chat panel 和 timeline 之间跳
- 滚动/缩放 timeline 时气泡跟随
- 元素被删除时气泡自动转为 "orphaned" 状态（灰显，可查看历史）

### 范式 2：Ghost Preview + 对话审批

Agent 的每个操作先以半透明 ghost 叠加在 timeline 上，用户确认才变实体。

```
Timeline 当前状态 (实体):
──[clip A ████████]──[clip B ████████]──

Agent 提议 (ghost, 半透明叠加):
──[clip A ████]╌╌╌╌[clip B ████████]──
              ↑
        "trim to 3s"
        [✓ Accept] [✗ Reject] [✏️ Adjust]
```

- Ghost 可播放 — 点击预览 trim 后效果
- Reject 后 ghost 消失无痕
- Adjust 让用户拖动 ghost 边界微调
- 多个 ghost 可同时存在（batch changeset）
- 直接对齐现有 changeset 系统（propose → ghost, approve → commit, reject → disappear）

### 范式 3：Multimodal 指令 — 画 + 说 + 指

```
用户在视频预览画面上画圈 → "把这个人的背景换成海滩"
用户在 timeline 上框选一段 → "这段太拖沓了"
用户点击音频波形峰值 → "在这个鼓点切"
```

对话输入不是纯文本，而是 text + spatial annotation + temporal selection 的组合。

---

## Ghost 生命周期

### 状态机

```
proposed → previewing → accepted → committed
              ↓               ↘
           adjusting      invalidated (依赖的 ghost 被 reject)
              ↓
         re-proposed (用户调整后 agent 重新计算)
              ↓
           stale (底层元素被人工修改)
```

### Ghost 之间的依赖

Agent 提议 "先 trim clip A → 再在切点加转场"。Ghost B 依赖 Ghost A。

- Reject A → B 自动标记为 `invalidated`，显示原因（"转场点不存在了"）
- Accept A → B 变为可操作状态
- 依赖关系在 timeline 上用连接线可视化

### Ghost 冲突检测

用户在 ghost 存在期间手动操作了涉及的元素：
- Ghost 检测到底层元素已变化
- 标记为 `stale`，边框变为警告色
- 提示用户："clip A 已被修改，此操作可能不再适用"

### Ghost 分组操作

Agent 一次提议多个操作时：
- 一键全部 accept / reject
- 逐个 accept / reject
- 框选 2-3 个一起操作
- 分组之间的关系线（"这 3 个是一组节奏调整"）

---

## Agent 意图可视化 — Why, Not Just What

### Reasoning Overlay

每个 ghost 旁有可展开的 reasoning bubble：

```
Ghost: trim clip A to 3s
Why: ┌──────────────────────────────────┐
     │ 🎵 Beat at 3.2s — cutting here  │
     │ matches music rhythm             │
     │ 📊 Average scene length: 3.1s    │
     │ 💭 Your preference: "prefer      │
     │ quick cuts for product videos"   │
     └──────────────────────────────────┘
```

- 直接关联 Memory 系统 — 显示 agent 引用了哪些 memory
- 用户可修正过时的 memory（"那个偏好过时了" → 触发 memory update）

### Confidence Indicator

Ghost 视觉样式表达 agent 确信度：
- **实线边框** = 高确信（基于明确指令）
- **虚线边框** = 中确信（基于 pattern/preference）
- **点状边框** = 低确信（猜测，需要用户选择）

低确信 ghost 自动展开 "why" 面板，主动请求确认。

---

## Spatial Snapping — SAM2 集成

用户在视频画面上画圈/指向时，精度是核心问题。

### 方案：SAM2 (Segment Anything Model 2) 语义 Snap

```
用户粗略画圈 →
  SAM2 在该帧执行分割 →
  识别圈内所有语义对象（人物、物体、文字）→
  自动 snap 到最近的对象轮廓 →
  高亮显示: "你是指这个人吗？" →
  用户确认 → agent 执行
```

**多对象消歧**：圈内有多个对象时，显示选择列表（带缩略图）让用户点选。

**SAM2 优势**：
- 视频级别的 segment propagation — 标注一帧，自动追踪整段视频
- 支持点击、框选、粗略涂鸦等多种 prompt 形式
- 和 Vision Agent 的 scene analysis 互补：Vision 做语义理解，SAM2 做像素级定位

**运行时机**：
- 不需要预分割全部帧 — 用户画圈时对当前帧 on-demand 执行
- 结果缓存在 VisionCache — 同一帧的 SAM2 结果可复用
- 可在客户端用 ONNX 运行轻量版（Florence-2 + SAM2），重载场景 fallback 到服务端

**设计文档引用**：chatcut-plan.md 已将 SAM2 列为 "fallback when user says you changed the wrong thing"。此设计将其提前到 spatial annotation 阶段使用，覆盖更广。

### Temporal + Spatial 组合指令

最强大的场景：用户同时提供时间范围 + 空间区域 + 文字指令。

```ts
interface MultimodalMessage {
  text: string;
  temporal?: { start: number; end: number; elementIds?: string[] };
  spatial?: {
    frameTimestamp: number;
    region: { x: number; y: number; w: number; h: number };
    snappedObjects?: Array<{
      type: string;        // "person" | "object" | "text" | "background"
      label: string;       // "man in blue shirt"
      segmentMask?: string; // SAM2 mask reference
      confidence: number;
    }>;
  };
  ghostRef?: string;  // 指向已有 ghost: "把那个改动再调大一点"
}
```

---

## Playback 与 Ghost 交互

### 双模预览

- **当前状态播放**（实线 playhead）：忽略所有 ghost，播放真实 timeline
- **提议状态播放**（虚线 playhead）：应用所有 accepted + proposed ghost

用户可切换两个模式，或使用 **split view playback**：画面左半 before，右半 after，同步播放。

### 局部预览

点击单个 ghost → 只预览这一个操作的 before/after，不受其他 ghost 影响。批量操作时用于单独评估每个改动。

---

## "教 Agent 做事" — Watch-and-Learn

超越单次指令，用户可以 demonstrate：

```
用户手动操作 clip #1 (agent 观察记录)
  → Agent: "我注意到你做了: trim 到鼓点 + 0.1s cross dissolve"
  → Agent: "找到了 7 个类似的片段，要我都这样处理吗？"
  → 7 个 ghost 同时出现在 timeline 上
  → 用户可以逐个微调或批量 accept
```

- 比文字描述 "在每个鼓点处剪" 精确 10 倍
- 操作序列直接存入 Skill 系统，未来自动复用
- Memory 层记录 "用户偏好在鼓点处 trim + cross dissolve"

---

## Agent 主动建议

Agent 持续分析 timeline，发现问题但不打断用户。

### Subtle Notification

Timeline 边缘显示小标记：
```
⚡ "音频在 12.3s 有削波"
🎬 "这段 8 秒无动作，节奏偏慢"
🎨 "色温在第 3 段突变"
```

- 用户可忽略
- 点击展开 → agent 的建议已是 ghost 形式
- **底线：agent 永远不自动执行。所有主动建议都是 ghost/notification。**

---

## Error Recovery

### Panic Undo

醒目的 "Undo All Agent Changes" 按钮，一键回滚到上一次纯人工状态。不是逐步 undo，直接跳到 checkpoint。

### Timeline 时光机

类似 macOS Time Machine：
- 每次 approve ghost 自动创建 snapshot
- 用户可滑到任意历史版本
- 可以说 "回到 5 分钟前的版本"

### Blame View

Timeline 元素着色：
- 蓝色 = 人工编辑
- 橙色 = agent 编辑
- Tooltip 显示操作详情和时间
- 长 session 后可快速定位"是哪次 agent 操作搞乱了"

---

## 渲染性能

### 延迟阈值

| 延迟 | 用户感知 | 信任影响 |
|------|---------|---------|
| < 200ms | 即时 | "我在控制" |
| 200ms - 1s | 可接受 | "系统在响应" |
| 1s - 5s | 需要进度 | "它在干嘛" |
| > 5s | 焦虑 | "卡了吗" |

### 快操作（< 200ms）

Timeline 元数据变更（trim, split, move, volume）：
- 乐观更新 UI — ghost 立即出现
- 不等 agent 确认
- 用户 approve 后才 commit

### 慢操作（渐进式信任）

计算密集型操作（generate_video, analyze_video, export）：

```
analyze_video:
  0-2s:  timeline 上扫描线动画（"正在看视频"）
  3s:    第一个场景标记出现
  5s:    更多场景标记 + 缩略图
  完成:  所有标注可交互

generate_video:
  1s:    占位符出现在 timeline（灰色块 + 生成中图标）
  5s:    低分辨率预览帧替换灰色块
  15s:   可播放的低质量预览
  完成:  最终质量视频就位
```

### 前端性能要求

- SSE event → UI 更新 < 16ms (一帧)
- Timeline 支持增量更新（不整体 re-render）
- 缩略图 lazy loading
- 波形数据 Web Worker 解码
- Preview video `<video preload="metadata">`

---

## SSE 事件协议

### Progress Event（增量 visual hints）

```ts
type ToolProgressEvent = {
  type: "tool.progress";
  toolName: string;
  step: number;
  totalSteps?: number;

  visualDelta?: {
    addMarkers?: Array<{
      elementId: string;
      timestamp: number;
      label: string;
      thumbnail?: string;
    }>;
    updatePlaceholder?: {
      elementId: string;
      previewUrl?: string;
      quality: "skeleton" | "low" | "final";
    };
    scanProgress?: { currentTime: number; totalDuration: number };
  };

  estimatedRemainingMs?: number;
  text?: string;
};
```

---

## 长 Session 认知负荷 — 自动收纳

连续编辑 2 小时后 timeline 会累积大量标记。策略：

### 时间衰减

已 committed 的 ghost 标记（blame 着色）按时间淡出：
- 刚 commit：完全着色
- 5 分钟后：着色变淡
- 15 分钟后：只保留边缘细线标记
- 明确选择 blame view 模式时全部重新显示

### 空间折叠

密集区域（10 秒内有 5+ 操作标记）自动折叠为摘要标记："此区域有 5 次编辑"，hover 展开。

### 对话气泡收纳

- 只显示最近 3 个对话气泡
- 更早的收起为 timeline 上的小圆点，点击展开
- Agent 建议通知：已查看的自动隐藏，未查看的上限 5 个

### 一键清理

"Clear all markers" 按钮，只保留未处理的 ghost 和未查看的建议。

---

## Ghost 视觉区分 — 按操作类型，不按 Agent

用户不关心 "editor agent" 还是 "audio agent"，关心操作类型。

| 操作类型 | Ghost 颜色 | 示例 |
|---------|-----------|------|
| 剪辑操作 | 蓝色 | trim, split, move, delete |
| 音频操作 | 绿色 | BGM, 音量, 字幕, 配音 |
| 生成操作 | 紫色 | AI 视频, AI 图片 |
| 分析结果 | 黄色标记（annotation，非 ghost） | 场景标注, 角色识别 |

用户扫一眼就知道 "这批操作有 3 个剪辑 + 1 个音频调整"。Agent 是实现细节，对用户隐藏。

---

## 范围决策

| 项 | 决策 |
|----|------|
| 多人协作 | **不做** — 单用户产品 |
| 移动端 | **延后** — 与 desktop app (Tauri) 一起考虑，当前只做桌面浏览器 |
| 无障碍 | **延后** — 前端实现时作为 checklist |

---

*本文档为 ChatCut 交互设计的概念阶段文档，随讨论持续更新。*
