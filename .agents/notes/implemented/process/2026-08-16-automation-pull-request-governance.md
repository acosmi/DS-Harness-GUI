# Agent Note: Administrator-Merged Pull Requests for Repository Automation

Status: implemented

English | [中文](2026-08-16-automation-pull-request-governance.zh.md)

## Problem

Repository-writing automation needs enough authority to publish continuing work without gaining a path around human review. Direct writes to the default branch collapse proposal and acceptance into one action, while a globally writable Actions token gives unrelated workflows permissions they do not use. A pull-request path must also fail visibly when proposal creation is unavailable instead of leaving completed work only on an unreviewed branch.

## Decision

Automation creates or updates a uniquely named `codex/automation/<task>` branch. A push to that prefix runs [Open automation pull request](../../../../.github/workflows/automation-pull-request.yml), which finds the open pull request for the exact head and default base or creates one as a draft. Later pushes update that pull request through ordinary GitHub branch semantics. The workflow does not check out code, mutate a branch, submit a review, enable auto-merge, or merge.

The repository keeps the default `GITHUB_TOKEN` permission at read-only and enables GitHub Actions pull-request creation at repository level. Only the proposal workflow grants `pull-requests: write`; it retains `contents: read`. A repository test scans every workflow, rejects another pull-request writer, pins this workflow's GitHub CLI verbs to pull-request list and create, and rejects direct Git invocation.

The `main` protection rule requires a pull request for every actor, including administrators, requires `e2e` and `all checks passed`, requires review conversations to be resolved, and forbids force pushes and deletion. Its empty push-restriction allowlist leaves branch updates to repository administrators, but administrators remain subject to the pull-request and check requirements. The approval count stays zero so a single-administrator repository does not deadlock; administrator ownership of the merge is the human acceptance step. The required-check topology remains owned by the [portable pull-request CI decision](2026-07-23-portable-required-pull-request-ci.md).

Pull requests created with `GITHUB_TOKEN` enter GitHub's approval-required workflow state. An administrator starts their checks, reviews the result, and performs the merge. Automation never approves its own proposal. This extends the repository's existing [dependency-update policy](2026-07-27-dependabot-version-updates.md), which also separates automated proposals from maintainer acceptance.

## Verification

The focused workflow test parses the trigger, concurrency key, exact permissions, existing-pull-request path, draft-creation path, complete GitHub CLI verb set, and absence of direct Git invocation. The repository's documentation checks validate this decision pair and its links. A live repository-settings read verifies administrator enforcement, required status contexts, deletion and force-push denial, read-only default Actions permissions, and the pull-request-creation switch.

## Alternatives considered

**Let automation push the default branch.** Rejected because branch protection, CI, review, and administrator acceptance would all occur after the repository had already changed.

**Enable auto-merge after checks pass.** Rejected because passing checks supplies evidence but does not make the repository's acceptance decision; an administrator remains responsible for merging.

**Grant read and write permissions to every workflow token.** Rejected because unrelated workflows would acquire repository mutation authority. The one proposal workflow receives one write scope.

**Use a dedicated GitHub App installation token.** This would separate proposal creation from GitHub's combined Actions create-or-approve setting and could start pull-request workflows without manual approval, but it adds an app private key and installation lifecycle. The ephemeral repository token plus administrator-started checks is the smaller credential system for the current automation volume.

**Mutate proposal branches from hosted automation.** Rejected for this mechanism. The existing automation already owns its checkout and branch writes; the hosted job only creates missing pull-request metadata. This preserves the no-hosted-branch-mutation decision for [automatic translation pairing merges](2026-08-08-automatic-translation-pairing-merges.md).

## Consequences

Continuing automation accumulates commits in one reviewable draft instead of changing `main`. Administrators perform two explicit actions for a newly created proposal—start its workflows and merge it after the required evidence—so unattended acceptance is deliberately unavailable. Branches outside `codex/automation/**` keep their existing manual pull-request workflow. The repository-level create-or-approve switch is broader than this workflow's behavior, so the workflow-permission test and default read-only token remain required controls.
