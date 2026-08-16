# @acosmi/dsh-account-acosmi

[English](README.md) | 中文

DSH-GUI 私有账户服务，负责固定版本的 Acosmi SDK client、桌面 OAuth、加密 TokenStore 访问、账户展示数据以及供 `@acosmi/dsh-llm-acosmi` 使用的授权生命周期。

## 配置

`tokenKey`、`loginEnabled`、`gatewayBaseUrl`、`oauthAppName`、`loginTimeoutMs`、`logoutTimeoutMs`、`refreshIntervalMs`、`refreshJitterMs`、`refreshTimeoutMs`、`projectionPollIntervalMs` 和 `productVersion` 均为必填项。刷新抖动不能超过基础间隔。服务只接受 production `https://acosmi.com` origin，按照精确的 HTTPS endpoint 校验 SDK discovery 文档，并且只请求 SDK `ai` scope。Stable 与 canary bundle 使用不同的 token key。

## 生命周期与失败语义

启动过程会在创建 client 前探测 TokenStore `load()`。完成的预检值会在 SDK 构造期间持续提供，构造结束后才恢复实时 vault 访问，因此 SDK 内部的第二次读取不能吞掉新的存储故障并伪装成未登录。安全存储不可用或损坏时，服务生成独立的 `unavailable` 快照，而不会伪装成未登录。订阅会先同步收到一份分离的当前快照，然后再接收后续变化。

每个 SDK client 都会在发布前启用自动剥离临时历史。后续托管模型请求发出前，SDK 会删除先前带 `acosmi_ephemeral: true` 标记的 assistant block 及其关联工具结果，因此由提供方拥有的 server-search 状态不会进入后续轮次。

交互式登录采用 single-flight。主进程校验并打开且仅打开一个 SDK 授权 URL；只有系统浏览器接受操作已经结算，登录才能成功。登录后的账户投影若被取消或超过 deadline，会回滚新授权，而不会迟到报告成功。锁定的 `@acosmi/sdk-ts@2.17.0` 会生成高熵 OAuth `state`，在读取 code 或 OAuth error 前要求 callback 恰好携带一个匹配值，并在每条终止路径上关闭 loopback listener。授权有效期间，账户投影刷新同样采用 single-flight，以 `refreshTimeoutMs` 为上限，并在每次结算后按 `refreshIntervalMs` 加不超过 `refreshJitterMs` 的随机延迟重新调度。客户端安全快照携带 `projectionPollIntervalMs`，使账户页无需 SDK 推送也能读取 Host 最新投影。退出登录会拒绝新的登录，取消并等待正在进行的登录，中止 SDK session 信号，删除本地凭据，然后才在 `logoutTimeoutMs` 内尝试远端撤销。账户刷新与模型发现会在提供方调用结算后重新校验其捕获的 SDK session 与合并 AbortSignal，因此即使传输层忽略取消，也不能覆盖已经退出的快照或在账户替换后返回前一账户的目录。退出、client 替换与服务卸载都会停止定时刷新；即使提供方操作忽略取消，卸载也能完成结算。本地删除失败是终止性错误，绝不报告已退出；远端超时仍返回已退出结果，但会说明撤销未经确认。

失败的账户操作会携带一个来自封闭客户端安全集合的必填 `reason`。登录会把 SDK 稳定的 `LoginEvent.err_code` 映射成 discovery、registration、打开浏览器、授权拒绝、授权超时、token exchange、TLS 代理和 state mismatch 原因；产品自身的 `loginTimeoutMs` deadline 也映射为 `authorization-timeout`。安全存储与生命周期故障使用各自独立的原因。结果不包含 SDK 错误文本、授权 URL、callback 参数、账户标识或 token，renderer 仍根据粗粒度操作 code 选择固定文案。

`sdkSession()` 把当前 SDK client 与 AbortSignal 组成一项生命周期记录。退出登录、安全存储失败、client 替换或服务卸载都会中止该信号，因此消费方不能在本地授权撤回后继续运行可能计费的工作。TokenStore 的读取、写入、校验与清除会抛出专用的同进程错误，即使主进程桥已经抹去 vault 细节也能稳定分类；账户层还识别 SDK 固定的 `save tokens:` 包装，但不会把任意提到 token store 的提供方文本当作存储证据。卸载会阻止迟到的启动或登录结果在 teardown 后重新发布 client。Remote 与 renderer 结果只包含固定公开文案，不包含 SDK、OAuth、账户或 token 细节。

## 模型体验

### 账户授权

#### 模型看到什么

模型不会看到任何账户、会员、额度、token 或 OAuth 数据。该包只控制独立的 `acosmi` LLM 适配器能否接受请求。

#### Token 影响

直接影响为零 token。所有模型可见请求字段和会话回放记录均由提供方适配器负责。

#### KV Cache 影响

账户变化不会增加提示词前缀。授权撤回会中止活动的提供方请求；后续授权会启动独立请求，不会恢复先前的缓存假设。

## 已知限制与延期工作

- 已发布的 `@acosmi/sdk-ts@2.17.0` 已闭环原生 OAuth `state` 故障，原本的本地 dist 补丁也已移除。同一发布包仍会捕获 refresh rotation 的 `TokenStore.save()` 和无效 token 清理的 `TokenStore.clear()` 失败，记录底层存储消息后继续，而不是传播稳定失败。在这些路径能使内存 client 失效并拒绝操作前，签名 production 登录继续失败关闭。
- SDK `TokenSet` 不提供稳定的账户 subject。因此当前 bundle key 以 `account-current` 结尾；按 subject 隔离的持久化与账户切换迁移仍取决于 SDK 或已认证的账户身份约定。
