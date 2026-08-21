# Agent Note: Portable pull-request CI recovery boundary

Status: implemented

English | [中文](2026-07-23-portable-required-pull-request-ci.zh.md)

## Problem

Required pull-request jobs assigned to organization-owned runner labels remain queued when GitHub cannot allocate those pools. The workflow is valid and standard GitHub-hosted jobs can still pass, but `all checks passed` never starts and an otherwise healthy pull request cannot satisfy branch protection.

Billing health, a runner definition's `Ready` state, and a large autoscaling ceiling do not prove that a named pool can receive a job. Required correctness checks need a known portable recovery path even when the ordinary low-latency path depends on repository-external runner provisioning.

## Decision

[CI](../../../../.github/workflows/ci.yml) distinguishes the canonical `deepseek-ai/deepseek-harness` repository from derived repositories before selecting runners. The canonical repository runs the three required primary Node 24 jobs on its organization-owned 16-core Linux pool; derived repositories run the same jobs on standard `ubuntu-latest` with conservative worker budgets. The stable `all checks passed` aggregate remains on `ubuntu-latest` because it performs no checkout or repository gate. The required Windows job runs Windows Node under Wine on standard `ubuntu-latest` for the blocking surfaces; an independent native job uses the canonical repository's organization-owned 16-core Windows runner or standard `windows-2025` in a derived repository and does not participate in the aggregate ([dual Windows decision](2026-08-08-native-windows-pull-request-ci.md)). Standard `ubuntu-latest` jobs retain Node 22.19, Node 26, the Python SDK unit suite, and the [release-shaped Linux x64 Python runtime validation](../testing/2026-08-12-required-python-runtime-pull-request-ci.md), while the serial references remain the complete unsharded cross-platform definitions.

The three Linux primary jobs, Node compatibility, Python SDK unit suite, Python runtime validation, and `windows node 24 / wine blocking` remain dependencies of `all checks passed`; `windows node 24 / native complete` is deliberately absent. Branch protection continues to require `e2e` and `all checks passed`. Derived repositories never request the canonical organization's labels, so they cannot deadlock on unavailable runner groups. Within the canonical repository, the platform-specific variables documented by the [failover runbook](2026-07-26-ci-failover-runbook.md) retarget an unavailable enterprise pool to its proven self-hosted standby without changing the required inventory.

The [larger-runner decision](2026-07-22-evidence-based-larger-hosted-runners.md) owns the current primary topology and its measurements. The [serial cross-platform reference](2026-07-21-serial-cross-platform-ci-reference.md) remains the independent completeness check, now provided by the self-hosted `vm-backup`/`dsh-win-ci` standby lanes on `master`; the only hosted serial reference is the disabled `serial-macos`. The manual larger-runner suites retain size comparisons without expanding the ordinary required matrix.

## Alternatives considered

**Use standard capacity in every repository.** This removes enterprise allocation dependencies, but complete standard-runner jobs give materially slower feedback and still experience shared-capacity queues. The selected split spends enterprise capacity on the canonical repository's Linux critical path while keeping derived repositories complete and portable.

**Keep organization-owned labels unchanged in derived repositories.** Rejected because GitHub does not fail an unavailable label; it leaves the job queued indefinitely, so branch protection can never receive the required verdict.

**Select enterprise size from advertised core count.** Benchmarks show non-monotonic scaling and setup variance, so exact complete-job measurements choose the required pools instead.

**Skip or demote checks while capacity is unavailable.** This would make the status green by dropping evidence rather than by running the repository's required contracts.

**Use one worker policy on every host.** Outer gate concurrency and inner tool workers contend differently on Linux, Windows, and standard runners; measured host-specific bounds avoid turning additional cores into slower execution.

## Consequences

Canonical-repository pull requests spend enterprise capacity on the Linux critical path while the Wine job keeps the required Windows verdict on standard Linux allocation. Derived-repository pull requests execute the same required inventory on standard runners with lower concurrency. The independent native job uses the runner available to its repository without delaying or changing the aggregate. A live exact-head run distinguishes the commands branch protection consumes from the separate diagnostic contract; queue delay is reported separately from each job's `startedAt` to `completedAt` execution interval.

Derived repositories need no runner-group provisioning beyond GitHub's standard images. In the canonical repository, standard compatibility and required Wine jobs remain useful during enterprise degradation, but only the explicit failover switch moves blocked primary jobs to a pool that can produce the required verdict; changing a pool definition's status alone is insufficient evidence that it can receive work.
