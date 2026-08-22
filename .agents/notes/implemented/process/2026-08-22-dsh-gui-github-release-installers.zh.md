# Agent Note: DSH-GUI GitHub Release installers

Status: implemented

[English](2026-08-22-dsh-gui-github-release-installers.md) | 中文

## Problem

产品仓库已有 macOS 与 Windows 安装包的打包入口，但没有把这些文件放到用户下载所用的远程 GitHub Release 上的路径。若两个平台都走 GitHub 托管 Actions，macOS 分钟数会按十倍计费，而且本 overlay 仍然无法分配组织的 16 核运行器标签。

## Decision

identity 账本中的仓库 `acosmi/DS-Harness-GUI` 是安装包分发位置。GitHub Release 标签在 stable 上为 `dsh-gui-v<version>`，在 canary 上为 `dsh-gui-canary-v<version>`。SemVer 预发布版本对应 GitHub pre-release。`electron-builder` 的 `publish` 保持 `null`；`pnpm run desktop:publish:mac` 与 `pnpm run desktop:publish:windows` 在文件已存在后通过 `gh` 上传。

macOS arm64 与 x64 的 DMG 和 ZIP 在本地 Mac 上打包（`pnpm run desktop:package:mac`，或 candidate/stable 签名变体），并由该机器上传。Windows x64 NSIS 安装包由 [desktop-windows-package.yml](../../../../.github/workflows/desktop-windows-package.yml) 打包：该工作流仅 `workflow_dispatch`，在 GitHub 托管的 `windows-latest` 上用 `pwsh` 打包，再从 Ubuntu 上传。工作流不使用组织 16 核标签或 macOS 运行器。在 Authenticode 凭据就绪之前，Windows 打包保持 `DSH_DESKTOP_RELEASE_MODE=development`。

上传要求工作树干净、该平台安装包文件名完整，以及 identity 账本中的仓库 slug。已存在的标签必须解析到与本次上传相同的 commit；先上传的平台在该 commit 上创建标签。GitHub Release 不表示 stable 提升，也不关闭任何发行账本输入。

## Verification

`github-release.spec.ts` 钉住标签名、macOS 双架构与 NSIS 路径、脏工作树与缺失文件拒绝、外部仓库拒绝、先创建再上传的参数列表、同一 commit 复用，以及 dry-run 拒绝变更。`ci-workflow.spec.ts` 钉住仅 `workflow_dispatch`、`windows-latest` 打包、Ubuntu 上传、与 identity 账本仓库一致，以及不出现组织 Windows 与 macOS 运行器标签。

## Alternatives considered

**在 GitHub 托管的 `macos-*` 运行器上打包 macOS。** 否决：macOS Actions 分钟数按 Linux 的十倍计费，本 overlay 需要节省剩余额度。

**在 `dsh-windows-2025-16core` 上打包 Windows。** 否决：本 overlay 无法分配该标签。

**让 electron-builder 发布到 GitHub。** 否决：打包已经强制 `--publish never`，由打包器持有 `GH_TOKEN` 会把签名与分发混在一起。

**在 Mac 上用 Wine 交叉编译 NSIS。** 否决：支持矩阵中的 Windows 构建者是 Windows x64 宿主，Wine 会把本地复杂度花在规避那一个仍然必须存在的 CI 作业上。

**把安装包提交到 git 分支。** 否决：二进制文件不属于源码树；GitHub Release 才是下载位置。

## Consequences

维护者在本地打包并上传 macOS，然后在同一 commit 上派发 Windows 工作流（或反过来）。剩余 Actions 分钟数只支付每个已发布版本一次托管 Windows 打包作业，而不是 macOS 矩阵。在 Authenticode 就绪之前，已签名的 macOS candidate 产物可以与未签名的 Windows 开发安装包共用一个标签；该标签仍然不是 stable 提升。
