/** Client-only Acosmi account projection state. */

import type { ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { AcosmiAccountSnapshot } from '@acosmi/dsh-api-remotes-acosmi/client'
import type {} from '@acosmi/dsh-api-remotes-acosmi/client'

const ACCOUNT_SERVICE_UNAVAILABLE = 'Acosmi account service is temporarily unavailable.'
const ACCOUNT_ACTION_FAILED = 'Acosmi account operation could not be completed.'
const ACCOUNT_ROUTE_FAILED = 'Acosmi sign-in succeeded, but no account model could be selected.'

/** Account action whose progress is presented by the UI. */
export type AcosmiAccountAction = 'login' | 'refresh' | 'logout'

/** Renderer state contains only the client-safe account DTO. */
export interface AcosmiAccountUiState {
  readonly phase: 'idle' | 'loading' | 'ready' | 'error'
  readonly account: AcosmiAccountSnapshot | null
  readonly busy: AcosmiAccountAction | null
  readonly error: string | null
}

type AcosmiAccountRemote = ClientRemote['acosmiAccount']

/** Owns account Remote calls and suppresses stale read completion. */
export class AcosmiAccountStore {
  /** Observable renderer state. */
  readonly store: SnapshotStore<AcosmiAccountUiState> = createSnapshotStore({
    phase: 'idle',
    account: null,
    busy: null,
    error: null,
  })

  private generation = 0

  /**
   * @param remote - generated Acosmi account Remote namespace.
   * @param onAuthorized - product routing action run after a successful interactive sign-in.
   */
  constructor(
    private readonly remote: AcosmiAccountRemote,
    private readonly onAuthorized?: () => Promise<void>,
  ) {}

  /** Load the latest account display projection. */
  async load(): Promise<void> {
    const generation = ++this.generation
    this.store.set({
      ...this.store.getSnapshot(),
      phase: 'loading',
      error: null,
    })
    try {
      const result = await this.remote.describe()
      if (generation !== this.generation) return
      if (!result.ok) throw new Error(ACCOUNT_SERVICE_UNAVAILABLE)
      this.store.set({ phase: 'ready', account: result.value, busy: null, error: null })
    } catch (_accountDescriptionFailure) {
      if (generation !== this.generation) return
      this.store.set({
        ...this.store.getSnapshot(),
        phase: 'error',
        busy: null,
        error: ACCOUNT_SERVICE_UNAVAILABLE,
      })
    }
  }

  /** Load an unknown Host projection, then refresh provider data when the resulting account is authorized. */
  async resume(): Promise<void> {
    const state = this.store.getSnapshot()
    if (state.busy !== null) return
    const status = state.account?.status
    if (status === 'ready' || status === 'degraded') {
      await this.act('refresh')
      return
    }
    await this.load()
    const loaded = this.store.getSnapshot()
    if (loaded.busy !== null) return
    if (loaded.account?.status === 'ready' || loaded.account?.status === 'degraded') {
      await this.act('refresh')
    }
  }

  /** Run one generated account action and publish its returned projection. */
  async act(action: AcosmiAccountAction): Promise<void> {
    if (this.store.getSnapshot().busy !== null) return
    const generation = ++this.generation
    let publicError = ACCOUNT_SERVICE_UNAVAILABLE
    this.store.set({ ...this.store.getSnapshot(), busy: action, error: null })
    try {
      const result = await this.remote[action]()
      if (generation !== this.generation) return
      if (!result.ok) throw new Error(ACCOUNT_SERVICE_UNAVAILABLE)
      if (!result.value.ok) {
        publicError = accountActionFailure(result.value.code)
        throw new Error('Acosmi account action was rejected')
      }
      let routeError: string | null = null
      if (action === 'login' && result.value.account.status === 'ready') {
        try {
          await this.onAuthorized?.()
        } catch (_accountModelSelectionFailure) {
          routeError = ACCOUNT_ROUTE_FAILED
        }
      }
      if (generation !== this.generation) return
      this.store.set({
        phase: 'ready',
        account: result.value.account,
        busy: null,
        error: routeError,
      })
    } catch (_accountActionFailure) {
      if (generation !== this.generation) return
      this.store.set({
        ...this.store.getSnapshot(),
        phase: 'error',
        busy: null,
        error: publicError,
      })
    }
  }
}

function accountActionFailure(code: 'login-disabled' | 'cancelled' | 'offline' | 'failed'): string {
  switch (code) {
    case 'login-disabled': return 'Acosmi sign-in is disabled for this build.'
    case 'cancelled': return 'Login was cancelled.'
    case 'offline': return 'Acosmi account data is temporarily unavailable.'
    case 'failed': return ACCOUNT_ACTION_FAILED
  }
}
