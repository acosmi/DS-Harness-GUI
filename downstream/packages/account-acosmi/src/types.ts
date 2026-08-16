/** Client-safe Acosmi account and quota projections. */

/** Account state exposed to UI without token, account id, or raw billing data. */
export interface AcosmiAccountSnapshot {
  readonly status: 'signed-out' | 'ready' | 'degraded' | 'unavailable' | 'login-disabled'
  readonly loginAvailable: boolean
  readonly label: string
  readonly quota?: {
    readonly freeRemainingEtu: number
    readonly paidRemainingEtu: number
    readonly nextExpiry?: string
  }
  readonly modelStatus?: string
  readonly membership?: {
    readonly planName: string
    readonly expiresAt?: string
  }
  /** Backend plan evidence for the requested membership-vs-base quota card. */
  readonly quotaMultiplierClaim?: {
    readonly minimum: number
    readonly source: 'subscription-plan'
    readonly verifiedAt: number
  }
  /** Client projection polling period derived from deployment configuration. */
  readonly pollAfterMs?: number
  readonly updatedAt: number
  readonly message?: string
}

/** Client-safe classification for a failed account action. */
export type AcosmiAccountFailureReason =
  | 'secure-storage-unavailable'
  | 'operation-in-progress'
  | 'service-stopping'
  | 'oauth-discovery-failed'
  | 'oauth-registration-failed'
  | 'browser-open-failed'
  | 'authorization-denied'
  | 'authorization-timeout'
  | 'token-exchange-failed'
  | 'tls-proxy-detected'
  | 'state-mismatch'
  | 'oauth-protocol-failed'
  | 'account-operation-failed'

/** Explicit outcome for an account action. */
export type AcosmiAccountActionResult =
  | { readonly ok: true; readonly account: AcosmiAccountSnapshot }
  | { readonly ok: false; readonly code: 'login-disabled' | 'cancelled' | 'offline'; readonly message: string }
  | {
    readonly ok: false
    readonly code: 'failed'
    readonly reason: AcosmiAccountFailureReason
    readonly message: string
  }
