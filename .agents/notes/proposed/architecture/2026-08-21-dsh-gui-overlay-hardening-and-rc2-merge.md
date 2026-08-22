# Agent Note: Sequence DSH-GUI overlay hardening before the 0.1.1 merge

Status: proposed

English | [中文](2026-08-21-dsh-gui-overlay-hardening-and-rc2-merge.zh.md)

Wave 0 overlay hardening and Wave 1's merge of `dsh-v0.1.1-rc.2` are implemented on this tree. Wave 2 legal identity and Wave 3's signed update feed remain blocked by the release ledger. Compatibility stays `implementation-in-progress` until recorded evidence exists.

## Problem

DSH-GUI is a private Electron overlay on DeepSeek Harness. Overlay lifecycle, vault, identity-chrome, and merge-time rename defects belong to one sequencing decision rather than isolated patches: a quit handler that checks `stopping` does not protect `activate`, `render-process-gone`, or a post-ready Host `fatal`; a README that says signed builds fail closed at startup does not constrain `resolveDesktopSecretPersistence` if tests encode the late throw; a `credentials/updated` rename in `ui-desktop` leaves `ui-settings-models` and `ui-settings-plugins` silent after merge. The product distribution proposal dated 2026-08-14 still owns first-release scope, legal names, and stable blockers; it does not sequence these overlay classes against an upstream tag.

Wave 2 and Wave 3 remain open. The ledger still records `compatibility.status: implementation-in-progress`, empty `compatibility.evidence`, and `stableBlocked: true`. Merging `dsh-v0.1.1-rc.2` and hardening the overlay must not be treated as a signed-release pass. Do not treat ledger blockers (SDK token-store swallow, account subject, OpenAI finish-reason, production OAuth client, Apple notarization, Authenticode, signed update origin, legal copy, x64 matrices) as overlay code bugs this plan closes.

## Proposal

Land overlay hardening first, then merge `dsh-v0.1.1-rc.2` as a separate change, then touch legal identity and the update loop only when their existing release blockers move. Do not mark `downstream/upstream-baseline.json` compatibility `passed` until recorded evidence exists.

This note does not supersede the 2026-08-14 product distribution proposal, [development vault selection](../../implemented/bug-fix/2026-08-20-development-build-secret-persistence.md), [assistant identity](../../implemented/feature/2026-08-17-dsh-gui-assistant-identity.md), or [model-selection stability](../../implemented/bug-fix/2026-08-21-desktop-model-selection-stability.md).

### Defect classes

| Class | Audit instance | Same-class siblings still open | Rule |
|---|---|---|---|
| Lifecycle events allocate after teardown starts | `activate` calls `openWindow()` with no `stopping` check | `render-process-gone` can still show a restart dialog while `before-quit` is running; `second-instance` is a no-op on a destroyed window (safe) but does not share a single teardown guard with `activate`; `window-all-closed` already checks `stopping` | Every Electron or Host callback that creates a window, IPC handler, or utility child must return immediately when `stopping` is true. `second-instance` may focus an existing live window and must not call `openWindow()`. |
| Fail-closed is documented at start and enforced at first use | Signed darwin/win32 persistence is `'os-protected'` even when `encryptionAvailable` is false; `ProtectedSecretVault.requireEncryption()` throws on get/set | `DesktopUpdateOptions.mode` includes `'automatic'` with no timer, download, or apply; `checkForUpdates` drops the verified artifact before the renderer (and before any installer); Host `fatal` after `ready` only calls an already-settled `readyReject` | A signed or advertised obligation fails at the constructing call (`createSecretVault`, broker `fatal`, update mode selection). Tests must not freeze the late-failure path as the contract. |
| Channel identity and product literals diverge | `DesktopProductInfo.productName` is the type literal `'DSH-GUI'`; Canary `oauthAppName` is `DSH-GUI` | Window title, `dialog.showErrorBox`, `render-process-gone` copy, and `utilityProcess` `serviceName` are `'DSH-GUI'` while `identity.productName` is `'DSH-GUI Canary'` on that channel; `tokenKey` embeds `profile-default` while the vault binds a random `profileId`; `displayNameZh` remains `DeepSeek Harness 桌面端` under the legal-brand blocker | Runtime chrome (window, dialog, utility service name, OAuth app name) reads `identity.productName`. Do not change `displayNameZh` or the identity ledger in this plan. Do not put `profileId` into `tokenKey` until an authenticated account subject exists. |
| Merge-time names fail silent | Overlay bootstrap uses `installConnectionCarrier` / `Symbol.for('@deepseek-ai/dsh-client-connection/carrier')` | Production `$on('credentials/updated')` listeners: `downstream/packages/ui-desktop`, `packages/client/ui-settings-models`, `packages/client/ui-settings-plugins`; desktop `cordis.patch.yml` `llm-deepseek.models` lists only Flash and Pro, so a merge that adds Vision in the upstream default directory still hides it | At merge, grep the whole tree for the old event and carrier names. Rebase every `genericPatches` row, including `packages/client/ui-conversation` and `packages/client/ui-model-selection`. Add `deepseek-v4-flash-vision-exp` to the desktop patch when taking the Vision default. Copy the web-app `ui-attachment` and `ui-reference` client plugins into the frozen desktop allowlist so Vision intake and composer `@` references occupy the Host roster's slots. |
| Build resolves upstream internals | `downstream/apps/desktop/vite.config.ts` aliases selected `@deepseek-ai/dsh-client-*` packages to `packages/**/src`, and the config imports `packages/client/web/src/platform.ts` | `downstream/AGENTS.md` forbids `packages/**/src` imports | Keep the Vite alias list closed. Do not add rows. Prefer public exports when the shell package exposes the needed entry. Do not block the 0.1.1 merge on a Vite rewrite. |

