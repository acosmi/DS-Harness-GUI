# Agent Note: 先做 DSH-GUI overlay 加固，再合入 0.1.1

Status: proposed

[English](2026-08-21-dsh-gui-overlay-hardening-and-rc2-merge.md) | 中文

Wave 0 overlay 加固与 Wave 1 合入 `dsh-v0.1.1-rc.2` 已在本树落地。Wave 2 法定身份与 Wave 3 签名更新源仍被发行账本阻断。在有记录证据之前，compatibility 保持 `implementation-in-progress`。

## Problem

DSH-GUI 是 DeepSeek Harness 上的私有 Electron overlay。overlay 生命周期、vault、身份 chrome 与合入改名缺陷属于同一次排序决策，而不是彼此孤立的补丁：只在 quit 处理器里检查 `stopping`，挡不住 `activate`、`render-process-gone` 或 ready 之后的 Host `fatal`；README 写签名构建启动时 fail-closed，但测试若把延后抛错写成合同，就约束不了 `resolveDesktopSecretPersistence`；只在 `ui-desktop` 里改 `credentials/updated`，合入后 `ui-settings-models` 与 `ui-settings-plugins` 会静默失效。2026-08-14 的产品发行提案仍拥有首发范围、法定名称和稳定版阻断项；它并不按缺陷类别对照上游标签做排序。

Wave 2 与 Wave 3 仍开放。账本仍记录 `compatibility.status: implementation-in-progress`、空的 `compatibility.evidence`，以及 `stableBlocked: true`。合入 `dsh-v0.1.1-rc.2` 并加固 overlay，不得当成签名发行已通过。不要把账本阻断项（SDK token-store 吞错、账户主体、OpenAI finish-reason、生产 OAuth 客户端、Apple 公证、Authenticode、签名更新源、法务文案、x64 矩阵）当成这份计划要关闭的 overlay 代码缺陷。

## Proposal

先完成 overlay 加固，再把 `dsh-v0.1.1-rc.2` 作为另一次变更合入；法定身份与更新闭环只在既有发行阻断项解除后才动。在有记录证据之前，不要把 `downstream/upstream-baseline.json` 的 compatibility 标成 `passed`。

本笔记不取代 2026-08-14 产品发行提案、[开发构建密钥选择](../../implemented/bug-fix/2026-08-20-development-build-secret-persistence.zh.md)、[助手身份](../../implemented/feature/2026-08-17-dsh-gui-assistant-identity.zh.md) 或 [模型选择稳定性](../../implemented/bug-fix/2026-08-21-desktop-model-selection-stability.zh.md)。

### Defect classes

