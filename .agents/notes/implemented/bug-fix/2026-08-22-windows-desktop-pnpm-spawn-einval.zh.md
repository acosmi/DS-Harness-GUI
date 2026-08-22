# Agent Note: Windows 桌面打包 spawn EINVAL

Status: implemented

[English](2026-08-22-windows-desktop-pnpm-spawn-einval.md) | 中文

## Problem

GitHub 托管的 `windows-latest`（Node 24）上，`DSH-GUI Windows installer` 在 `dsh-gui package: deploy win32-x64` 处以 `spawn EINVAL` 失败，`pnpm deploy` 尚未启动。Windows 上的 Node 24 在 `child_process.spawn` 指向 `.cmd` 垫片且未设置 `shell: true` 时会同步抛出该错误。打包在 Windows 上把 `pnpm` 解析为 `pnpm.cmd`，然后以 `stdio: ['inherit', 'pipe', 'pipe']`、无 shell 的方式启动它。

## Decision

不是 `process.execPath` 的 Windows 打包子进程设置 `shell: true` 和 `windowsHide: true`。捕获 `pnpm deploy` 输出时，Windows 使用 `stdio: ['ignore', 'pipe', 'pipe']`，避免把继承的 stdin 与管道 stdout 混用。`electron-builder` 仍作为 `process.execPath` 运行，不走 shell。`package.cjs` 仅在作为进程入口时执行 `main()`，以便测试加载 `packageChildOptions`。

## Alternatives considered

**去掉 `.cmd` 后缀去 spawn `pnpm`。** 否决：Windows 仍要找到 cmd 垫片，Node 24 的限制针对 `.cmd`/`.bat` 文件本身，不是名字。

**在 workflow YAML 里直接跑 `pnpm deploy`，绕过 `package.cjs`。** 否决：暂存、生命周期脚本断言和 electron-builder 仍应走同一打包入口。

**所有 Windows 子进程都 `shell: true`，包括 Node。** 否决：electron-builder 已有真正的 `.exe` 路径；再经 `cmd.exe` 引用该命令行只会增加失败模式，修不了垫片问题。

## Verification

`package-spawn.spec.ts` 要求 `win32` 上捕获 `pnpm.cmd` 时带 `shell` 与 `windowsHide`，`win32` 上的 Node 可执行文件不走 shell，`darwin` 上不出现 Windows 专用 spawn 字段。包含此改动后的第一次绿灯 `DSH-GUI Windows installer` 运行，是 `windows-latest` 上 `pnpm deploy` 能够启动的组装证明。

## Consequences

派发 `DSH-GUI Windows installer` 到包含此 spawn 路径的 commit 才能打出 NSIS。GitHub Release 上传仍要求该 commit 与 tag 一致；若 macOS 已经按更早的 commit 创建了 `dsh-gui-v<version>`，`github-release.cjs` 不能把后续 Windows 修复 commit 的安装包传到那个 tag。
