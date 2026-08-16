// @vitest-environment jsdom
/** DSH-GUI sidebar brand visual and slot registration. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { DesktopBrand, DesktopHeroBrand } from '../src/client/DesktopBrand.tsx'
import { DSH_GUI_LOGO_ASSET_PATH } from '../src/client/branding.ts'
import { apply, inject } from '../src/client/index.ts'

afterEach(cleanup)

describe('desktop sidebar brand', () => {
  it('uses one product-owned logo for the wordmark, rail, and hero', () => {
    const { container, rerender } = render(<DesktopBrand variant="wordmark" />)
    const wordmark = container.querySelector('[data-product-brand="DS Harness GUI"]')
    expect(wordmark?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByText('DS')).toBeTruthy()
    expect(screen.getByText('Harness').className).toContain('badge')
    expect(screen.getByText('GUI')).toBeTruthy()
    expect(wordmark?.querySelector('img')?.getAttribute('src')).toBe(`./${DSH_GUI_LOGO_ASSET_PATH}`)

    rerender(<DesktopBrand variant="mark" />)
    expect(container.querySelector('[data-dsh-gui-logo="whale-browser-v6"]')).toBeTruthy()
    expect(container.textContent).toBe('')

    rerender(<DesktopHeroBrand />)
    const hero = container.querySelector('[data-dsh-gui-logo="whale-browser-v6"]')
    expect(hero?.getAttribute('src')).toBe(`./${DSH_GUI_LOGO_ASSET_PATH}`)
    expect(hero?.getAttribute('width')).toBe('34')
  })

  it('registers the brand only while the desktop plugin is live', async () => {
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    const slots = ctx.get('slots') as SlotRegistry
    slots.register({
      name: 'root',
      children: {
        'conversation.hero.brand': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'sidebar.brand': { kind: 'single', scope: 'root' },
      },
    } as never, () => null)
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('connection', {
      api: {
        credentials: {
          describe: async () => ({
            rpcId: 'test',
            result: { ok: true, value: { credentials: {} } },
          }),
        },
      },
    } as never)
    ctx.provide('remote', { $on: vi.fn(() => () => {}) } as never)
    ctx.provide('modelDirectories', {
      registerProviderAccess: vi.fn(() => () => {}),
    } as never)

    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('sidebar.brand')).toHaveLength(1)
    expect(slots.entries('conversation.hero.brand')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('sidebar.brand')).toHaveLength(0)
    expect(slots.entries('conversation.hero.brand')).toHaveLength(0)
  })
})
