# Agent Note: Stable 就绪前生成已签名 macOS Release Candidate

Status: implemented

[English](2026-08-16-signed-macos-release-candidates.md) | 中文

## Problem

[DSH-GUI 发行账本策略](../../../../downstream/release/README.md)把代码完成、签名产物证据与 stable 公开发行就绪分开处理，但原实现只提供 development 与 stable 两种构建模式。stable 签名要求 `apple-signing-and-notary` 已 ready，而该输入又要求最终 arm64 与 x64 产物已经签名、公证并 staple 作为证据，因此发行检查禁止了满足自身前置条件所必需的操作。

原打包路径还允许 electron-builder 在没有识别到凭据环境时跳过公证；它会在生成目标前公证并 staple 应用，却不提交最终 DMG；签名检查也没有证明每个 Mach-O 只包含隔离构建的目标架构。跨架构部署还会在宿主 Node 进程中运行依赖生命周期脚本，导致 Koffi 选择宿主架构而非 pnpm 的 x64 目标，并尝试无效的原生编译。因此，命令成功不一定提供发行账本要求的完整证据，也可能在生成第二种架构前失败。

## Decision

`DSH_DESKTOP_RELEASE_MODE` 只接受三个值。`development` 保留 macOS ad hoc 签名并允许源码树不干净。`candidate` 要求源码树干净、使用账本记录的 Developer ID Application SHA-1，并且只存在一组完整的 Apple 公证凭据，但只运行普通六账本一致性检查。`stable` 使用相同签名要求，并继续通过现有 signed-readiness 检查要求所有 stable 输入、冻结产品 commit、兼容性记录、法律实体与职责记录完整。

candidate 与 stable 应用都报告加密事实 `signing: signed`，因此可以使用 OS 保护的 secret 存储；该值不表示发行提升。candidate 打包不会修改账本、把外部输入标为 ready、发布产物或授权 stable 提升。

凭据预检只接受一组完整的 App Store Connect API key、Apple ID app password 或 notarytool 钥匙串 profile。凭据不完整或同时混用多组会在暂存前失败。凭据值只作为进程输入，不进入仓库文件、产物日志或构建 metadata。

暂存隔离构建的任一 arm64 或 x64 目标前，打包器只删除该目标的指定 DMG、ZIP 与 blockmap。目标部署禁用全部依赖生命周期脚本，并拒绝任何报告出的生命周期执行；按目标选择的预编译包提供原生二进制，打包器显式恢复 node-pty helper 权限，现有文件系统与 ASAR 审计再证明原生运行时完整。electron-builder 随后解析账本记录的身份，自定义签名器再把精确 SHA-1 原样传入 codesign，避免替换成可能重复的通用名称；随后 electron-builder 提交应用、等待 Apple 接受并 staple。签名后检查会验证最外层 Bundle ID 与 hardened runtime，从每个代码签名提取叶证书并把其 SHA-1 与账本比对，同时检查账本记录的 Team 与 Authority 链、安全时间戳、每个 Mach-O 只有一个预期架构、staple ticket 以及 Gatekeeper 验收。目标生成后，打包器会单独提交并 staple 已签名 DMG，验证其精确叶证书与 Gatekeeper 验收，再把 ZIP 解到私有随机临时目录并重复完整应用检查。SHA-256 只对最终字节计算。

受支持的证据入口是 `pnpm run desktop:package:mac:candidate`。公开 stable 打包仍使用 `pnpm run desktop:package:mac:stable`，candidate 证据不能替代无关的 SDK、OAuth、更新、法律、支持、Windows 或审批输入。

## Verification

聚焦测试固定 release mode 解析、签名器中的精确证书选择、签名后指纹检查、受信签名分类、完整且互斥的凭据组、无生命周期脚本的目标部署、目标专属旧产物清理、notarytool 参数构造、已接受提交解析与单一目标架构检查。最终 candidate 执行提供两种架构的 Apple submission id、Developer ID 与 Gatekeeper 结果、各格式 SHA-256 以及 ZIP 解包检查证据。

## Alternatives considered

**构建前把 `apple-signing-and-notary` 标为 ready。** 拒绝，因为该记录会声明尚不存在的证据，而且仍不能证明 x64 产物要求。

**从 stable 就绪条件移除 Apple 与平台输入。** 拒绝，因为 stable 提升会失去按失败关闭的产品策略，并可能在重要公开发行要求仍受阻时继续。

**手工重新签名 development 产物。** 拒绝，因为其嵌入构建事实仍会声明 `development-unsigned`，该操作会绕过已打包依赖与身份检查，而且结果字节无法从文档规定的入口复现。

**只提交应用，并依赖其 ticket 随每个容器交付。** 拒绝，因为最终 DMG 是独立签名的可分发产物，它自身的公证 ticket 与 Gatekeeper 结果属于必需证据。ZIP 本身不能携带 staple ticket，因此改为检查其解出的已 staple 应用。

## Consequences

每个架构需要两次 Apple submission：electron-builder 提交应用，目标生成后再提交最终 DMG。这会延长 candidate 时间，但能够证明实际分发字节。candidate 模式使组织层面的发行条件尚未就绪时也能生成加密完整的本地产物，而 stable 发布仍保持阻塞，直到发行账本如实记录每项独立前置条件。
