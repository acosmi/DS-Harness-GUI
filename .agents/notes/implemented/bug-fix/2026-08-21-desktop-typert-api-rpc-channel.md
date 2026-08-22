# Agent Note: packaged desktop admits Typert `/api` remotes

Status: implemented

English | [中文](2026-08-21-desktop-typert-api-rpc-channel.zh.md)

## Problem

Typert remotes share Connection's `/api` RPC channel: the client gateway posts `rpc.call('/api', '<namespace>/<method>')`. On the packaged `app:` renderer, `location.origin` is `"null"`, so that call is rewritten to `app://dsh-gui/api/<namespace>/<method>`.

The desktop generic unary fetch rejected every `/api/` path so that API Proxy methods and event streams would stay on `ElectronApiClient`. Account settings (`acosmiAccount.describe`) and the plugin inventory tab (`pluginInventory.list`) therefore failed in the renderer before IPC, with a generic unavailable error, while sessions and models that use API Proxy still worked. Host `DesktopHostConnection.fetch` already splits the same `/api` channel: Typert Gateway intercepts two-segment endpoints and unclaimed methods fall back to API Proxy. IPC path validation already admits three-segment application paths.

A retry on the account page cleared the error, hid the retry control, and showed no loading state. Window focus and visibility resume could start a second `load()` and drop the in-flight generation.

## Decision

Generic unary RPC (`desktopRpcFetch` / `assertDesktopUnaryTarget`) admits overlay channels and Typert `/api/<namespace>/<method>` paths (pathname at least `api` plus two endpoint segments). It rejects API Proxy single-segment `/api/<method>` posts and `/api/events.*` streams, which remain on `ElectronApiClient` for secret-envelope redaction and pull streams. The client gateway channel stays `/api`; desktop does not add a private overlay RPC channel.

The [Typert remote method-call Agent Note](../architecture/2026-08-02-typert-remote-method-calls.md) remains the owner of that `/api` channel. This note owns only the desktop carrier admission that must carry it.

Account projection retry keeps the previous error until the next result settles, shows a loading status while `phase` is `loading`, and leaves the retry control visible and disabled for that interval. `load()`, `resume()`, and `act()` return when `phase` is `loading`; `resume()` and `act()` also return when `busy` is set, so focus, visibility, poll, and action clicks do not increment generation over an in-flight `describe()`.

## Alternatives considered

**Move Typert remotes off `/api` on desktop only.** Rejected because it would fork the packaged product from the web Connection contract and from the existing gateway client, which always calls `rpc.call('/api', endpoint)`.

**Send Typert remotes through `ElectronApiClient`.** Rejected because that client treats GET as an event stream and owns API Proxy envelope redaction. Remotes are JSON POST envelopes on the generic RPC fetch hook.

**Keep rejecting `/api/` and invent an overlay channel such as `/acosmi`.** Rejected because `pluginInventory` and other Host remotes are not overlay-specific; they already use the shared `/api` channel.

## Verification

Carrier tests post `rpc.call('/api', 'pluginInventory/list')` and `rpc.call('/api', 'acosmiAccount/describe')` and expect `app://dsh-gui/api/...` IPC URLs; `desktopRpcFetch` of `/api/host.describe` and `/api/events.mux` throws. Host tests intercept `/api/pluginInventory/list` and fall back for `/api/host.describe`. Account store tests keep an in-flight `load()` across `resume()`, a second `load()`, and `act('refresh')`, and retain the previous error during retry. The account section test renders a disabled retry control and `aria-busy` while loading after a failure.

## Consequences

Packaged Settings pages that call Typert remotes reach the Host the same way the web client does. API Proxy unary methods and the two event streams stay exclusive to `ElectronApiClient`. Without the three-segment `/api` admission, every Typert remote fails closed in the renderer with no Host log. Retry keeps the previous error and a loading status until the next snapshot.
