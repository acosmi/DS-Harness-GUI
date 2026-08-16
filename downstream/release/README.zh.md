# @acosmi/dsh-desktop-release

[English](README.md) | 中文

维护六份机器可读的 DSH-GUI 发行账本及其封闭 JSON schema。`pnpm run desktop:verify` 校验所有账本、stable/canary 的规范身份分配与固定 installer GUID、规定的职责角色、外部输入、平台、原生模块及各模块目标平台精确 roster、每项外部输入的发行阻塞策略与负责角色、stable 阻塞项、ABI 记录及锁定的 lockfile hash，但不会把代码完成误判为发行就绪。它还要求每个 Acosmi SDK 直接消费包与审计版本一致，核对该版本和 integrity 对应的 lockfile registry 条目，并在已发布包具备 state 能力后拒绝残留的本地 OAuth 补丁。

identity 账本记录公开的 macOS Developer ID 元数据以及 stable 打包使用的精确 SHA-1 选择器。post-sign 门禁还会找出应用内每个 Mach-O 文件，要求它们分别携带同一 Developer ID Team、Authority 链与安全时间戳；最外层应用还必须符合对应渠道的 Bundle ID 并启用 hardened runtime。账本有意排除本地证书与 CSR 路径、钥匙串位置、私钥、P12 文件、密码和公证凭据。即使本机身份验证已经通过，`apple-signing-and-notary` 输入仍保持 blocked，因为公证以及最终 arm64、x64 产物完成签名、公证和 staple 是相互独立的要求。

如果已发布的 Acosmi SDK 缺少 OAuth state 防护、TokenStore 故障传播、已认证账户 subject 或 OpenAI 流终止原因的无损保留，`pnpm --filter @acosmi/dsh-desktop-release run verify:signed` 以及所有标记为 stable 签名的 main-process 构建都会失败关闭；任一标记为发行阻塞的外部输入仍受阻、产品 commit 尚未冻结、兼容性证据不完整、发行法律实体缺失，或者任何职责记录缺少 owner、独立 backup、evidence 或 due date，也会触发同一门禁。不带受信发行方签名的开发门禁会报告这些阻塞项，但不授权签名、发布或提升发行渠道。
