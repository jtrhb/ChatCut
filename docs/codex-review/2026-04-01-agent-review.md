# Agent Review

日期：2026-04-01

范围：`apps/agent` 最近一组 agent runtime / session / task / prompt / memory / skill 相关改动。

测试情况：

- 在 `apps/agent` 下执行了 `npm test`
- 结果：`44` 个测试文件、`688` 个测试全部通过

## Findings

### 1. MemorySelector 回退了原有的 activation_scope 和冲突决胜逻辑

- 文件：`apps/agent/src/memory/memory-selector.ts`
- 问题：
  - draft memory 现在只检查 `activation_scope.session_id`
  - `project_id` 和 `batch_id` 被忽略
  - 同 `semantic_key` 冲突时只按 `scope_level` 选胜者，丢掉了原来的 `confidence -> source -> updated` 决胜逻辑
- 风险：
  - 不匹配项目或批次的 draft memory 也可能被错误注入
  - 同层级冲突时会选到较弱或过期 memory
- 证据：
  - `apps/agent/src/memory/memory-selector.ts`
  - `apps/agent/src/memory/__tests__/memory-loader.test.ts`
- 结论：这是行为回退，不只是重构。

### 2. ToolPipeline 会把失败请求的 idempotency key 也永久占用

- 文件：`apps/agent/src/tools/tool-pipeline.ts`
- 问题：
  - idempotency key 在 pre-hook 和实际执行前就写入 `idempotencyKeySet`
  - 如果随后被 hook 阻断、executor 抛错、或执行失败，key 不会释放
- 风险：
  - 用户或系统对失败请求进行合法重试时，会直接收到 idempotency conflict
  - 这会把“防重复副作用”错误实现成“失败也不能重试”
- 结论：需要把 key 的占用时机后移，或引入 `reserved / committed / failed` 状态。

### 3. `/chat` 没有校验 session 和 project 的归属关系

- 文件：`apps/agent/src/routes/chat.ts`
- 问题：
  - 传入 `sessionId` 时，只检查 session 是否存在
  - 没有验证该 session 是否属于当前 `projectId`
- 风险：
  - 项目 A 的消息可以被追加到项目 B 的 session
  - 会导致跨项目上下文污染
- 结论：需要在路由层显式校验 `session.projectId === projectId`。

### 4. `/status` 已注入 SessionManager，但 `activeSessions` 仍然是硬编码

- 文件：`apps/agent/src/routes/status.ts`
- 问题：
  - `activeSessions` 现在固定返回 `0`
  - 但这个 router 已经注入了 `SessionManager`
- 风险：
  - control-plane 状态从第一天就是假的
  - 上层 UI 或监控如果依赖这个接口，会被误导
- 结论：要么接真实 session 计数，要么暂时不要暴露这个字段。

### 5. SkillRuntime 接线了，但 frontmatter 语义基本没有真正落地

- 文件：
  - `apps/agent/src/skills/loader.ts`
  - `apps/agent/src/skills/types.ts`
  - `apps/agent/src/skills/__tests__/loader.test.ts`
- 问题：
  - `loadSkillsWithContracts()` 传给 `SkillRuntime` 的 `frontmatter` 目前几乎只有 `agent_type`
  - `allowed_tools`、`denied_tools`、`model`、`effort`、`when_to_use`、`execution_context`、`hooks` 都没有从 skill 内容里解析出来
  - 测试也只验证“返回了 contract 字段”，没有验证这些 frontmatter 真正生效
- 风险：
  - 现在的 skill contract 更像空壳接口，不是真正的 runtime contract
- 结论：这一层方向对了，但目前仍是半接线状态。

## 建议的下一步演进

### P0

- 恢复 `MemoryLoader` 之前的 activation_scope 匹配逻辑：
  - `project_id`
  - `batch_id`
  - `session_id`
  - 至少一个存在且全部匹配才算通过
- 恢复 memory 冲突决胜顺序：
  - `scope_level`
  - `confidence`
  - `source`
  - `updated`
- 修正 `ToolPipeline` 的 idempotency 语义，不要让失败请求永久污染 key
- 在 `/chat` 校验 session 与 project 的归属关系
- 把 `/status.activeSessions` 接到真实 session 状态

### P1

- 把 skill frontmatter 从 `ParsedMemory` 中拆出来或完整解析出来
- 让 `allowed_tools` / `denied_tools` / `model` / `effort` / `when_to_use` 真正影响 `SkillRuntime`
- 给 `/status`、`/chat`、后续 `/events` 建立统一 control-plane 读模型

### 建议补的测试

- draft memory 在 `project_id` 不匹配时必须被排除
- draft memory 在 `batch_id` 不匹配时必须被排除
- 同 `semantic_key` 冲突时应按 `confidence/source/updated` 决胜
- idempotency key 在 hook block / execution failure 后允许合法重试
- `/chat` 传入跨项目 `sessionId` 时应返回错误
- skill frontmatter 的 `allowed_tools` / `model` / `effort` 应有语义测试，而不只是 shape 测试
