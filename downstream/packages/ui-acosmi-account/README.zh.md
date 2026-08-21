# @acosmi/dsh-ui-acosmi-account

[English](README.md) | 中文

DSH-GUI 私有客户端插件，提供 Acosmi 账户引导、账户状态、会员、额度和基于证据显示的额度权益卡。界面只接收生成的客户端安全账户 DTO；令牌、账户标识和原始账单响应始终留在 Host 工具进程中。

slot 注册通过 `inject.hooks.snapshot` 传递账户 store；React 绑定由 UI renderer 负责，并向组件提供 `useSnapshot`。因此账户插件只依赖 slot 约定，不依赖具体 renderer 实现。

数字对比采用失败关闭策略。只有 `account-acosmi` 根据类型化订阅计划提供当前 `quotaMultiplierClaim` 时，卡片才显示倍率；其他情况只显示中性会员文案。

该包同时保留官方 DeepSeek API 密钥作为另一条引导路径，并显示社区发行版声明。

## 模型体验

无。账户和账单投影只供界面展示，不会进入模型请求或会话日志。

#### KV Cache 影响

无。

## 已知限制

- 已发布的 `@acosmi/sdk-ts@2.17.0` 已提供所需的桌面 OAuth `state` 保证。签名 production 登录仍对 SDK 独立的 TokenStore 失败传播和 issuer 认证账户 subject 缺口保持失败关闭；OpenAI 托管模型发行还取决于终止原因无损保留。
- Host 按部署配置执行有界定时刷新。打开账户页与前台恢复会请求当前提供方投影，可见页面按配置间隔轮询 Host 最新快照，并在账户操作期间暂停轮询；后续可由 SDK 推送通道替代该策略。