### Wave 0 — overlay hardening before the 0.1.1 merge

No upstream merge. Independent of signing credentials.

1. **Teardown guard.** `activate` returns when `stopping` is true. `render-process-gone` skips the restart dialog when `stopping` is true. Add a focused test that drives `activate` after `before-quit` has set the flag and asserts no second `BrowserWindow` and no second IPC registration.
2. **Signed vault at construct.** `resolveDesktopSecretPersistence` throws for signed darwin/win32 when `encryptionAvailable` is false, matching signed Linux weak-backend rejection. `createSecretVault` never returns a `ProtectedSecretVault` that will fail on the first operation. Replace the secret-persistence spec that currently requires signed + unavailable encryption to select `'os-protected'`.
3. **Host fatal after ready.** A `fatal` message after `ready` has settled starts `shutdown()` (destroy window, stop accepting Host operations, kill the utility child). It does not depend on `readyReject`.
4. **Channel chrome.** Window title, startup and renderer-gone dialogs, and `serviceName` use `identity.productName`. Canary `cordis.canary.patch.yml` `oauthAppName` is `DSH-GUI Canary`.
5. **Ledger completeness.** `genericPatches` retains both the conversation hero slot and the model-selection generation split. That row was restored in the same change as this note.
6. **Model selection.** Do not reopen [the in-flight select vs directory reload split](../../implemented/bug-fix/2026-08-21-desktop-model-selection-stability.md). Rebase that generic patch during Wave 1.

### Wave 1 — merge `dsh-v0.1.1-rc.2`

Separate change from Wave 0. SQLite `SCHEMA_VERSION` is 17 on both tags; do not treat the database as a hard reject. Projection checkpoint replay may slow one reopen.

1. Merge the tag (or `upstream/master` at that tag) with overlay history preserved.
2. **Carrier.** Prefer the official page-global transport hook if `mountDesktopRenderer` can install it before `AppWebEntry.run()`. Keep a generic `packages/client/connection` patch only when that hook cannot carry Electron IPC. `MAX_DESKTOP_BODY_BYTES` follows the upstream client body limit when the merge raises it.
3. **Credential events.** Rename every production and test listener from `credentials/updated` to the 0.1.1 name in the same commit. Absence of a listener is a silent API-key and web-search stale state, not a type error.
4. **Desktop model patch.** Add `deepseek-v4-flash-vision-exp` with `inputModalities: [text, image]` to `downstream/bundles/desktop/cordis.patch.yml` `llm-deepseek.models` when the merge takes the upstream Vision default. Files API image upload lands with the `llm-deepseek` package; do not reimplement it under `downstream/`.
5. **Generic patches and frozen graph.** Rebase connection, modules, typert generator, `tsdown.client.ts`, ui-sidebar, ui-conversation, ui-model-selection, loader CSP eval, and workspace-integration. Composer `@` editing, multiline `ask_user_question`, wide markdown tables, and subagent lineage headers ride upstream `packages/client/ui-*` if the conversation patch still only replaces the hero slot. The packaged renderer graph is the allowlist, not a Host module scan: admit `@deepseek-ai/dsh-client-ui-attachment` and `@deepseek-ai/dsh-client-ui-reference`. Keep the Vite alias list closed.
6. **Baseline.** Set `upstream.commit` to the merged tag, refresh `lockfile.sha256` and `synchronizedAt`, keep `compatibility.status` at `implementation-in-progress` until Wave 1 acceptance evidence is attached. Align the desktop application `version` and channel `productVersion` with the upstream tag.

### Landed inventory

