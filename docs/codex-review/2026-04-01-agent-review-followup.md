# Agent Review Follow-up

日期：2026-04-01

范围：`apps/agent` 在修复上一轮 review 之后的增量复查，重点覆盖 `tool pipeline` 与 `skill runtime/frontmatter`。

测试情况：

- 在 `apps/agent` 下执行了 `npm test`
- 结果：`44` 个测试文件、`688` 个测试全部通过

## Findings

### 1. ToolPipeline 的 hook 异常仍会污染幂等语义

- 文件：`apps/agent/src/tools/tool-pipeline.ts`
- 问题：
  - write tool 的 idempotency key 在 executor 成功后、`post-hook` 之前就会提交
  - `pre` / `post` / `onFailure` hooks 都没有统一的异常收敛
  - 一旦 hook 抛错，`execute()` 会直接 reject，而不是稳定返回 `ToolCallResult`
- 风险：
  - `post-hook` 失败时，幂等 key 已经占用，但调用整体却失败
  - trace 不一定完整落盘
  - 合法重试可能被错误拒绝
- 结论：现在修掉了“executor 失败污染 key”，但还没修掉“hook 失败污染 key”。

### 2. Skill 的 `agent_type` 契约和实现不一致

- 文件：
  - `apps/agent/src/skills/types.ts`
  - `apps/agent/src/skills/loader.ts`
  - `apps/agent/src/memory/types.ts`
- 问题：
  - `SkillFrontmatter.agent_type` 类型允许 `AgentType | AgentType[]`
  - 但 `ParsedMemory.agent_type` 仍然是单字符串
  - preset/frontmatter 解析时也会强制 `String(fields.agent_type)`
  - 实际过滤逻辑仍然是严格 `m.agent_type === agentType`
- 风险：
  - 如果一个 skill 需要声明多个 agent type，当前链路会直接失效
  - 类型看起来支持数组，但运行时并不支持，属于隐性契约欺骗
- 结论：要么把契约收紧成单值，要么把 loader/store/runtime 整条链统一到数组语义。

### 3. frontmatter 解析器看起来是 YAML，实际上只支持简化版 JSON-inline

- 文件：
  - `apps/agent/src/skills/loader.ts`
  - `apps/agent/src/memory/memory-store.ts`
- 问题：
  - 当前解析器按行切分，只能处理标量，以及 `["a", "b"]` / `{"x":1}` 这种内联 JSON 风格值
  - 标准 YAML 列表写法如：
    - `allowed_tools:`
    - `  - trim_element`
  - 不会被解析成数组
- 风险：
  - `allowed_tools`、`denied_tools`、`when_to_use`、`hooks` 这批新增 frontmatter 字段只有在“把 JSON 塞进 frontmatter”时才真正可用
  - 文档和实现语义不一致，后续很容易出现“写法看着对，运行时没生效”的问题
- 结论：这不是测试缺口而已，是格式契约本身还没定稳。

## 还能继续进化

### P0

- 把 `ToolPipeline` 做成明确状态机，至少区分：
  - `validated`
  - `executed`
  - `post_processed`
  - `committed`
- 统一捕获 hook 异常，把它们收敛成失败结果，而不是让 `execute()` 直接 throw
- 明确幂等 key 的提交点：
  - 如果语义是“副作用成功即占用”，就不要让 `post-hook` 影响最终成功态
  - 如果语义是“整条 pipeline 成功才占用”，就把 commit 后移到全部 post-hook 成功之后

### P1

- 把 skill schema 从 `ParsedMemory` 里拆开，建立单独的 `ParsedSkill` 或 `SkillSpec`
- 让 store skill 和 preset skill 走同一套解析、校验、contract resolve 流程
- 明确 `agent_type` 是单值还是多值，不要继续让类型定义和运行时行为分叉

### P1.5

- 决定 frontmatter 格式契约：
  - 要么引入真正的 YAML parser
  - 要么在代码和文档里明确声明这是“JSON-compatible frontmatter subset”
- 一旦契约定下来，就补对应语义测试，而不是只测字段存在

## 建议补的测试

- `post-hook` 抛错时，write tool 的 idempotency key 不应被错误占用
- `pre` / `post` / `onFailure` 任一 hook 抛错时，`execute()` 应稳定返回结构化失败结果
- `agent_type` 为数组时，skill 应能被正确匹配到多个 agent
- multiline YAML list 写法应被正确解析，或被明确判定为非法格式
- store-backed skill 和 preset skill 对同一 frontmatter 输入应得到一致的 contract 结果
