# Agent Note: Windows ASAR listings are POSIX archive paths

Status: implemented

English | [中文](2026-08-22-windows-asar-posix-listing.zh.md)

## Problem

`DSH-GUI Windows installer` reached electron-builder `afterPack` and failed with `Packaged desktop app is missing /dist/main.js`. Staging already contained `dist/` (`assertUtilityImports` ran `node dist/utility.js` there). `@electron/asar` `listPackage` joins header names with `path.join`, so a Windows listing is `\dist\main.js` while `assertAsarRuntimeClosure` looks up POSIX `/dist/main.js`. `extractFile` then splits with `path.sep`; a POSIX `node_modules/first/package.json` is one Windows `dirname` segment, so nested manifests would also miss after the required-file check.

This is independent of [Windows packaging spawn EINVAL](2026-08-22-windows-desktop-pnpm-spawn-einval.md). Upload still follows the [GitHub Release installer](../process/2026-08-22-dsh-gui-github-release-installers.md) same-commit tag rule.

## Decision

`assertAsarRuntimeClosure` maps every `listPackage` entry to POSIX (`\` → `/`) before required-file, dependency-walk, and native-prefix checks. It passes `extractFile` the same path with `/` replaced by `path.sep` after stripping the leading slash.

## Alternatives considered

**Treat a missing `/dist/main.js` as an electron-builder `files` glob failure.** Rejected: staging already had `dist/`, and `listPackage` on Windows returns the file under `\dist\main.js`.

**Keep POSIX extract names and patch `@electron/asar`.** Rejected: the packaged `extractFile` splits with `path.sep`; converting the one call site is the owned adaptation.

**Relax the audit to substring or case-insensitive matching.** Rejected: the required paths and native prefixes are exact archive entries; a looser matcher would hide a real omission.

## Verification

`runtime-closure.spec.ts` feeds a backslash `listPackage` listing for `win32-x64` and requires the audit to accept it. The same test records `extractFile` names joined with `path.sep`. The POSIX darwin listing case still rejects a missing nested dependency and a non-target node-pty prebuild.

## Consequences

A `DSH-GUI Windows installer` dispatch on a commit with this mapping can finish electron-builder `afterPack`. GitHub Release upload still requires that commit to match the tag target; a Windows packaging fix landed after macOS created `dsh-gui-v<version>` cannot be uploaded by `github-release.cjs` onto that tag.