| 类别 | 审计实例 | 同类仍开放的兄弟项 | 规则 |
|---|---|---|---|
| 生命周期在拆卸开始后仍分配 | `activate` 调用 `openWindow()` 且不看 `stopping` | `render-process-gone` 仍可能在 `before-quit` 进行中弹出重启对话框；`second-instance` 在窗口已毁时是空操作（安全）但未与 `activate` 共用同一拆卸守卫；`window-all-closed` 已经检查 `stopping` | 凡是会创建窗口、IPC 处理器或 utility 子进程的 Electron / Host 回调，在 `stopping` 为真时必须立即返回。`second-instance` 可以聚焦仍存活的窗口，不得调用 `openWindow()`。 |
| 文档写启动 fail-closed，实现拖到首次使用 | 签名 darwin/win32 在 `encryptionAvailable` 为假时仍选 `'os-protected'`；`ProtectedSecretVault.requireEncryption()` 在 get/set 才抛 | `DesktopUpdateOptions.mode` 含 `'automatic'` 却无定时、下载、安装；`checkForUpdates` 在进入渲染进程（以及任何安装器）之前丢掉已验证 artifact；Host 在 `ready` 之后的 `fatal` 只调用已经结算的 `readyReject` | 签名或已对外宣称的义务在构造调用处失败（`createSecretVault`、broker `fatal`、更新模式选择）。测试不得把延后失败路径冻成合同。 |
| 渠道身份与产品字面量分叉 | `DesktopProductInfo.productName` 是类型字面量 `'DSH-GUI'`；Canary 的 `oauthAppName` 仍是 `DSH-GUI` | 窗口标题、`dialog.showErrorBox`、`render-process-gone` 文案、`utilityProcess` 的 `serviceName` 都是 `'DSH-GUI'`，而该渠道的 `identity.productName` 是 `'DSH-GUI Canary'`；`tokenKey` 嵌入 `profile-default`，vault 却绑定随机 `profileId`；`displayNameZh` 在法律品牌阻断下仍是 `DeepSeek Harness 桌面端` | 运行时 chrome（窗口、对话框、utility 服务名、OAuth 应用名）读取 `identity.productName`。本计划不改 `displayNameZh` 或身份账本。在有已认证账户主体之前，不要把 `profileId` 写入 `tokenKey`。 |
| 合入时改名会静默失效 | overlay bootstrap 使用 `installConnectionCarrier` / `Symbol.for('@deepseek-ai/dsh-client-connection/carrier')` | 生产环境 `$on('credentials/updated')` 监听方：`downstream/packages/ui-desktop`、`packages/client/ui-settings-models`、`packages/client/ui-settings-plugins`；桌面 `cordis.patch.yml` 的 `llm-deepseek.models` 只列 Flash 与 Pro，因此合入后即使上游默认目录新增 Vision，桌面仍会盖住它 | 合入时对整棵树 grep 旧事件名与承运名。变基每一条 `genericPatches`，包括 `packages/client/ui-conversation` 与 `packages/client/ui-model-selection`。若采用上游 Vision 默认值，把 `deepseek-v4-flash-vision-exp` 写入桌面 patch。把 web-app 的 `ui-attachment` 与 `ui-reference` 客户端插件复制进冻结的桌面允许清单，使 Vision 摄入与 composer `@` 引用占用 Host 名册的 slot。 |
| 构建解析上游内部路径 | `downstream/apps/desktop/vite.config.ts` 把若干 `@deepseek-ai/dsh-client-*` 包 alias 到 `packages/**/src`，配置还 import `packages/client/web/src/platform.ts` | `downstream/AGENTS.md` 禁止 `packages/**/src` 导入 | Vite alias 列表保持封闭。禁止增行。当 shell 包提供所需入口时优先用 public exports。不要因为重写 Vite 而阻塞 0.1.1 合入。 |

### Wave 0 — 在合入 0.1.1 之前加固 overlay

不合上游。不依赖签名凭证。

1. **拆卸守卫。** `stopping` 为真时 `activate` 直接返回。`stopping` 为真时 `render-process-gone` 不弹出重启对话框。补一条聚焦测试：在 `before-quit` 置位之后驱动 `activate`，断言不再创建第二个 `BrowserWindow`、不再二次注册 IPC。
2. **签名 vault 在构造时失败。** 签名 darwin/win32 在 `encryptionAvailable` 为假时由 `resolveDesktopSecretPersistence` 抛错，与签名 Linux 弱后端拒绝对齐。`createSecretVault` 不得返回会在第一次操作才失败的 `ProtectedSecretVault`。替换当前要求「签名 + 加密不可用仍选 `'os-protected'`」的 secret-persistence 规格。
3. **ready 之后的 Host fatal。** `ready` 已结算后的 `fatal` 启动 `shutdown()`（销毁窗口、停止接受 Host 操作、杀掉 utility 子进程）。不得依赖 `readyReject`。
4. **渠道 chrome。** 窗口标题、启动与渲染进程消失对话框、以及 `serviceName` 使用 `identity.productName`。Canary `cordis.canary.patch.yml` 的 `oauthAppName` 为 `DSH-GUI Canary`。
5. **账本完整。** `genericPatches` 同时保留 conversation hero 槽与模型选择代次拆分。该行已在本笔记同一变更中恢复。
6. **模型选择。** 不要重开 [进行中的 select 与目录重载拆分](../../implemented/bug-fix/2026-08-21-desktop-model-selection-stability.zh.md)。Wave 1 变基该 generic patch。

### Wave 1 — 合入 `dsh-v0.1.1-rc.2`

与 Wave 0 分开。两个标签的 SQLite `SCHEMA_VERSION` 都是 17；不要把数据库当成硬拒绝。projection checkpoint 重放可能让一次重新打开变慢。