- `downstream/upstream-baseline.json` `upstream.commit` is `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`). Root, desktop app, and channel `productVersion` are `0.1.1-rc.2`. `compatibility.status` remains `implementation-in-progress`.
- Teardown policy lives in `desktopActivateAction` / `canFocusExistingWindow` / `shouldPromptRendererRestart`. Signed persistence throws at `resolveDesktopSecretPersistence`. A Host `fatal` after ready starts `shutdown()`. Canary OAuth and window chrome use `identity.productName`. `DesktopProductInfo.updateMode` is `'disabled' | 'manual'`.
- `mountDesktopRenderer` installs `__DSH_TRANSPORT__`. The connection generic patch treats `app:` as loopback. `clientBootAssets()` wraps `bootInjections` for the packaged facade. `MAX_DESKTOP_BODY_BYTES` is 300 MiB.
- Production listeners use `credentials/reference-updated`. The desktop DeepSeek patch includes Vision with image input. The allowlist includes `ui-attachment` and `ui-reference`. Files API code remains in `packages/llm/llm-deepseek`.

### Wave 2 — identity that legal or SDK still owns

Out of this plan's implementation commits until the named blocker moves.

- `displayNameZh` and the identity ledger stay as the 2026-08-14 product distribution proposal recorded them.
- `tokenKey` keeps `profile-default` until `acosmi-sdk-authenticated-account-subject` can name a real subject. Comments and tests must not describe that token as vault-profile isolation.
- Acosmi account, LLM adapter, and account UI remain Cordis plugins inserted by the fixed desktop bundle. They are not a user-installable `dsh plugin --profile add` package. A second account vendor is the condition for a generic `ctx.account` identity service; one consumer is not.

### Wave 3 — signed update loop

Blocked on `signed-update-origin-and-keys`. Until a trusted feed exists, `apps/desktop/src/main.ts` continues to omit `update`, and About stays `disabled`. When a feed exists, implement timer, download, signature verify, and apply on main; keep artifact URLs off the renderer. Do not advertise `updateMode: 'automatic'` until that loop runs, or remove `'automatic'` from the type until then.

## Alternatives considered

**Merge 0.1.1 first, then fix overlay races.** Rejected. The carrier and event rename already force a large rebase. Layering an untested quit/activate race and a late vault throw onto that rebase hides which tree introduced a crash.

**One PR that merges, hardens, and closes stable blockers.** Rejected. Notarization, Authenticode, legal copy, and SDK subject are not overlay source changes.

**Drop the connection generic patch and wait for an Electron-shaped upstream carrier.** Rejected as a merge blocker. Official Web uses a page global; desktop still needs a bootstrap that installs IPC before the shell mounts. The merge may delete the Symbol carrier if the official hook is enough.

**Rewrite Vite to public exports before any other Wave 0 item.** Rejected as ordering. The alias list is closed and the renderer already bundles allowlisted client plugins. Growing the list is forbidden; rewriting it is not on the merge critical path.

**Make Acosmi login a Profile Bundle the user can add or omit.** Rejected. Production desktop loads one signed composition and performs no remote code loading ([downstream/AGENTS.md](../../../../downstream/AGENTS.md)). Flexibility is a channel patch omitting insert rows plus `loginEnabled`, not `dsh plugin add`.

## Acceptance criteria

Wave 0 is done when: `activate` during `stopping` does not create a window or reinstall IPC; signed darwin/win32 with `encryptionAvailable === false` throws from `createSecretVault` / persistence resolution and never opens the UI; a Host `fatal` after `ready` tears down the utility child; Canary OAuth and window chrome use `DSH-GUI Canary`; `genericPatches` lists both ui-conversation and ui-model-selection; focused tests cover the teardown and vault throws; the previous late-failure persistence assertion is gone.

Wave 1 is done when: `mountDesktopRenderer` boots against the merged carrier; API-key and web-search settings refresh on the new credential event; the desktop DeepSeek patch includes Vision if that is the upstream default; the frozen allowlist includes `ui-attachment` and `ui-reference`; Files API code lives in `packages/llm/llm-deepseek`; baseline `upstream.commit` equals the merged tag; desktop product version equals that tag; `compatibility.evidence` is still empty or lists only Wave 1 checks, never `passed` without them; keyless snapshots that change model- or user-visible Web chrome are updated in that merge.

Wave 2 and Wave 3 remain undone while their ledger blockers stay `blocked`. A Wave 0 or Wave 1 merge must not flip `releaseReadiness.stableBlocked`.

## Risks

Rebase of `packages/client/connection` and `packages/client/ui-conversation` can fail in one commit; stop and split rather than hand-resolve policy into overlay packages.

The ui-model-selection generation split is a generic patch. An upstream directory rewrite in 0.1.1 can conflict; keep the in-flight `selectModel` vs reload contract, not the exact file layout.

Projection checkpoint replay after merge can slow the first reopen of an existing session library without changing `SCHEMA_VERSION`.

Channel chrome that follows `identity.productName` still leaves About `displayNameZh` on the legal-brand string. That split is intentional until legal changes the ledger.

Wave 0 vault fail-closed on signed builds without OS encryption prevents login on those machines. That is the documented signed contract, not a new availability target.

The packaged renderer graph does not scan the Host Loader. Admitting Vision in the DeepSeek patch without `ui-attachment` on the allowlist leaves composer image slots empty.
