# Agent Note: DSH-GUI 手动 GitHub Actions

Status: implemented

[English](2026-08-21-dsh-gui-manual-github-actions.md) | 中文

## Problem

Acosmi 的 DSH-GUI overlay 无法分配 [ci.yml](../../../../.github/workflows/ci.yml) 所使用的组织自有 16 核运行器标签，剩余的 GitHub Actions 分钟数也不足以承担自动拉取请求矩阵。等待这些标签的作业会一直排队，这也会让任何要求这些作业完成的 `main` 保护规则陷入死锁。

## Decision

[ci.yml](../../../../.github/workflows/ci.yml) 只监听 `workflow_dispatch`。其余消耗分钟数的工作流——[e2e.yml](../../../../.github/workflows/e2e.yml)、[landlock-run.yml](../../../../.github/workflows/landlock-run.yml)、[expected-filenames.yml](../../../../.github/workflows/expected-filenames.yml)、[release.yml](../../../../.github/workflows/release.yml)、[release-vendor.yml](../../../../.github/workflows/release-vendor.yml)、[python-release.yml](../../../../.github/workflows/python-release.yml) 与 [build-exe-for-python-sdk.yml](../../../../.github/workflows/build-exe-for-python-sdk.yml)——都不列出 `pull_request`。维护者通过 GitHub API 或 Actions UI 针对选定 ref 启动 CI。`e2e.yml` 仍接受 push、schedule 与 dispatch；除非仓库是 `deepseek-ai/deepseek-harness`，其作业会跳过。

`main` 分支保护仍要求拉取请求、解决评审对话，以及 [自动化拉取请求治理](2026-08-16-automation-pull-request-governance.zh.md) 中记录的管理员推送允许清单。它不要求 Actions 状态检查。[issue-lifecycle.yml](../../../../.github/workflows/issue-lifecycle.yml) 与 [issue-policy.yml](../../../../.github/workflows/issue-policy.yml) 仍监听拉取请求事件；它们是 GitHub 项目管理自动化，不是 16 核 CI 矩阵。诸如[可移植拉取请求 CI](2026-07-23-portable-required-pull-request-ci.zh.md) 的规范仓库笔记继续描述上游政策；本 overlay 与之分离，`downstream/upstream-baseline.json` 记录 `.github/workflows` 通用补丁。

## Alternatives considered

**保留自动拉取请求 CI，只去掉必需检查。** 合并可以继续，但每次 synchronize 仍会排队 16 核矩阵并消耗额度。

**为仓库禁用 GitHub Actions。** 这也会挡住 `workflow_dispatch`，维护者便无法通过 API 启动 CI。

**工作流仍监听 `pull_request`，用 `if: false` 跳过每个作业。** GitHub 仍会启动工作流。`all checks passed` 把被跳过的必需工作作业视为失败，检查面板会保持红色。

**保留必需检查并等待运行器分配。** 本 overlay 无法使用 `dsh-ubuntu-24-04-16core`，等待不会结束。

## Consequences

打开或更新拉取请求不会启动 CI、e2e、landlock 或 release-pack 工作流。除非维护者派发 CI，本 overlay 的正确性证据来自本地。合并 `main` 不等待 GitHub Actions。下一次合入上游工作流时必须重新应用本 overlay。