1. 合入该标签（或该标签处的 `upstream/master`），保留 overlay 历史。
2. **承运。** 若 `mountDesktopRenderer` 能在 `AppWebEntry.run()` 之前安装官方页全局运输钩子，则优先用它。仅当该钩子无法承载 Electron IPC 时，才保留 `packages/client/connection` generic patch。若合入提高了上游客户端 body 上限，`MAX_DESKTOP_BODY_BYTES` 跟随该上限。
3. **凭据事件。** 在同一提交里把每一处生产与测试监听从 `credentials/updated` 改到 0.1.1 的名称。缺监听是 API Key 与网页搜索状态静默过期，不是类型错误。
4. **桌面模型 patch。** 合入采用上游 Vision 默认值时，向 `downstream/bundles/desktop/cordis.patch.yml` 的 `llm-deepseek.models` 加入带 `inputModalities: [text, image]` 的 `deepseek-v4-flash-vision-exp`。Files API 图像上传随 `llm-deepseek` 包落地；不要在 `downstream/` 里重写一份。
5. **Generic patches 与冻结图。** 变基 connection、modules、typert generator、`tsdown.client.ts`、ui-sidebar、ui-conversation、ui-model-selection、loader CSP eval、以及 workspace-integration。若 conversation patch 仍只替换 hero 槽，则 composer `@` 编辑、多行 `ask_user_question`、宽 markdown 表、子代理血缘标题随上游 `packages/client/ui-*` 进入。打包 renderer 图来自允许清单，而不是 Host 模块扫描：接纳 `@deepseek-ai/dsh-client-ui-attachment` 与 `@deepseek-ai/dsh-client-ui-reference`。Vite alias 列表保持封闭。
6. **基线。** 把 `upstream.commit` 设为合入标签，刷新 `lockfile.sha256` 与 `synchronizedAt`；在附上 Wave 1 验收证据之前，`compatibility.status` 保持 `implementation-in-progress`。桌面应用 `version` 与渠道 `productVersion` 与上游标签对齐。

### 已落地清单

- `downstream/upstream-baseline.json` 的 `upstream.commit` 为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（`dsh-v0.1.1-rc.2`）。根清单、桌面应用与渠道 `productVersion` 均为 `0.1.1-rc.2`。`compatibility.status` 仍为 `implementation-in-progress`。
- 拆卸策略位于 `desktopActivateAction` / `canFocusExistingWindow` / `shouldPromptRendererRestart`。签名持久化在 `resolveDesktopSecretPersistence` 抛错。`ready` 之后的 Host `fatal` 启动 `shutdown()`。Canary 的 OAuth 与窗口 chrome 使用 `identity.productName`。`DesktopProductInfo.updateMode` 为 `'disabled' | 'manual'`。
- `mountDesktopRenderer` 安装 `__DSH_TRANSPORT__`。connection generic patch 把 `app:` 视为回环。`clientBootAssets()` 封装 `bootInjections`，供打包 facade 使用。`MAX_DESKTOP_BODY_BYTES` 为 300 MiB。
- 生产监听使用 `credentials/reference-updated`。桌面 DeepSeek patch 包含带图像输入的 Vision。允许清单包含 `ui-attachment` 与 `ui-reference`。Files API 代码仍在 `packages/llm/llm-deepseek`。

### Wave 2 — 仍由法务或 SDK 拥有的身份

在具名阻断项解除之前，不进入本计划的实现提交。

- `displayNameZh` 与身份账本保持 2026-08-14 产品发行提案已记录的值。
- 在 `acosmi-sdk-authenticated-account-subject` 能命名真实主体之前，`tokenKey` 继续使用 `profile-default`。注释与测试不得把该 token 写成 vault-profile 隔离。
- Acosmi 账户、LLM 适配器与账户 UI 仍是由固定桌面 bundle 插入的 Cordis 插件。它们不是用户可安装的 `dsh plugin --profile add` 包。出现第二个账户厂商才构成通用 `ctx.account` 身份服务的条件；单一消费方不够。

### Wave 3 — 签名更新闭环

