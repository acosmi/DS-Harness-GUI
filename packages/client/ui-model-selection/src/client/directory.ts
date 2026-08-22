/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and the composer-seat selector load through the same
 * controller and submit through the same selectModel call, so the host stays
 * the single fact source and the store is one shared echo — a switch made in
 * either entry is what the other shows next.
 */
import type {
  IApiClient, ModelCatalogFailure, ModelProviderGroup, ModelSelection, SessionId, SessionModels,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Model selection the host reports for the next assembled step; null before the first load. */
  current: ModelSelection | null
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Client-product availability blocks keyed by provider route. */
  blockedProviders: Readonly<Record<string, string>>
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], blockedProviders: {}, status: 'idle', error: null,
  })

  /**
   * Directory loads and selections keep independent epochs so a catalog
   * refresh cannot discard an in-flight `selectModel`, while a newer load
   * still replaces an older load.
   */
  private loadGeneration = 0
  private selectEpoch = 0
  private selectTail: Promise<void> = Promise.resolve()
  private selectsInFlight = 0
  private disposed = false
  private accessErrorProvider: string | undefined

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param blockedProviders - product availability blocks already known at creation.
   */
  constructor(
    private readonly sessions: Pick<IApiClient['sessions'], 'models' | 'selectModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    blockedProviders: Readonly<Record<string, string>> = {},
  ) {
    this.store.update((state) => { state.blockedProviders = blockedProviders })
  }

  /**
   * Refresh the advisory directory (both entries call this on open).
   * Failure preserves the last good groups and current selection.
   * @returns the fresh directory value.
   */
  async load(): Promise<SessionModels> {
    this.assertAvailable()
    if (this.selectsInFlight > 0) {
      await this.selectTail.catch(() => undefined)
      this.assertAvailable()
    }
    this.accessErrorProvider = undefined
    const generation = ++this.loadGeneration
    const epoch = this.selectEpoch
    this.store.update((s) => { s.status = 'loading'; s.error = null })
    let response: Awaited<ReturnType<typeof this.sessions.models>>
    try {
      response = await this.sessions.models({ sessionId: this.sessionId })
    } catch (_modelDirectoryTransportFailure) {
      if (!this.disposed && generation === this.loadGeneration && epoch === this.selectEpoch) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = 'The model catalog could not be loaded.'
        })
      }
      throw new Error('session.models transport failed')
    }
    const { result } = response
    if (this.disposed || generation !== this.loadGeneration || epoch !== this.selectEpoch) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return result.value
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`session.models failed: ${result.error.code}: ${result.error.message}`)
    }
    const { current, routable, groups, failures } = result.value
    this.store.update((s) => {
      s.current = current
      s.routable = routable
      s.groups = groups
      s.failures = failures
      s.status = 'ready'
      s.error = null
    })
    return result.value
  }

  /**
   * Select the complete provider/model/reasoning selection (both entries submit through here). Success
   * updates the shared current; failure surfaces on the store and throws so
   * each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    this.assertAvailable()
    const blocked = providerBlock(this.store.getSnapshot().blockedProviders, selection.provider)
    if (blocked !== undefined) {
      this.accessErrorProvider = selection.provider
      this.selectEpoch++
      this.loadGeneration++
      this.store.update((state) => {
        state.status = 'error'
        state.error = blocked
      })
      throw new Error(blocked)
    }
    this.accessErrorProvider = undefined
    const epoch = ++this.selectEpoch
    this.loadGeneration++
    const previousSelect = this.selectTail
    const settled = Promise.withResolvers<void>()
    this.selectTail = settled.promise
    this.selectsInFlight++
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    try {
      await previousSelect.catch(() => undefined)
      let response: Awaited<ReturnType<typeof this.sessions.selectModel>>
      try {
        response = await this.sessions.selectModel({
          sessionId: this.sessionId,
          provider: selection.provider,
          model: selection.model,
          ...selection.reasoningEffort === undefined
            ? {}
            : { reasoningEffort: selection.reasoningEffort },
        })
      } catch (_modelSelectionTransportFailure) {
        if (!this.disposed && epoch === this.selectEpoch) {
          this.store.update((state) => {
            state.status = 'error'
            state.error = 'The model selection could not be saved.'
          })
        }
        throw new Error('session.selectModel transport failed')
      }
      const { result } = response
      if (this.disposed || epoch !== this.selectEpoch) {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        return
      }
      if (!result.ok) {
        this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
        throw new Error(`session.selectModel failed: ${result.error.code}: ${result.error.message}`)
      }
      // The Host validated the route before accepting it, so a selection that
      // landed is by construction one it can serve.
      this.store.update((s) => {
        s.current = result.value.selected
        s.routable = true
        s.status = 'ready'
        s.error = null
      })
    } finally {
      this.selectsInFlight--
      settled.resolve()
    }
  }

  /**
   * Drop the previous Host generation's projection and repull it. Clearing
   * first prevents an unconsumed process-local selection from being displayed
   * while the restarted Host has restored the last logged model selection.
   */
  resetConnected(): void {
    if (this.disposed) return
    this.accessErrorProvider = undefined
    this.selectEpoch++
    this.loadGeneration++
    this.store.update((s) => {
      s.current = null
      s.routable = null
      s.groups = []
      s.failures = []
      s.status = 'idle'
      s.error = null
    })
    if (!this.available()) return
    void this.load().catch(() => { /* the next menu open remains the explicit retry surface */ })
  }

  /**
   * Replace product-owned provider blocks without disturbing Host catalog state.
   * @param blockedProviders - provider ids mapped to their current user-facing reason.
   */
  setBlockedProviders(blockedProviders: Readonly<Record<string, string>>): void {
    if (this.disposed) return
    this.store.update((state) => {
      state.blockedProviders = blockedProviders
      const accessError = this.accessErrorProvider === undefined
        ? undefined
        : providerBlock(blockedProviders, this.accessErrorProvider)
      if (this.accessErrorProvider !== undefined && accessError === undefined && state.status === 'error') {
        this.accessErrorProvider = undefined
        state.status = state.current === null ? 'idle' : 'ready'
        state.error = null
      } else if (accessError !== undefined && state.status === 'error') {
        state.error = accessError
      }
    })
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }
}

/**
 * Read one provider block without consulting inherited object properties.
 * @param blockedProviders - product availability records.
 * @param provider - exact provider route id.
 * @returns the provider-owned reason, or `undefined` when no own record exists.
 */
export function providerBlock(
  blockedProviders: Readonly<Record<string, string>>,
  provider: string,
): string | undefined {
  return Object.hasOwn(blockedProviders, provider) ? blockedProviders[provider] : undefined
}
