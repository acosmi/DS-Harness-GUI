# @acosmi/dsh-ui-acosmi-account

English | [中文](README.zh.md)

Private DSH-GUI client plugin for Acosmi account onboarding, account status, membership, quota, and the evidence-gated quota-benefit card. It receives only generated client-safe account DTOs; tokens, account identifiers, and raw billing responses remain in the Host utility process.

Slot registrations pass the account store through `inject.hooks.snapshot`; the UI renderer owns the React binding and supplies components with `useSnapshot`. The account plugin therefore depends only on the slot contract, not on a renderer implementation.

The numeric comparison is fail closed. The card renders a ratio only when `account-acosmi` supplies a current `quotaMultiplierClaim` derived from a typed subscription plan; otherwise it renders neutral membership copy.

This package also keeps the official DeepSeek API-key route available as the alternate onboarding path and displays the community-distribution disclaimer. After a successful interactive sign-in, it selects the first advertised Acosmi model only when the official API key is absent and the current session still uses `deepseek-official`. That attempt waits for the Host to publish the account route; a timeout or later session-list update does not overwrite a user selection.

## Model Experience

None. Account and billing projections are UI-only and never enter model requests or session logs.

#### KV Cache effect

None.

## Known limitations

- Published `@acosmi/sdk-ts@2.17.0` provides the required desktop OAuth `state` guarantee. Signed production login remains fail closed on the SDK's separate TokenStore failure-propagation and issuer-authenticated account-subject gaps; OpenAI managed-model release also remains blocked on lossless finish-reason preservation.
- The Host performs bounded periodic refresh from deployment configuration. Opening the account page and foreground resume request a current provider projection, while the visible page polls the latest Host snapshot at its configured interval and pauses polling during an account action. A later SDK push channel may replace this policy.
