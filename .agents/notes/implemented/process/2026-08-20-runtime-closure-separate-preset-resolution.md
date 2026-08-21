# Agent Note: Runtime closure separates deploy and preset resolution

Status: implemented

English | [中文](2026-08-20-runtime-closure-separate-preset-resolution.zh.md)

## Problem

An executable deployment needs two complete dependency facts: its deploy root must satisfy every required workspace peer reachable from the packaged graph, and the manifest used to resolve its shipped agent presets must directly declare every bare plugin those presets can load. The [Python single-exe runtime](../architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) uses one dependency-only manifest for both purposes, while DSH-GUI deploys from the desktop application manifest and resolves bare plugin names relative to the desktop composition bundle. Treating both facts as if they always shared one manifest either reports false omissions or encourages a duplicate plugin roster.

## Decision

`verifyRuntimeClosure()` accepts paths for the deploy manifest, preset resolver manifest, and target inventory. The resolver defaults to the deploy manifest and the target inventory defaults to the Python platform manifest, preserving the Python runtime's existing dependency source and target list. Workspace-peer traversal always starts from the deploy manifest. A distinct resolver must itself be reachable in that graph; shipped-preset checks then read its direct dependencies and evaluate platform conditions for every supported target. DSH-GUI passes its application manifest as the deploy root, `@acosmi/dsh-desktop-bundle` as the preset resolver, and its release support matrix as the target inventory. The application manifest directly declares every required workspace peer needed by its packaged graph.

## Alternatives considered

**Duplicate every preset plugin in the desktop application manifest.** The desktop utility resolves bare plugins relative to the desktop bundle. Copying that dependency roster into the application would create a second list that can drift without changing runtime resolution.

**Skip preset verification for non-Python deploy roots.** The desktop package ships the same preset files and can fail at runtime when their resolver lacks a plugin. Omitting the check would trade a manifest-model error for an installed-product failure.

**Treat transitive dependencies as satisfying required workspace peers.** pnpm layout and hoisting are not peer-dependency declarations. The deploy root continues to name required peers explicitly so an isolated deploy cannot depend on incidental placement.

## Consequences

The reusable checker preserves one strict, connected deployment graph while keeping bare-plugin resolution and supported-platform ownership in their actual manifests. Python callers need no options. Executables whose deploy, preset resolver, or target inventory differ must pass those paths explicitly, and their packaging documentation must identify each source.
