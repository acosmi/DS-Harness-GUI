# Agent Note: DSH-GUI assistant presents the Acosmi product identity

Status: implemented

English | [中文](2026-08-17-dsh-gui-assistant-identity.zh.md)

## Problem

The desktop composition inherits the upstream DeepSeek Harness system prompt verbatim, so the assistant opens every model request with "You are an AI agent powered by DeepSeek Harness." DSH-GUI is an Acosmi community distribution, and an assistant that identifies itself as an upstream DeepSeek agent is copied product copy that was never rebranded.

## Decision

The desktop bundle patch replaces the `system-prompt` row with `includeHarnessIdentity: false` and a DSH-GUI deployment persona: `You are an AI agent in DSH-GUI, Acosmi's desktop AI agent workbench, powered by the {{model}} model. Your working directory is {{cwd}}.`

The upstream source layer (`packages/core/system-prompt`) is untouched: the fixed harness-identity text remains available for upstream Harness compositions. A session's agent preset still shadows the deployment persona with its own section, and the shipped preset personas (standard, code, cordis, minimal) already contain no upstream branding.

## Alternatives considered

**Keep the upstream identity line** — rejected. It makes the assistant present itself as a DeepSeek agent, which mislabels the community product inside the very surface the user is reading.

**Rebrand inside the upstream `system-prompt` plugin** — rejected. `packages/` is the synced upstream source layer; product copy belongs in the downstream bundle patch, and editing upstream text would drift on the next upstream sync.

**Silence the identity line without a replacement persona** — rejected. The deployment persona should state the product identity rather than merely remove the upstream one; a scoped preset persona still shadows it, so it constrains nothing.

## Consequences

The desktop assistant identifies itself as DSH-GUI (Acosmi) while the upstream Harness Web and CLI compositions keep their own identity. Attribution of the upstream project remains in the README, the About disclaimer, and the release identity, where it belongs.

## Verification

The desktop composition spec asserts the patch row (`includeHarnessIdentity: false` plus the exact persona), and the full downstream suite passes. The keyless ACP snapshot suites are unaffected: they exercise the upstream example compositions, which still carry the upstream identity line.