被 `signed-update-origin-and-keys` 阻断。在有可信 feed 之前，`apps/desktop/src/main.ts` 继续省略 `update`，About 保持 `disabled`。有 feed 之后，在 main 上实现定时、下载、验签与安装；artifact URL 不得进入渲染进程。在该闭环真正运行之前，不要对外宣称 `updateMode: 'automatic'`，或先从类型中去掉 `'automatic'`。

## Alternatives considered

**先合 0.1.1，再修 overlay 竞态。** 否决。承运与事件改名已经会强制一次大变基。把未经测试的 quit/activate 竞态和延后的 vault 抛错叠上去，会分不清崩溃来自哪棵树。

**一个 PR 同时合入、加固并关闭稳定版阻断项。** 否决。公证、Authenticode、法务文案和 SDK 主体不是 overlay 源码变更。

**丢掉 connection generic patch，等待上游提供 Electron 形态的承运。** 作为合入阻断项否决。官方 Web 使用页全局；桌面仍需要在 shell 挂载之前安装 IPC 的 bootstrap。若官方钩子已经足够，合入时可以删除 Symbol 承运。

**在任何其他 Wave 0 项之前先把 Vite 改成 public exports。** 作为排序否决。alias 列表是封闭的，渲染进程已经打包允许名单内的客户端插件。禁止扩表；重写不在合入关键路径上。

**把 Acosmi 登录做成用户可添加或省略的 Profile Bundle。** 否决。生产桌面只加载一份签名组合，且不进行远程代码加载（[downstream/AGENTS.md](../../../../downstream/AGENTS.md)）。灵活度是渠道 patch 省略 insert 行加上 `loginEnabled`，不是 `dsh plugin add`。

## Acceptance criteria

Wave 0 完成条件：`stopping` 期间的 `activate` 不创建窗口、不重装 IPC；签名 darwin/win32 在 `encryptionAvailable === false` 时从 `createSecretVault` / 持久化解析抛错且永不打开 UI；`ready` 之后的 Host `fatal` 拆掉 utility 子进程；Canary 的 OAuth 与窗口 chrome 使用 `DSH-GUI Canary`；`genericPatches` 同时列出 ui-conversation 与 ui-model-selection；聚焦测试覆盖拆卸与 vault 抛错；原先延后失败的持久化断言已删除。

Wave 1 完成条件：`mountDesktopRenderer` 能在合入后的承运上启动；API Key 与网页搜索设置会随新凭据事件刷新；若 Vision 是上游默认，桌面 DeepSeek patch 包含它；冻结允许清单包含 `ui-attachment` 与 `ui-reference`；Files API 代码位于 `packages/llm/llm-deepseek`；基线 `upstream.commit` 等于合入标签；桌面产品版本等于该标签；`compatibility.evidence` 仍为空或只列 Wave 1 检查，没有证据时绝不是 `passed`；改变模型或用户可见 Web chrome 的无密钥快照在该合入中更新。

Wave 2 与 Wave 3 在对应账本阻断项仍为 `blocked` 时保持未完成。Wave 0 或 Wave 1 的合入不得把 `releaseReadiness.stableBlocked` 翻成 false。

## Risks

`packages/client/connection` 与 `packages/client/ui-conversation` 的变基可能在一次提交里失败；停下来拆分，而不是把手动政策解进 overlay 包。

ui-model-selection 代次拆分是 generic patch。0.1.1 若重写上游 directory，可能冲突；保留进行中的 `selectModel` 对重载的合同，而不是精确文件布局。

合入后 projection checkpoint 重放可能让既有会话库的第一次重新打开变慢，且不改变 `SCHEMA_VERSION`。

跟随 `identity.productName` 的渠道 chrome 仍会把 About 的 `displayNameZh` 留在法律品牌字符串上。在法务改账本之前，这种分叉是有意的。

Wave 0 让没有 OS 加密的签名构建 fail-closed，这些机器将无法登录。这是已文档化的签名合同，不是新的可用性目标。

打包 renderer 图不扫描 Host Loader。只在 DeepSeek patch 接纳 Vision、却不把 `ui-attachment` 写入允许清单，会让 composer 图像 slot 保持为空。
