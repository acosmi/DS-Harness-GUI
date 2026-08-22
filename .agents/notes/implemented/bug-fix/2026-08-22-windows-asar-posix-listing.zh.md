# Agent Note: Windows ASAR 列表按 POSIX 归档路径核对

Status: implemented

[English](2026-08-22-windows-asar-posix-listing.md) | 中文

## Problem

`DSH-GUI Windows installer` 进入 electron-builder `afterPack` 后以 `Packaged desktop app is missing /dist/main.js` 失败。暂存目录里已有 `dist/`（`assertUtilityImports` 已在其中运行 `node dist/utility.js`）。`@electron/asar` 的 `listPackage` 用 `path.join` 拼接 header 名，因此 Windows 上的列表项是 `\dist\main.js`，而 `assertAsarRuntimeClosure` 查找的是 POSIX 的 `/dist/main.js`。`extractFile` 再用 `path.sep` 分段；POSIX 的 `node_modules/first/package.json` 在 Windows 上会变成单个 `dirname` 段，因此通过必选文件检查后，嵌套清单仍会找不到。

这与 [Windows 打包 spawn EINVAL](2026-08-22-windows-desktop-pnpm-spawn-einval.zh.md) 无关。上传仍遵守 [GitHub Release 安装包](../process/2026-08-22-dsh-gui-github-release-installers.zh.md) 的同 commit tag 规则。

## Decision

`assertAsarRuntimeClosure` 在必选文件、依赖遍历和 native 前缀检查之前，把每条 `listPackage` 项转成 POSIX（`\` → `/`）。调用 `extractFile` 时去掉前导斜杠，再把 `/` 换成 `path.sep`。

## Alternatives considered

**把缺少 `/dist/main.js` 当成 electron-builder `files` glob 失败。** 否决：暂存里已有 `dist/`，Windows 上 `listPackage` 会以 `\dist\main.js` 列出该文件。

**继续向 `extractFile` 传 POSIX 名，并给 `@electron/asar` 打补丁。** 否决：打包用的 `extractFile` 按 `path.sep` 分段；在这一处调用做转换是本仓库该承担的适配。

**把审计放宽成子串或大小写不敏感匹配。** 否决：必选路径和 native 前缀是精确归档项；更松的匹配会掩盖真正的缺文件。

## Verification

`runtime-closure.spec.ts` 向 `win32-x64` 审计提供反斜杠 `listPackage` 列表，并要求审计接受它。同一测试记录 `extractFile` 使用 `path.sep` 拼接的名字。POSIX 的 darwin 列表用例仍拒绝缺失的嵌套依赖和非目标 node-pty prebuild。

## Consequences

派发 `DSH-GUI Windows installer` 到包含此映射的 commit，才能跑完 electron-builder `afterPack`。GitHub Release 上传仍要求该 commit 与 tag 目标一致；若 macOS 已经按更早的 commit 创建了 `dsh-gui-v<version>`，`github-release.cjs` 不能把后续 Windows 修复 commit 的安装包传到那个 tag。
