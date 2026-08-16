# Agent Note: 仓库自动化通过管理员合并的 PR 进入默认分支

Status: implemented

[English](2026-08-16-automation-pull-request-governance.md) | 中文

## Problem

具备仓库写权限的自动化需要足以发布持续工作，但不能获得绕过人工评审的路径。直接写默认分支会把提案与接受折叠成一个动作，而全局可写的 Actions token 会让无关工作流获得其不使用的权限。PR（Pull Request）路径还必须在无法创建提案时明确失败，不能让已完成工作只停留在未经评审的分支上。

## Decision

自动化创建或更新唯一命名的 `codex/automation/<task>` 分支。推送到该前缀会运行 [Open automation pull request](../../../../.github/workflows/automation-pull-request.yml)：它查找确切 head 与默认 base 之间已开启的 PR，不存在时创建 draft PR。后续推送通过 GitHub 的普通分支语义更新该 PR。工作流不会检出代码、改写分支、提交评审、启用自动合并或执行合并。

仓库将默认 `GITHUB_TOKEN` 权限保持为只读，并在仓库级允许 GitHub Actions 创建 PR。只有提案工作流授予 `pull-requests: write`，同时保留 `contents: read`。仓库测试扫描全部工作流，拒绝另一项 PR 写入方，把本工作流的 GitHub CLI 动词固定为 PR 列举与创建，并拒绝直接调用 Git。

`main` 保护规则要求所有主体（包括管理员）都通过 PR，要求 `e2e` 与 `all checks passed`，要求解决评审对话，并禁止强制推送和删除。其推送限制允许清单为空，因此只有仓库管理员能够更新分支，但管理员仍须满足 PR 与检查要求。批准数保持为零，避免只有一名管理员的仓库死锁；由管理员执行合并就是人工接受步骤。必需检查的拓扑仍由[可移植 PR CI 决策](2026-07-23-portable-required-pull-request-ci.md)规定。

使用 `GITHUB_TOKEN` 创建的 PR 会进入 GitHub 要求批准后才运行工作流的状态。管理员启动检查、评审结果并执行合并；自动化永不批准自己的提案。这延伸了仓库现有的[依赖更新策略](2026-07-27-dependabot-version-updates.md)，后者同样把自动提案与维护者接受分开。

## Verification

聚焦工作流测试解析触发器、并发键、精确权限、已有 PR 路径、draft 创建路径、完整 GitHub CLI 动词集合以及不存在直接 Git 调用。仓库文档检查验证这对决策记录及其链接。对仓库设置的实时读取会验证管理员强制执行、必需状态上下文、禁止删除与强制推送、Actions 默认只读权限以及允许创建 PR 的开关。

## Alternatives considered

**允许自动化推送默认分支。** 拒绝，因为分支保护、CI、评审与管理员接受都会发生在仓库已经改变之后。

**检查通过后启用自动合并。** 拒绝，因为检查通过只提供证据，不会替仓库作出接受决策；合并仍由管理员负责。

**为每个工作流 token 授予读写权限。** 拒绝，因为无关工作流会获得仓库改写权限。唯一的提案工作流只获得一项写权限。

**使用专用 GitHub App installation token。** 这可以把提案创建与 GitHub Actions 的“创建或批准”组合开关分开，也能在无需人工批准的情况下启动 PR 工作流，但会新增 App 私钥与安装生命周期。对于当前自动化规模，短期仓库 token 加管理员启动检查所需的凭据系统更小。

**由托管自动化改写提案分支。** 本机制拒绝该方案。现有自动化已经拥有自己的检出目录与分支写权限；托管任务只创建缺失的 PR metadata。这保留了[自动配对合并](2026-08-08-automatic-translation-pairing-merges.md)不由托管端改写分支的决策。

## Consequences

持续自动化会把 commit 累积到一个可评审的 draft 中，而不是改变 `main`。管理员对新提案执行两个明确动作——启动工作流，并在取得必需证据后合并——因此刻意不提供无人值守的接受路径。`codex/automation/**` 以外的分支沿用现有手动 PR 流程。仓库级“创建或批准”开关比本工作流的行为更宽，因此工作流权限测试与默认只读 token 仍是必需控制。
