# Agent Note: development builds retain OS-protected account secrets

Status: implemented

English | [中文](2026-08-20-development-build-secret-persistence.zh.md)

## Problem

The desktop runtime used publisher-signing classification as the secret-storage capability check. Every local development package therefore received a process-memory vault even when Electron had established macOS Keychain or Windows DPAPI protection. OAuth completed and the Host remained authorized for that process, but a normal application restart discarded the token by construction. The renderer accurately reported the memory mode; changing its account snapshot could not make the authorization durable.

## Decision

The main process chooses the vault after Electron app readiness from publisher classification and observed `safeStorage` facts. Signed builds require the protected vault: its operations fail closed if encryption is unavailable, while an unprotected or unresolved Linux backend rejects startup. Unsigned builds choose it only when Electron reports encryption available; Linux `basic_text`, `unknown`, or missing backend facts select process memory. The renderer receives `vault.persistence` from the constructed vault instead of independently recomputing the mode from signing metadata.

The protected vault format, atomic write path, and product, channel, issuer, and profile bindings remain unchanged. A local development build with qualifying OS protection therefore reopens the same encrypted account state without introducing plaintext storage, an application-managed encryption key, or a compatibility format.

## Alternatives considered

**Keep all unsigned builds in process memory.** This protects a hypothetical unsupported runtime at the cost of making every locally compiled and installed macOS or Windows application lose a successful login on restart, even when the operating system provides the same encryption primitive.

**Treat every `isEncryptionAvailable()` result as sufficient.** Electron's Linux `basic_text` backend does not provide the required secret protection, and an unresolved backend is not affirmative evidence. Both remain memory-only.

**Persist through renderer storage or a new application key.** Renderer storage would move bearer tokens across the privileged boundary, while an application-owned key would only relocate the secret needed to decrypt them. The existing main-process OS-protected vault remains the sole durable owner.

## Consequences

Local macOS and Windows development packages retain account and saved-credential state across restarts when OS protection is available. A machine without qualifying protection remains session-only and exposes that actual mode through product information. Focused policy tests cover signed fail-closed selection, signed Linux weak-backend rejection, unsigned protected selection, unavailable and Linux fallback states; vault tests reopen encrypted data through a new instance and retain the existing identity-isolation checks.
