# Agent Note: 桌面模型选择器保持已发布的账户路由

Status: implemented

[English](2026-08-21-desktop-model-selection-stability.md) | 中文

## Problem

桌面模型选择器反应慢、点击会被丢掉，并且看起来无法持久化。四条彼此独立的竞态会表现为同一组产品症状。

周期性账户刷新（包括窗口重新获得焦点时的 resume）会在确认目录之前撤回 `acosmi` LLM 路由。这会发出 `llm/adapters-updated`，清空会员分组，并在随后的网络确认重新发布路由之前，把当前选择标为不可路由。

每次 `session.models` 都通过实时托管模型拉取列出 Acosmi 模型，然后再对每一行做一次解析。因此即使已配置官方 DeepSeek API Key，打开选择器也会等待账户服务。

`ModelDirectory` 把目录加载和 `session.selectModel` 放在同一个代次里。保存选择会写入默认模型 settings 文档，从而立即重载每一份目录。较慢的进行中 select 会被丢弃，composer 触发器于是回到上一个标签。

交互登录后，若第一次自动路由因为账户路由尚未发布而失败，账户 UI 会在之后每一次会话列表更新时重试。这会把用户选择覆盖成第一个已公布的 Acosmi 模型。已确认缺失的 DeepSeek API Key 应当拦截；进行中的凭据读取也被发布为 blocked，因此默认的 `deepseek-official` 会话会在启动期间锁住 composer。

## Decision

`llm-acosmi` 在后续 `ready` 快照中保持已发布的 `acosmi` 路由。它刷新适配器持有的目录缓存，并且只在路由活动实际变化时才注册或替换：首次发布、离开 `ready` 或失去全部可选模型时撤回，以及撤回后再发布。流式派发仍对照实时目录校验。退出登录、安全存储失败和插件卸载仍会中止已准入的流并清空缓存。

`ModelDirectory` 为加载和选择保留彼此独立的代次。目录重载会等待进行中的 select，并且不能替换其已接受的结果。连接重置仍会使两个代次失效并重新拉取 Host 选择。共享目录与 Host 持久化规则见[会话模型选择器 Agent Note](../feature/2026-07-24-web-session-model-selector.zh.md)。

登录时的路由仅在未配置官方 API Key、且当前会话仍使用 `deepseek-official` 时，选择第一个已公布的 Acosmi 模型。它通过目录 store 等待 Host 发布账户分组，并在成功或超时后清除挂起标志，因此之后的会话列表更新不能覆盖用户选择。

官方 DeepSeek API 访问投影以 available 起步，仅在确认缺少或无法读取 Key 后才拦截该分组。`session.selectModel` 仍会保存 Agent 默认值；尚未进入请求的选择对该会话保持进程内有效，并成为之后空白会话的默认值。

## Alternatives considered

**在每次账户快照时都撤回路由。** 这是防止迟到目录复活已退出登录路由的最简单 generation 安全做法，退出登录和非 `ready` 路径仍然如此。把它用在后续 `ready` 快照上，正是刷新期间选择器被清空的原因。

**在 Host 的 `session.models` 内缓存目录行。** 这会把 Acosmi 拉取成本对所有提供方隐藏。桌面产品拥有会员目录的生命周期，因此适配器缓存是更窄的所有者。

**在 API proxy 里把 `session.models` 串到 `selectModel` 之后。** 这也能阻止丢点击的竞态，包括其他提供方。客户端目录已经拥有代次，而 settings 文档重载是客户端事件。

**登录后一律强制第一个 Acosmi 模型，即使已配置官方 API Key。** 这会把 DeepSeek 模型从默认会话里藏起来。配置了官方 Key 的用户保留该路由；会员路由只是该 Key 缺失时的回退。

**在凭据状态返回前对官方路由失败关闭。** 这能防止在没有 Key 时短暂点到 DeepSeek Flash。它也会在每次状态读取期间锁住默认会话，包括可用的官方 Key，而这是更糟的 composer 失败。

## Consequences

窗口重新获得焦点时的刷新和五分钟账户轮询不再移除会员模型，也不会锁住已经位于 `acosmi` 上的 composer。确认目录之后打开选择器对该分组是一次缓存读取。Host 已接受的点击即使在默认模型 settings 重载目录后也会留在触发器上。登录仍会在路由存在后，把未配置官方默认的会话切到第一个账户模型，并且在该尝试结算后不再重试。

选择作为后续空白会话的 Agent 默认值仍然持久；只有请求消费它之后才会进入 `request/header`。在账户路由重新发布之前重启空白会话，触发器在确认完成前仍可能显示未设置标签。

聚焦测试覆盖：后续 `ready` 快照不发出第二次拓扑提交；目录列表使用已确认缓存；进行中的 select 能在随后的 load 中存活；登录路由会选择、跳过已配置的官方 Key，并在超时后不重试；官方 API 访问在凭据状态读取期间保持 available。
