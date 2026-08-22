# Agent Note: DSH-GUI GitHub Release installers

Status: implemented

English | [中文](2026-08-22-dsh-gui-github-release-installers.zh.md)

## Problem

The product repository had packaging entry points for macOS and Windows installers but no way to put those files on the remote GitHub Release that users download from. Hosting both platforms on GitHub-hosted Actions would spend macOS minutes at the ten-times multiplier, and this overlay still cannot allocate the organization 16-core runner labels.

## Decision

The identity ledger repository `acosmi/DS-Harness-GUI` is the installer distribution location. A GitHub Release tag is `dsh-gui-v<version>` on stable and `dsh-gui-canary-v<version>` on canary. SemVer pre-release versions are GitHub pre-releases. `electron-builder` `publish` stays `null`; `pnpm run desktop:publish:mac` and `pnpm run desktop:publish:windows` upload through `gh` after the files exist.

macOS arm64 and x64 DMG and ZIP files are packaged on a local Mac (`pnpm run desktop:package:mac`, or the candidate/stable signed variants) and uploaded from that machine. The Windows x64 NSIS installer is packaged by [desktop-windows-package.yml](../../../../.github/workflows/desktop-windows-package.yml), which is `workflow_dispatch`-only, runs packaging on GitHub-hosted `windows-latest` under `pwsh`, and uploads from Ubuntu. The workflow does not use organization 16-core labels or macOS runners. Windows packaging stays `DSH_DESKTOP_RELEASE_MODE=development` until Authenticode credentials exist.

Upload requires a clean worktree, the exact installer filenames for that platform, and the identity-ledger repository slug. An existing tag must resolve to the same commit as the upload; the first platform creates the tag at that commit. The GitHub Release does not mark stable promotion or close a release-ledger input.

## Verification

`github-release.spec.ts` pins tag names, dual-architecture macOS and NSIS paths, clean-worktree and missing-file rejection, foreign-repository rejection, create-then-upload argument lists, same-commit reuse, and dry-run's refusal to mutate. `ci-workflow.spec.ts` pins `workflow_dispatch` only, `windows-latest` packaging, Ubuntu upload, identity-ledger repository equality, and the absence of organization Windows and macOS runner labels.

## Alternatives considered

**Package macOS on GitHub-hosted `macos-*` runners.** Rejected because macOS Actions minutes cost ten times a Linux minute and this overlay is conserving remaining quota.

**Package Windows on `dsh-windows-2025-16core`.** Rejected because this overlay cannot allocate that label.

**Let electron-builder publish to GitHub.** Rejected because packaging already forces `--publish never`, and a packager-held `GH_TOKEN` would mix signing with distribution.

**Cross-compile NSIS from the Mac with Wine.** Rejected because the support matrix's Windows builder is a Windows x64 host, and Wine would spend local complexity to avoid the one CI job that still has to exist.

**Commit installers to a git branch.** Rejected because binaries do not belong in the source tree; GitHub Releases are the download location.

## Consequences

A maintainer packages and uploads macOS locally, then dispatches the Windows workflow on that same commit (or the reverse). Remaining Actions minutes pay for one hosted Windows package job per published version, not a macOS matrix. Signed macOS candidate artifacts may share a tag with unsigned Windows development installers until Authenticode is ready; that tag is still not stable promotion.
