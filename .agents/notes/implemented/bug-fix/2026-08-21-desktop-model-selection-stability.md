# Agent Note: desktop model selector stays on the published account route

Status: implemented

English | [中文](2026-08-21-desktop-model-selection-stability.zh.md)

## Problem

The desktop model selector was slow, dropped clicks, and appeared not to persist. Four independent races produced the same product symptoms.

Periodic account refresh, including window-focus resume, withdrew the `acosmi` LLM route before confirming the catalog. That emitted `llm/adapters-updated`, emptied the membership group, and marked the current selection unroutable until a later network confirmation republished the route.

Every `session.models` call listed Acosmi models through a live managed-model fetch, then resolved each row again. Opening the selector therefore waited on the account service even when the official DeepSeek API key was configured.

`ModelDirectory` used one generation for both catalog loads and `session.selectModel`. Saving a selection writes the default-model settings document, which immediately reloads every directory. A slower in-flight select was discarded, so the composer trigger reverted to the previous label.

After interactive sign-in, the account UI kept retrying automatic routing on every session-list update when the first attempt failed because the account route was not yet published. That later overwrote a user selection with the first advertised Acosmi model. A confirmed-missing DeepSeek API key is a block; an in-flight credential read was also published as blocked, so the default `deepseek-official` session locked the composer during startup.

## Decision

`llm-acosmi` leaves a published `acosmi` route in place across later `ready` snapshots. It refreshes an adapter-owned catalog cache, then registers or replaces the route only when activity actually changes: first publication, withdrawal on leaving `ready` or losing every selectable model, and republication after withdrawal. Stream dispatch still validates against a live catalog. Logout, secure-storage failure, and plugin disposal still abort admitted streams and clear the cache.

`ModelDirectory` keeps separate load and select epochs. A catalog reload waits for an in-flight select and cannot replace its accepted result. Connection reset still invalidates both epochs and repulls the Host selection. See the [session model selector Agent Note](../feature/2026-07-24-web-session-model-selector.md) for the shared directory and Host persistence rules.

Login-time routing selects the first advertised Acosmi model only when the official API key is absent and the current session still uses `deepseek-official`. It waits on the directory store for the Host to publish the account group, then clears the pending flag after success or timeout so a later session-list update cannot overwrite a user choice.

The official DeepSeek API access projection starts available and blocks that group only after a confirmed missing or unreadable key. `session.selectModel` continues to save the Agent default; a selection that has not reached a request remains process-local for that session and becomes the default for later blank sessions.

## Alternatives considered

**Keep withdrawing the route on every account snapshot.** That is the simplest generation-safe way to prevent a late catalog from reviving a signed-out route, and it remains the logout and non-ready path. Applying it to later `ready` snapshots is what emptied the selector during refresh.

**Cache catalog rows inside `session.models` on the Host.** That would hide Acosmi fetch cost from every provider. The desktop product owns the membership catalog lifetime, so the adapter cache is the narrower owner.

**Serialize `session.models` behind `selectModel` in the API proxy.** That would also stop the discarded-click race, including for other providers. The client directory is the surface that already owns generation, and the settings-document reload is a client event.

**Always force the first Acosmi model after sign-in, including when an official API key exists.** That would hide DeepSeek models from the default session. Users who configure the official key keep that route; membership routing is only the fallback when that key is absent.

**Fail closed on the official route until credential status returns.** That prevents a brief click on DeepSeek Flash without a key. It also blocks the default session during every status read, including a working official key, which is the worse composer failure.

## Consequences

Window-focus refresh and the five-minute account poll no longer remove membership models or lock a composer that is already on `acosmi`. Opening the selector after a confirmed catalog is a cache read for that group. A click that the Host accepted stays on the trigger even when default-model settings reload the directory. Sign-in still moves an unconfigured official-default session onto the first account model once the route exists, and it does not keep retrying after that attempt settles.

A selection is still durable as the Agent default for later blank sessions, and as `request/header` only after a request consumes it. Restarting a blank session before the account route is republished can still show the unset trigger label until confirmation completes.

Focused tests cover: later `ready` snapshots do not emit a second topology commit; directory listing uses the confirmed cache; an in-flight select survives a later load; login routing selects, skips a configured official key, and does not retry after timeout; official API access stays available while credential status is in flight.
