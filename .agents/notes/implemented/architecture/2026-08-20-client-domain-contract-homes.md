# Agent Note: Client domain contract homes

Status: implemented

English | [中文](2026-08-20-client-domain-contract-homes.zh.md)

## Problem

The rc.8 client tree contained imports between sibling implementation directories and imports from `contract/` back into implementations. Twenty-five of the twenty-six edges were present in the upstream source, while one arose from the downstream conversation slot merge. The client-domain graph gate rejected all of them under the layering rule established by the [GUI client architecture](2026-07-19-gui-web-client-architecture.md), so treating the failures as downstream-only merge noise would leave the shipped source and its enforced architecture inconsistent.

## Decision

Cross-domain types live in each package's `contract/` directory. Pure modules used by more than one domain live at the package's `src/client/` top level and depend only on package-level modules or contracts. Domain implementation directories import contracts and top-level shared modules, never sibling implementations. `apply.ts` remains the only cross-domain assembly point.

The runtime contracts own the public Session and Workspace list types. Agent scope, conversation snapshot values, pending interaction values, context provenance, and notification scheduling are top-level shared runtime modules. In `ui-conversation`, input contracts and composer-block faces are contracts, while reference icons, metrics, tool-node readers, decorations, queue projection, and shared statistics are top-level pure helpers. `ui-workspace` keeps row components beside the browser owner because rows are presentation parts, not an independently composable domain.

`scripts/verify-client-domain-graph.ts` remains strict and carries no package allowlist or grandfathered edge baseline.

## Verification

The domain graph gate scans the complete client source tree. The client TypeScript program verifies every moved import and public export, and the runtime, conversation, and workspace package suites exercise the affected implementations through their existing public surfaces.

## Alternatives considered

**Allowlist the rc.8 edges.** Rejected because it would make current source layout an exception to the same rule that is meant to prevent future ownership drift.

**Add forwarding modules at the old implementation paths.** Rejected because the repository has no released compatibility obligation and forwarding would preserve duplicate homes without removing the forbidden dependencies.

**Split every domain into a package immediately.** Rejected because the dependency issue is resolved by establishing correct internal ownership; package extraction adds deployment and loader surface without an independent evolution need.

## Consequences

The gate and shipped source now describe the same dependency direction. Shared values have one authoritative home, and package-internal composition remains explicit. Moving files changes internal source import paths, but public package exports and runtime behavior remain unchanged.
