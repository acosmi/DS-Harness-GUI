/** Acosmi account settings and onboarding client plugin. */

import type { ConnectionHandle, ModelSelection, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-web-react'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@acosmi/dsh-api-remotes-acosmi/client'
import { AccountOnboarding } from './AccountOnboarding.tsx'
import type { AccountOnboardingInjected } from './AccountOnboarding.tsx'
import { AccountSection } from './AccountSection.tsx'
import type { AccountSectionInjected } from './AccountSection.tsx'
import { en, zh, type AcosmiAccountKey } from './locales.ts'
import { AcosmiAccountStore } from './store.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Acosmi account, quota, membership, and onboarding copy. */
    'acosmi.account': AcosmiAccountKey
  }
}

const NS = 'acosmi.account'

/** Required client services. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.acosmiAccount', 'connection', 'sessions', 'modelDirectories',
]

/** Register the shared account controller into Settings and onboarding slots. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-acosmi-account: dictionaries')
  const { api } = ctx.get('connection') as ConnectionHandle
  let preferAccountRoute = false
  let selecting: Promise<void> | undefined
  const reconcileAccountRoute = (): Promise<void> => {
    if (!preferAccountRoute) return Promise.resolve()
    if (selecting !== undefined) return selecting
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return Promise.resolve()
    const operation = selectAccountRoute(ctx, api, sessionId).then((settled) => {
      if (settled) preferAccountRoute = false
    }).finally(() => {
      if (selecting === operation) selecting = undefined
    })
    selecting = operation
    return operation
  }
  const controller = new AcosmiAccountStore(ctx.remote.acosmiAccount, async () => {
    preferAccountRoute = true
    await reconcileAccountRoute()
  })
  const useSnapshot = bindSnapshotSelector(controller.store)
  const t = ctx.locale.bind(NS)
  const injected = (): AccountSectionInjected => ({ controller, useSnapshot, t })
  const onboardingInjected = (): AccountOnboardingInjected => ({ controller, useSnapshot, t })
  const resumeAccount = (): void => { void controller.resume() }

  ctx.effect(() => ctx.on('connection/reset', () => { void controller.load() }), 'ui-acosmi-account: reconnect')
  ctx.effect(() => {
    const visibility = (): void => {
      if (document.visibilityState === 'visible') resumeAccount()
    }
    window.addEventListener('focus', resumeAccount)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      window.removeEventListener('focus', resumeAccount)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, 'ui-acosmi-account: foreground refresh')
  ctx.effect(() => ctx.sessions.list.subscribe(() => {
    void reconcileAccountRoute().catch((_selectionFailure: unknown) => {
      ctx.logger.warn('ui-acosmi-account: deferred account-model selection failed')
    })
  }), 'ui-acosmi-account: deferred account-model selection')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'acosmi-account',
    order: 15,
    label: () => t('nav'),
    inject: injected,
  }, AccountSection))
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'acosmi-account',
    order: -10,
    inject: onboardingInjected,
  }, AccountOnboarding))
}

async function selectAccountRoute(
  ctx: ClientContext,
  api: ConnectionHandle['api'],
  sessionId: SessionId,
): Promise<boolean> {
  const credential = await api.credentials.describe({ refs: ['DEEPSEEK_API_KEY'] })
  if (!credential.result.ok) {
    throw new Error(`credential status is unavailable: ${credential.result.error.message}`)
  }
  if (credential.result.value.credentials.DEEPSEEK_API_KEY?.configured === true) return true

  const directory = ctx.modelDirectories.directoryFor(sessionId)
  const catalog = await directory.load()
  if (catalog.current.provider !== 'deepseek-official') return true
  const group = catalog.groups.find(candidate => candidate.id === 'acosmi')
  if (group === undefined) throw new Error('the signed-in account has no selectable Acosmi model')
  const model = group.models[0]
  if (model === undefined) throw new Error('the signed-in account has no selectable Acosmi model')
  const selection: ModelSelection = {
    provider: group.id,
    model: model.id,
    ...model.reasoning?.defaultEffort === undefined
      ? {}
      : { reasoningEffort: model.reasoning.defaultEffort },
  }
  await directory.select(selection)
  return true
}

export type { AcosmiAccountKey } from './locales.ts'
export { AcosmiAccountStore } from './store.ts'
export type { AcosmiAccountUiState } from './store.ts'
