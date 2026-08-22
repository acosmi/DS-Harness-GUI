# Agent Note: packaged desktop admits Typert `/api` remotes

Status: implemented

[English](2026-08-21-desktop-typert-api-rpc-channel.md) | 中文

## Problem

Typert Remote 共用 Connection 的 `/api` RPC 通道：客户端网关发送 `rpc.call('/api', '<namespace>/<method>')`。打包后的 `app:` renderer 上 `location.origin` 为 `"null"`，该调用会被改写成 `app://dsh-gui/api/<namespace>/<method>`。

桌面通用一元 fetch 拒绝一切 `/api/` 路径，以便 API Proxy 方法与事件流留在 `ElectronApiClient`。因此账户设置（`acosmiAccount.describe`）和插件列表标签页（`pluginInventory.list`）在发 IPC 之前就于 renderer 失败，只显示泛化的不可用错误；走 API Proxy 的会话和模型仍然可用。Host 的 `DesktopHostConnection.fetch` 已在同一 `/api` 通道上分流：Typert Gateway 认领两段 endpoint，未认领的方法回落到 API Proxy。IPC 路径校验也已允许三段应用路径。

账户页的重试会清掉错误、卸掉重试控件，且没有加载态。窗口焦点与可见性恢复可能再开一次 `load()`，并丢掉进行中的 generation。

## Decision

通用一元 RPC（`desktopRpcFetch` / `assertDesktopUnaryTarget`）允许 overlay 通道以及 Typert 的 `/api/<namespace>/<method>` 路径（pathname 至少为 `api` 加上两段 endpoint）。它拒绝 API Proxy 的单段 `/api/<method>` POST 与 `/api/events.*` 流，这些继续走 `ElectronApiClient`，以保留密钥信封剥离与 pull 流。客户端网关通道保持 `/api`；桌面不另开私有 overlay RPC 通道。

[`Typert` Remote 方法调用 Agent Note](../architecture/2026-08-02-typert-remote-method-calls.zh.md) 仍拥有该 `/api` 通道。本笔记只拥有必须承载该通道的桌面 carrier 准入。

账户投影重试会保留上一次错误直到下一次结果落地，在 `phase` 为 `loading` 时显示加载状态，并在该区间内保持重试控件可见且禁用。`load()`、`resume()` 和 `act()` 在 `phase` 为 `loading` 时直接返回；`resume()` 和 `act()` 在已设置 `busy` 时也直接返回，因此焦点、可见性、轮询和操作点击不会在进行中的 `describe()` 上递增 generation。

## Alternatives considered

**仅在桌面把 Typert Remote 移出 `/api`。** 否决，因为它会使打包产品偏离 web Connection 约定，以及始终调用 `rpc.call('/api', endpoint)` 的现有网关客户端。

**把 Typert Remote 改走 `ElectronApiClient`。** 否决，因为该客户端把 GET 当作事件流，并拥有 API Proxy 信封剥离。Remote 是通用 RPC fetch 钩子上的 JSON POST 信封。

**继续拒绝 `/api/`，另开例如 `/acosmi` 的 overlay 通道。** 否决，因为 `pluginInventory` 和其他 Host Remote 并非 overlay 专有，它们已经使用共享的 `/api` 通道。

## Verification

Carrier 测试会 POST `rpc.call('/api', 'pluginInventory/list')` 和 `rpc.call('/api', 'acosmiAccount/describe')`，并期望 IPC URL 为 `app://dsh-gui/api/...`；对 `/api/host.describe` 和 `/api/events.mux` 的 `desktopRpcFetch` 会抛错。Host 测试会拦截 `/api/pluginInventory/list`，并对 `/api/host.describe` 走回落。账户 store 测试会在 `resume()`、第二次 `load()` 和 `act('refresh')` 期间保持进行中的 `load()`，并在重试时保留上一次错误。账户分区测试会在失败后的加载期间渲染禁用的重试控件和 `aria-busy`。

## Consequences

调用 Typert Remote 的打包设置页与 web 客户端一样能到达 Host。API Proxy 一元方法与两条事件流专属于 `ElectronApiClient`。若不允许三段 `/api` 路径，所有 Typert Remote 都会在 renderer 失败关闭，且 Host 无日志。重试会保留上一次错误和加载状态，直到下一份快照。
