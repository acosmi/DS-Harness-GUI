# @acosmi/dsh-account-acosmi

English | [中文](README.zh.md)

Private DSH-GUI account service that owns the pinned Acosmi SDK client, desktop OAuth, encrypted TokenStore access, account projection, and authorization lifetime consumed by `@acosmi/dsh-llm-acosmi`.

## Configuration

`tokenKey`, `loginEnabled`, `gatewayBaseUrl`, `oauthAppName`, `loginTimeoutMs`, `logoutTimeoutMs`, `refreshIntervalMs`, `refreshJitterMs`, `refreshTimeoutMs`, `projectionPollIntervalMs`, and `productVersion` are required. Refresh jitter cannot exceed the base interval. The service accepts only the production `https://acosmi.com` origin, validates the SDK discovery document against exact HTTPS endpoints, and requests only the SDK `ai` scope. Stable and canary bundles supply distinct token keys.

## Lifecycle and failure semantics

Startup probes TokenStore `load()` before creating a client. The completed preflight value is served throughout SDK construction and only then switches back to live vault access, so an SDK-internal second read cannot suppress a new storage failure and masquerade as signed-out state. Unavailable or corrupt secure storage produces an independent `unavailable` snapshot instead of signed-out state. Subscriptions synchronously receive a detached current snapshot before later changes.

Every SDK client enables automatic ephemeral-history stripping before it can be published. Before a later managed-model request, the SDK removes prior assistant blocks marked `acosmi_ephemeral: true` and their linked tool results, so provider-owned server-search state does not leak into later turns.

Interactive login is single-flight. The main process validates and opens exactly one SDK authorization URL; browser acceptance must settle before login succeeds. Cancellation or deadline expiry during the post-login account projection rolls back the new authorization instead of reporting a late success. The pinned `@acosmi/sdk-ts@2.17.0` generates a high-entropy OAuth `state`, requires exactly one matching callback value before consuming either a code or OAuth error, and closes its loopback listener on every terminal path. While authorized, account projection refresh is also single-flight, bounded by `refreshTimeoutMs`, and rescheduled after each completion at `refreshIntervalMs` plus randomized delay up to `refreshJitterMs`. The client-safe snapshot carries `projectionPollIntervalMs` so the account page can read the latest Host projection without SDK push support. Logout rejects a new login, cancels and awaits any active login, aborts the SDK-session signal, clears local credentials, and only then attempts remote revocation within `logoutTimeoutMs`. Account refresh and model discovery revalidate their captured SDK session and combined AbortSignal after provider calls settle, so a transport that ignores cancellation cannot overwrite a signed-out snapshot or return the previous account's catalog after replacement. Logout, client replacement, and service disposal stop scheduled refresh; disposal settles even when a provider operation ignores cancellation. Local deletion failure is terminal and never reports signed-out; a remote timeout keeps the signed-out result but reports that revocation is unconfirmed.

A failed account action carries a required `reason` from a closed client-safe set. Login maps the SDK's stable `LoginEvent.err_code` values to discovery, registration, browser-open, authorization-denied, authorization-timeout, token-exchange, TLS-proxy, and state-mismatch reasons; the product `loginTimeoutMs` deadline also maps to `authorization-timeout`. Secure-storage and lifecycle failures use separate reasons. No SDK error text, authorization URL, callback parameter, account identifier, or token enters the result, and renderer presentation continues to select fixed copy from the coarse action code.

`sdkSession()` pairs the current SDK client with an AbortSignal. Logout, secure-storage failure, client replacement, or service disposal aborts that signal so consumers cannot keep billing work alive under withdrawn local authorization. Token-store reads, writes, validation, and clears raise a dedicated same-process error even though the main-process bridge suppresses vault details; account classification also recognizes the SDK's fixed `save tokens:` wrapper but never treats arbitrary provider text mentioning a token store as storage evidence. Disposal prevents a late startup or login completion from publishing a new client after teardown. Remote and renderer results contain fixed public copy rather than SDK, OAuth, account, or token details.

## Model Experience

### Account authorization

#### What the model sees

No account, membership, quota, token, or OAuth data. This package only controls whether the separate `acosmi` LLM adapter may accept a request.

#### Token effect

Zero direct tokens. The provider adapter owns every model-visible request field and session replay record.

#### KV Cache effect

Account changes add no prompt prefix. Authorization withdrawal aborts active provider requests; a later authorization starts independent requests and does not revive prior cache assumptions.

## Known Limitations and Deferred Work

- Published `@acosmi/sdk-ts@2.17.0` closes the native OAuth `state` defect, and the former local dist patch has been removed. The same published package still catches refresh-rotation `TokenStore.save()` and invalid-token `TokenStore.clear()` failures, logs the underlying storage message, and continues instead of propagating a stable failure. Signed production login remains fail-closed until those paths invalidate the in-memory client and reject the operation.
- The SDK `TokenSet` exposes no stable account subject. Current bundle keys therefore end in `account-current`; subject-partitioned persistence and account-switch migration remain blocked on an SDK or authenticated account-identity contract.
