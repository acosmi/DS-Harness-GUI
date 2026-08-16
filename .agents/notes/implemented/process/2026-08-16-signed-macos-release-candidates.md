# Agent Note: Signed macOS Release Candidates Before Stable Readiness

Status: implemented

English | [中文](2026-08-16-signed-macos-release-candidates.zh.md)

## Problem

The [DSH-GUI release-ledger policy](../../../../downstream/release/README.md) keeps code completion, signed artifact evidence, and stable public-release readiness separate. The original implementation nevertheless offered only development and stable build modes. Stable signing required `apple-signing-and-notary` to be ready, while that input required final signed, notarized, stapled arm64 and x64 artifacts as its evidence. The release check therefore prohibited the operation needed to satisfy one of its own prerequisites.

The packaging path also allowed electron-builder to skip notarization when no recognized credential environment was present, notarized and stapled the application before target creation but did not submit the final DMG, and verified signatures without proving that every Mach-O contained only the isolated target architecture. Cross-architecture deployment also ran dependency lifecycle scripts under the host Node process, so Koffi selected the host architecture instead of pnpm's x64 target and attempted an invalid native build. A successful command could therefore provide less evidence than the release ledger required or fail before producing the second architecture.

## Decision

`DSH_DESKTOP_RELEASE_MODE` has three closed values. `development` keeps ad hoc macOS signing and may use a dirty source tree. `candidate` requires a clean tree, the recorded Developer ID Application SHA-1, and exactly one complete Apple notarization credential family, but runs only the ordinary six-ledger consistency check. `stable` applies the same signing requirements and additionally requires every stable input, frozen product commit, compatibility record, legal identity, and responsibility record through the existing signed-readiness check.

Candidate and stable applications both report the cryptographic fact `signing: signed`, so OS-protected secret storage is available. That value does not represent release promotion. Candidate packaging does not modify a ledger, mark an external input ready, publish an artifact, or authorize stable promotion.

The credential preflight accepts one complete App Store Connect API-key family, Apple-ID app-password family, or notarytool keychain-profile family. Partial or mixed families fail before staging. Credential values remain process inputs and never enter repository files, artifact logs, or build metadata.

Before staging either isolated arm64 or x64 target, the packager removes only that target's named DMG, ZIP, and blockmaps. Target deployment disables every dependency lifecycle script and rejects any reported lifecycle execution; target-specific prebuilt packages supply native binaries, the packager restores the node-pty helper mode explicitly, and the existing filesystem and ASAR audits prove the resulting native runtime. electron-builder resolves the recorded identity, and a custom signer preserves its exact SHA-1 through the codesign invocation instead of replacing it with a potentially duplicated common name. electron-builder then submits the application to Apple, waits for acceptance, and staples it. The post-sign check verifies the outer Bundle ID and hardened runtime, extracts the leaf certificate from every code signature and matches its SHA-1 to the ledger, checks the recorded team and authority chain, secure timestamps, a single expected architecture on every Mach-O, the stapled ticket, and Gatekeeper acceptance. After target creation, the packager verifies the signed DMG and its exact leaf certificate before separate submission. Once Apple accepts it, the packager staples and validates the ticket, checks UDIF integrity and that the signed cdhash remains unchanged, and requires Gatekeeper acceptance. It then extracts the ZIP into a private random temporary directory and repeats the complete application checks. SHA-256 values are computed only from the final bytes.

The supported evidence entry point is `pnpm run desktop:package:mac:candidate`. Public stable packaging remains `pnpm run desktop:package:mac:stable` and cannot use candidate evidence as a substitute for unrelated SDK, OAuth, update, legal, support, Windows, or approval inputs.

## Verification

Focused tests pin release-mode parsing, exact certificate selection through the signer, post-sign fingerprint checks, trusted-signing classification, complete and exclusive credential families, lifecycle-free target deployment, target-specific old-artifact cleanup, notarytool argument construction, accepted submission parsing, and thin-target architecture checks. Final candidate execution supplies the Apple submission identifiers, Developer ID and Gatekeeper results, per-format SHA-256 values, and extracted ZIP verification for both architectures.

## Alternatives considered

**Mark `apple-signing-and-notary` ready before building.** Rejected because the record would assert evidence that did not exist and would still leave the x64 artifact requirement unproved.

**Remove Apple and platform inputs from stable readiness.** Rejected because stable promotion would then lose the fail-closed product policy and could proceed while material public-release requirements remained blocked.

**Manually re-sign a development artifact.** Rejected because its embedded build facts would continue to state `development-unsigned`, the operation would bypass the packaged dependency and identity checks, and it would make the resulting bytes irreproducible from the documented entry point.

**Submit only the application and rely on its ticket inside every container.** Rejected because the final DMG is an independently signed distributable whose own notarization ticket and Gatekeeper result are required evidence. The ZIP cannot carry a stapled ticket itself, so its extracted stapled application is verified instead.

## Consequences

Generating evidence requires two Apple submissions per architecture: the application submitted by electron-builder and the final DMG submitted after target creation. This increases candidate duration but proves the actual distributable bytes. The candidate mode makes cryptographically complete local artifacts possible before organizational release readiness, while stable publishing remains blocked until the release ledgers truthfully record every independent prerequisite.
