# Agent Review Follow-up 2

日期：2026-04-01

范围：`apps/agent` 在修复前两轮 review 之后的再次复查，重点看新加的 `ToolPipeline`、`SkillLoader`、`SkillRuntime` 是否已经真正接进主执行链路。

测试情况：

- 在 `apps/agent` 下执行了 `npm test`
- 结果：`44` 个测试文件、`701` 个测试全部通过

## Findings

### 1. ToolPipeline 仍未接入真实 agent 执行路径

- 文件：
  - `apps/agent/src/tools/tool-pipeline.ts`
  - `apps/agent/src/agents/runtime.ts`
  - `apps/agent/src/agents/editor-agent.ts`
  - `apps/agent/src/agents/master-agent.ts`
  - `apps/agent/src/tools/executor.ts`
- 问题：
  - `ToolPipeline` 本身现在已经修正了不少 hook / idempotency 语义
  - 但 `NativeAPIRuntime` 仍然只接收一个裸的 `toolExecutor(name, input)` 并直接调用
  - 各 agent 也只是把 executor 函数直接塞给 runtime
  - 仓库内没有找到 `ToolPipeline` 的非测试实例化或生产接线
- 风险：
  - 这次修好的 hook、trace、幂等、失败分类语义都不会作用在真实 agent tool call 上
  - 当前线上行为仍取决于旧的 executor 路径，而不是新 pipeline
- 结论：现在是“测试里的 pipeline 更先进，生产里的 pipeline 还不存在”。

### 2. Skill runtime / frontmatter 仍未接入真实 skill 注入链路

- 文件：
  - `apps/agent/src/skills/loader.ts`
  - `apps/agent/src/skills/skill-runtime.ts`
  - `apps/agent/src/memory/memory-loader.ts`
  - `apps/agent/src/skills/presets/*.md`
- 问题：
  - `SkillLoader.loadSkillsWithContracts()` 和 `loadSystemPresets()` 都已经存在
  - 但主 skill 注入路径仍然是 `MemoryLoader` 直接把 `_skills/*` 当普通 memory 读取并格式化进 prompt
  - 没有证据表明 `SkillContract`、`resolvedTools`、`resolvedModel`、`when_to_use`、`execution_context` 已进入真实运行链路
  - `skills/presets/` 里的本地 preset 文件目前也看不到生产消费方
- 风险：
  - 这轮新加的 skill runtime 语义主要还停留在单元测试里
  - `allowed_tools` / `model` / `effort` 等配置不会真正影响 agent 行为
  - system presets 容易变成“存在于仓库，但不参与运行”的死资产
- 结论：skill 这条线现在更像是半落地状态，解析层有了，消费层还没接上。

### 3. ToolPipeline 的 onFailure 生命周期仍然不稳定

- 文件：`apps/agent/src/tools/tool-pipeline.ts`
- 问题：
  - 普通失败路径虽然提取了 `runFailureHooks()`，但调用点没有 `await`
  - `pre-hook` 或 `post-hook` 自身抛错时，会直接返回失败结果，不会再跑 `onFailure`
- 风险：
  - failure hooks 变成 fire-and-forget，时序不可控
  - 如果后续把 audit、cleanup、telemetry、dead-letter 之类逻辑挂在 `onFailure` 上，行为会不一致
  - 一部分失败会触发 `onFailure`，另一部分失败不会，语义不完整
- 结论：这次把“hook 不能把 pipeline 打崩”修好了，但还没把 failure lifecycle 定义完整。

## 还能继续进化

### P0

- 把真实工具执行路径收敛成一条：
  - `NativeAPIRuntime`
  - `ToolPipeline`
  - `ToolExecutor / executeImpl`
- 不要继续并存“测试里走 pipeline、生产里走裸 executor”的双轨结构
- 明确 `onFailure` 语义：
  - 是否必须 `await`
  - 哪些失败类型一定触发
  - trace 与 failure hook 的先后顺序是什么

### P1

- 把真实 skill 消费路径收敛成一条：
  - store skill
  - preset skill
  - frontmatter contract
  - prompt/runtime consumption
- 让 `resolvedTools`、`resolvedModel`、`when_to_use`、`execution_context` 至少有一个明确的生产使用点
- 如果 system presets 是产品能力，就接进主链路；如果只是样例资产，就不要伪装成 runtime feature

### P2

- 把“解析层测试”和“真实接线测试”分开
- 为 tool pipeline 增加 integration test，验证 agent runtime 真正经过 pipeline
- 为 skill runtime 增加 integration test，验证 skill frontmatter 真正改变 agent prompt 或执行配置

## 建议补的测试

- `NativeAPIRuntime` 发起的 tool call 应实际经过 `ToolPipeline`
- 真实 agent dispatch 路径应保留 pipeline 的 trace / failure / idempotency 语义
- `MemoryLoader` 与 `SkillLoader` 的职责边界应有集成测试，避免 skill 被当普通 memory 静默吞掉
- system preset 被启用时，应能在真实 prompt 或 runtime config 上观察到效果
- `onFailure` 在 executor failure、pre-hook failure、post-hook failure 三种情况下的触发语义应被完整锁定
