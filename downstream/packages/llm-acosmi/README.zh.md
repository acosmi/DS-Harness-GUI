# @acosmi/dsh-llm-acosmi

[English](README.md) | 中文

DSH-GUI 私有模型提供方插件，使用锁定版本的 `@acosmi/sdk-ts` 托管模型 API。只有账户快照处于可用状态，并且当前目录响应确认至少存在一个可选择聊天模型后，才会注册 `acosmi` 路由。更新的账户状态会取消待处理确认并使其 generation 失效，因此迟到的目录结果不能重新激活已撤回路由。后续的 `ready` 快照会刷新缓存目录，但不会撤回已发布路由，因此周期性账户刷新和窗口重新获得焦点时，会员模型不会从选择器中消失。锁定、停用、非聊天模型以及权益状态不确定时的目录项均不可选择。目录列表和精确模型元数据读取该缓存；流式派发仍对照实时目录校验。

每个 SDK client 都携带本地授权生命周期信号，适配器还独立拥有可用路由的生命周期。退出登录、安全存储失败、账户路由撤回或插件卸载会在移除路由前中止已经准入的提供方流，这些流以稳定的 `AUTH` code 失败。每次请求会把模型目录校验与流 dispatch 绑定到同一个 SDK client 及路由信号，因此旧账户迟到的目录不能经替换后的 client 发出请求。后续授权会获得全新的信号，不能恢复先前的流。

托管模型目录中的 `maxTokens` 表示输出能力，不是请求默认值。插件要求独立的正整数 `config.maxTokens`；对话请求没有显式值时，Harness 会在记录和派发前将其具体化。桌面 bundle 设为 8,192 token。显式的单请求值始终优先。必填的 `config.streamIdleTimeoutMs` 控制提供方流式事件的静默时限；桌面 bundle 设为 120 秒。

`WINDOW_LIMIT_EXCEEDED` 会变为稳定且默认不重试的 Harness code `WINDOW_LIMIT`，与账户额度耗尽及普通的暂时性 429 限流区分。面向用户的消息只说明滚动窗口预留拒绝了请求：当前服务器响应报告 used 和 limit，却没有给出促成判定的 incoming 和 projected，因此仅凭响应中的两个数值不能证明额度已经耗尽。

最终提供方工具名重复会变为稳定且默认不重试的 code `TOOL_NAME_COLLISION`。该分类保留会话日志中的 Harness 工具目录，明确暴露提供方故障，而不会静默删除模型可见工具。Nexus 负责人已确认客户端名称优先修复于 2026-08-15 部署；防御性映射继续保留，而最终 DSH 兼容性证据仍需来自修复部署上的托管 DeepSeek、Kimi 与 Qwen 矩阵。

适配器在不添加提示词文本的前提下转换 Harness 消息与流式协议。Acosmi access token 和 refresh token 始终留在 Host secret provider；只有提供方无关的分片及带版本、最小化的回放记录进入会话日志。该记录采用版本 2 的 `ReplayEnvelope`：`response` 保存格式、模型及带原生索引的仅供提供方使用 block，`blocks` 按首次出现顺序为每个发射的 Harness block 保存一条带索引的提供方 block。`BlockAssembler` 因此会在 max-token 组装删除不安全工具调用时同步删除该调用的回放条目，而带索引的仅供提供方使用 block 仍可用于恢复原生顺序。回放解析只接受受支持 block 的精确字段、有深度上限的 JSON 工具输入，以及持久 assistant source 中匹配的 provider 和 model；未知字段或 source 不匹配会在后续模型请求前失败。连续的 Anthropic user 消息会规范化为同一个提供方 turn，使并行 Harness 工具结果在发送给兼容端点时保持在一起。该规则按目录格式选择，因此目录选择 Anthropic 的托管 DeepSeek 与 Kimi 路由同等适用。工具结果 payload 只接受文本；图片、reasoning、嵌套工具和扩展 block 会失败，而不会被静默丢弃。需要 end-user 字段时，提供方收到固定长度的 SHA-256 摘要，而不是本地 Harness session id。在完成持久附件转换前，图片输入会明确拒绝。

assistant 响应只会在目标仍是同一托管模型、回放与持久可见投影完全一致，并且每个 Anthropic thinking block 都携带非空签名时复用完整提供方回放。切换模型后，完全匹配的回放会转换成可移植历史：省略提供方签名 reasoning 与仅供提供方使用的 block，同时保留可见文本和 Harness 工具调用。同一 model ID 的目录格式发生变化时遵循相同规则：Anthropic 签名状态绝不变成 OpenAI `reasoning_content`，无签名 OpenAI reasoning 也绝不成为 Anthropic 精确回放。Anthropic 格式的可移植 block 会保留规范的 `acosmi_ephemeral: true` 标记供 SDK sanitizer 剥离，OpenAI 格式则会先删除这些临时 block 及关联工具结果，再展开为原生消息；只有 reasoning 的响应不会产生空 assistant 消息。回放缺失、不匹配或被修改时仍会失败关闭，不把无效签名或 reasoning 文本发送给目标模型。

托管 `server_tool_use` 与 `web_search_tool_result` block 只属于提供方历史，不是 Harness 工具调用。适配器把这些 block、文本引用以及规范的 `acosmi_ephemeral: true` 标记保留在经过校验的回放中，同时只向 Harness 暴露最终 assistant 内容。账户服务配置 SDK 在下一次托管模型请求前剥离这些临时 block 及关联结果。

SDK 原始流事件由显式词汇表处理。`error` 与 `failed` 都携带提供方失败；`started`、经过校验的空或非空 `sources` 以及结算事件属于模型不可见控制元数据。成功流必须恰好携带一个非空终止原因，随后只能出现结算控制事件与 `message_stop`。sources 结构损坏、未知事件类型、空工具身份、终止原因缺失、重复或不受支持、终止原因后仍出现模型内容，或者没有任何 Harness 可见 block 却声称成功的响应都会失败关闭，不会被静默忽略或记录成成功回答。

已安装的 SDK `2.17.0` 仍会在该适配器收到事件前把过滤及未知的 OpenAI 流 finish reason 改写成正常 `end_turn`。无可见内容的过滤响应会触发适配器的 `EMPTY_RESPONSE` 防线，但部分内容本身不能证明提供方是否过滤了剩余响应。因此发行账本会保持 `acosmi-sdk-openai-finish-reason-preservation` blocked，直到已发布 SDK 无损保留这些原因；本适配器不会根据模型文本推断终止原因，也不会复制 SDK 的 HTTP/SSE 实现。

一项无密钥组装快照通过确定性的账户边界启动真实 Loader、ACP transport、agent loop、Acosmi adapter 与 JSONL persistence。该边界只在 `max_tokens` 为 8,192、所有 Harness 工具名唯一且恰好存在一个客户端 `web_search` 时接受请求；持久 fixture 固定记录 1,000,000 token 模型上下文、仅供提供方使用的托管搜索 block、规范的临时标记、精确引用、usage 与可见 assistant 投影。

SDK 与提供方错误文本只用于选择稳定的 Harness failure code。序列化 failure 与 renderer 消息使用固定的客户端安全文案，同时保留非敏感的 HTTP status 与重试时序，因此响应正文、账户字段、token 和 endpoint 不会通过 `LlmError.message` 跨进程传播。

固定版本的 Acosmi SDK 负责 HTTP 请求重试，因此适配器向 Harness 发布额外尝试次数为零的重试策略，避免两个层级把一次模型调用成倍放大。
