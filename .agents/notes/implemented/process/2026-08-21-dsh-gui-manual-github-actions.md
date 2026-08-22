# Agent Note: Manual DSH-GUI GitHub Actions

Status: implemented

English | [中文](2026-08-21-dsh-gui-manual-github-actions.zh.md)

## Problem

The Acosmi DSH-GUI overlay cannot allocate the organization-owned 16-core runner labels that [ci.yml](../../../../.github/workflows/ci.yml) uses, and its remaining GitHub Actions minutes cannot absorb an automatic pull-request matrix. Jobs that wait on those labels stay queued, which also deadlocks any `main` protection rule that requires those jobs to finish.

## Decision

[ci.yml](../../../../.github/workflows/ci.yml) listens only to `workflow_dispatch`. The other minute-spending workflows — [e2e.yml](../../../../.github/workflows/e2e.yml), [landlock-run.yml](../../../../.github/workflows/landlock-run.yml), [expected-filenames.yml](../../../../.github/workflows/expected-filenames.yml), [release.yml](../../../../.github/workflows/release.yml), [release-vendor.yml](../../../../.github/workflows/release-vendor.yml), [python-release.yml](../../../../.github/workflows/python-release.yml), and [build-exe-for-python-sdk.yml](../../../../.github/workflows/build-exe-for-python-sdk.yml) — do not list `pull_request`. Maintainers start CI from the GitHub API or the Actions UI against a chosen ref. `e2e.yml` still accepts push, schedule, and dispatch; its job skips unless the repository is `deepseek-ai/deepseek-harness`.

`main` branch protection still requires a pull request, conversation resolution, and the administrator push allowlist recorded in [automation pull-request governance](2026-08-16-automation-pull-request-governance.md). It does not require Actions status checks. [issue-lifecycle.yml](../../../../.github/workflows/issue-lifecycle.yml) and [issue-policy.yml](../../../../.github/workflows/issue-policy.yml) still listen to pull-request events; they are GitHub project automation, not the 16-core CI matrix. Canonical-repository notes such as [portable pull-request CI](2026-07-23-portable-required-pull-request-ci.md) continue to describe upstream policy; this overlay diverges, and `downstream/upstream-baseline.json` records the `.github/workflows` generic patch.

## Alternatives considered

**Keep automatic pull-request CI and drop only the required checks.** Merges would proceed, but every synchronize would still queue the 16-core matrix and spend quota.

**Disable GitHub Actions for the repository.** That also blocks `workflow_dispatch`, so a maintainer could not start CI through the API.

**Leave `pull_request` on the workflow and skip every job with `if: false`.** GitHub still starts the workflow. `all checks passed` treats skipped required workers as failure, so the check panel stays red.

**Keep required checks and wait for runner allocation.** This overlay cannot use `dsh-ubuntu-24-04-16core`, so the wait does not end.

## Consequences

Opening or updating a pull request does not start the CI, e2e, landlock, or release-pack workflows. Correctness evidence for this overlay is local unless a maintainer dispatches CI. Merging `main` does not wait for GitHub Actions. The next upstream workflow merge must re-apply this overlay.
