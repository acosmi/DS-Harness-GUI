/**
 * ModelDirectoryResolver (`ctx.modelDirectories`): the root owner of per-session
 * {@link ModelDirectory} instances. Both selection entries (the /model popup
 * and the composer model seat) resolve their session's directory through
 * this service, which is what makes the dual entry one shared state.
 *
 * Per-session storage follows the client service pattern (InputTriggerService /
 * CommandUiRuntime): a lazy service-internal map whose entry is deleted by the
 * owning scope's disposer. The host `dsh-scope` ScopedLayers registry does
 * does not belong here: it derives scope from the host carrier mechanism
 * (object-keyed), while client scopes tag contexts with branded SessionId
 * strings, and it models global+shadow named registries — this is a
 * per-session singleton with no global layer to merge.
 */
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionRuntime, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { ModelDirectory, providerBlock } from './directory.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    modelDirectories: ModelDirectoryResolver
  }
}

/** Live mutable state in one holder (service methods run behind the caller-ctx tracker). */
interface LiveState {
  /** Per-session directories; entries are deleted by their scope disposer. */
  readonly directories: Map<SessionId, ModelDirectory>
  /** One product-owned availability source per provider route. */
  readonly providerAccess: Map<string, SnapshotStore<ModelProviderAccess>>
}

/** Product-owned availability state for one provider route. */
export type ModelProviderAccess =
  | { readonly status: 'available' }
  | { readonly status: 'blocked'; readonly reason: string }

/** The `ctx.modelDirectories` session model-selection service. */
export class ModelDirectoryResolver extends Service {
  static inject = ['connection', 'sessions', 'remote']

  private readonly live: LiveState = { directories: new Map(), providerAccess: new Map() }

  /** Localized composer-block copy; this plugin owns the string it raises. */
  private readonly blockReason: () => string

  /**
   * @param ctx - owning root context (the service registers itself as `models`).
   * @param config - the bound translator for this plugin's own dictionary.
   */
  constructor(ctx: Context, config: { blockReason: () => string }) {
    super(ctx, 'modelDirectories')
    this.blockReason = config.blockReason
    ctx.on('connection/reset', () => {
      for (const directory of this.live.directories.values()) directory.resetConnected()
    })
    // Either source can change the directory: registry topology commits and
    // settings documents that carry provider catalogs or default selection.
    const refresh = (): void => {
      for (const directory of this.live.directories.values()) {
        directory.load().catch(() => undefined)
      }
    }
    ctx.remote.$on('llm/adapters-updated', refresh)
    ctx.remote.$on('settings/document-updated', refresh)
  }

  /**
   * Resolve the per-session shared directory (lazy; the scope disposer
   * removes and disposes it). Unknown sessions fail loud.
   * @param sessionId - the owning session.
   * @returns the resident directory both entries share.
   */
  directoryFor(sessionId: SessionId): ModelDirectory {
    const { live } = this
    const existing = live.directories.get(sessionId)
    if (existing !== undefined) return existing
    const sessions = this.ctx.get('sessions') as SessionRuntime
    const actx = sessions.scope(sessionId)
    if (actx === undefined) throw new Error(`ui-model-selection: session "${String(sessionId)}" resolved no scope`)
    const connection = this.ctx.get('connection') as ConnectionHandle
    const directory = new ModelDirectory(
      connection.api.sessions,
      sessionId,
      () => sessions.subagentAddress(sessionId) === undefined,
      this.blockedProviders(),
    )
    live.directories.set(sessionId, directory)
    // The composer cannot read this plugin (the dependency runs one way), so
    // the block is pushed: the Host says whether an adapter serves the
    // session's route, and only a definite `false` makes the input inert.
    // `null` — before the first load, or after one failed — must not, or a
    // slow or unreachable Host would lock a working composer.
    const conversation = this.ctx.get('conversation')
    if (conversation !== undefined) {
      const publish = (): void => {
        const snapshot = directory.store.getSnapshot()
        const accessReason = snapshot.current === null
          ? undefined
          : providerBlock(snapshot.blockedProviders, snapshot.current.provider)
        conversation.blocks.set(sessionId, accessReason === undefined
          ? snapshot.routable === false ? { reason: this.blockReason() } : undefined
          : { reason: accessReason })
      }
      publish()
      actx.effect(() => {
        const stop = directory.store.subscribe(publish)
        return () => {
          stop()
          conversation.blocks.set(sessionId, undefined)
        }
      }, 'ui-model-selection: composer block')
    }
    actx.effect(() => () => {
      directory.dispose()
      live.directories.delete(sessionId)
    }, 'ui-model-selection: session directory')
    return directory
  }

  /**
   * Register one client-product availability source for a provider route.
   * @param provider - exact provider route id.
   * @param source - observable availability state.
   * @returns disposer that removes the contribution and republishes directories.
   */
  registerProviderAccess(provider: string, source: SnapshotStore<ModelProviderAccess>): () => void {
    if (this.live.providerAccess.has(provider)) {
      throw new Error(`ui-model-selection: provider access for "${provider}" is already registered`)
    }
    this.live.providerAccess.set(provider, source)
    const publish = (): void => { this.publishProviderAccess() }
    const stop = source.subscribe(publish)
    publish()
    return () => {
      stop()
      if (this.live.providerAccess.get(provider) !== source) return
      this.live.providerAccess.delete(provider)
      publish()
    }
  }

  private blockedProviders(): Readonly<Record<string, string>> {
    const blocked: Record<string, string> = {}
    for (const [provider, source] of this.live.providerAccess) {
      const access = source.getSnapshot()
      if (access.status === 'blocked') {
        Object.defineProperty(blocked, provider, {
          configurable: true,
          enumerable: true,
          value: access.reason,
          writable: true,
        })
      }
    }
    return blocked
  }

  private publishProviderAccess(): void {
    const blocked = this.blockedProviders()
    for (const directory of this.live.directories.values()) directory.setBlockedProviders(blocked)
  }
}
