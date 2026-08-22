# Agent Note: Windows desktop packaging spawn EINVAL

Status: implemented

English | [中文](2026-08-22-windows-desktop-pnpm-spawn-einval.zh.md)

## Problem

`DSH-GUI Windows installer` on GitHub-hosted `windows-latest` (Node 24) failed at `dsh-gui package: deploy win32-x64` with `spawn EINVAL` before `pnpm deploy` started. Node 24 on Windows throws that error synchronously when `child_process.spawn` targets a `.cmd` shim without `shell: true`. Packaging resolves `pnpm` to `pnpm.cmd` on Windows, then spawned it with `stdio: ['inherit', 'pipe', 'pipe']` and no shell.

## Decision

Windows packaging subprocesses that are not `process.execPath` set `shell: true` and `windowsHide: true`. Captured `pnpm deploy` output uses `stdio: ['ignore', 'pipe', 'pipe']` on Windows so stdin is not an inherited handle mixed with piped stdout. `electron-builder` still runs as `process.execPath` without a shell. `package.cjs` only executes `main()` when it is the process entry, so tests can load `packageChildOptions`.

## Alternatives considered

**Spawn `pnpm` without the `.cmd` suffix.** Rejected because Windows still has to find the cmd shim, and Node 24's restriction is on `.cmd`/`.bat` files, not the name.

**Call `pnpm deploy` from the workflow YAML instead of `package.cjs`.** Rejected because staging, lifecycle-script assertions, and electron-builder still belong in one packaging entry.

**Use `shell: true` for every Windows child, including Node.** Rejected because electron-builder already has a real `.exe` path; quoting that command line through `cmd.exe` adds failure modes without fixing the shim.

## Verification

`package-spawn.spec.ts` requires `shell` and `windowsHide` for `pnpm.cmd` capture on `win32`, no shell for the Node executable on `win32`, and no Windows-only spawn fields on `darwin`. The first green `DSH-GUI Windows installer` run after this change is the assembled proof that `pnpm deploy` starts on `windows-latest`.

## Consequences

A dispatch of `DSH-GUI Windows installer` on a commit that includes this spawn path can package NSIS. GitHub Release upload still requires that commit to match the tag; a Windows fix landed after macOS already created `dsh-gui-v<version>` cannot be uploaded by `github-release.cjs` onto that tag.
