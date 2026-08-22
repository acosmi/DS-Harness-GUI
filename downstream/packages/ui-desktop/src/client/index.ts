/** Desktop About and update client contribution. */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import { AboutSection, type AboutSectionInjected } from './AboutSection.tsx'
import { DesktopBrand, DesktopHeroBrand } from './DesktopBrand.tsx'
import { en, zh, type DesktopUiKey } from './locales.ts'
import { DeepSeekApiAccessController } from './model-access.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DSH-GUI About and update copy. */
    'desktop.about': DesktopUiKey
  }
}

const NS = 'desktop.about'

/** Required client services. */
export const inject = ['slots', 'locale', 'connection', 'remote', 'modelDirectories']

/**
 * Register the desktop brand, About page, and provider-access projection.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand', () => ctx.slots.register({
    name: 'sidebar.brand',
  }, DesktopBrand))
  ctx.slots.inject('conversation.hero.brand', () => ctx.slots.register({
    name: 'conversation.hero.brand',
  }, DesktopHeroBrand))
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-desktop: dictionaries')
  const t = ctx.locale.bind(NS)
  const connection = ctx.get('connection') as ConnectionHandle
  const deepSeekAccess = new DeepSeekApiAccessController(connection.api.credentials, {
    missing: () => t('model.deepseekMissing'),
    unavailable: () => t('model.deepseekUnavailable'),
  })
  ctx.effect(
    () => ctx.modelDirectories.registerProviderAccess('deepseek-official', deepSeekAccess.store),
    'ui-desktop: official DeepSeek API access',
  )
  ctx.effect(() => {
    const refresh = (): void => { void deepSeekAccess.refresh() }
    const disposers = [
      ctx.remote.$on('credentials/reference-updated', refresh),
      ctx.on('connection/reset', refresh),
      ctx.on('locale/change', () => { deepSeekAccess.relabel() }),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-desktop: official DeepSeek API access refresh')
  void deepSeekAccess.refresh()
  const injected = (): AboutSectionInjected => ({ t })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'desktop-about',
    order: 90,
    label: () => t('nav'),
    inject: injected,
  }, AboutSection))
}

export { DeepSeekApiAccessController } from './model-access.ts'
export type { DeepSeekApiAccessCopy } from './model-access.ts'
