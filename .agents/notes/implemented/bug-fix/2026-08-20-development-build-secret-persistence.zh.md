# Agent Note: 开发构建保留 OS 保护的账户密钥

Status: implemented

[English](2026-08-20-development-build-secret-persistence.md) | 中文

## Problem

桌面运行时把发布者签名分类当作 secret storage 能力检查。因此，即使 Electron 已经建立 macOS Keychain 或 Windows DPAPI 保护，每个本地开发包仍只会获得进程内存 vault。OAuth 能够完成，Host 在该进程内也保持授权，但正常重启应用会按构造逻辑丢弃 token。renderer 准确报告了内存模式；修改它的账户快照无法让授权持久化。

## Decision

主进程在 Electron app ready 后，根据发布者分类和已观测的 `safeStorage` 事实选择 vault。签名构建要求使用保护 vault，并在构造时的持久化选择中于加密不可用时拒绝启动；不受保护或尚未确定的 Linux 后端也会拒绝启动。未签名构建仅在 Electron 报告加密可用时选择该 vault；Linux `basic_text`、`unknown` 或缺失的后端事实会选择进程内存。renderer 直接获得已构造 vault 的 `vault.persistence`，不再根据签名元数据独立重算模式。

保护 vault 的格式、原子写入路径以及 product、channel、issuer 和 profile 绑定保持不变。因此，具备合格 OS 保护的本地开发构建会重新打开同一份加密账户状态，不会引入明文存储、应用自管加密密钥或兼容格式。

## Alternatives considered

**让所有未签名构建继续使用进程内存。** 这会防护一种假设的不受支持运行时，但代价是每个本地编译并安装的 macOS 或 Windows 应用都会在重启时丢失成功登录，即使操作系统提供了相同的加密原语。

**把每个 `isEncryptionAvailable()` 结果都视为充分条件。** Electron 的 Linux `basic_text` 后端不提供所需的 secret 保护，而未解析的后端也不是肯定证据。两者均继续只使用内存。

**通过 renderer storage 或新建应用密钥持久化。** renderer storage 会把 bearer token 移过特权边界，而应用自管密钥只会重新安置解密 token 所需的 secret。现有主进程 OS 保护 vault 继续是唯一持久所有者。

## Consequences

在 OS 保护可用时，本地 macOS 和 Windows 开发包会跨重启保留账户与已保存凭据状态。不具备合格保护的机器仍只使用 session，并通过产品信息公开实际模式。聚焦策略测试覆盖签名失败关闭选择、签名 Linux 弱后端拒绝、未签名保护选择、不可用与 Linux 回退状态；vault 测试通过新实例重新打开加密数据，并保留现有 identity 隔离检查。
