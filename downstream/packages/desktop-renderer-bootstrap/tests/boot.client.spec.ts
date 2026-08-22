// @vitest-environment jsdom
import type { Context } from '@deepseek-ai/cordis'
import { clientBootAssets } from '@deepseek-ai/dsh-client-modules'
import * as modulesClient from '@deepseek-ai/dsh-client-modules/client'
import type {
  ClientBundleRegistration, ClientModuleLoaderTarget, DshWindow, WebBootEntry, WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { AppWebEntry } from '@deepseek-ai/dsh-client-web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountDesktopRenderer, type DesktopRendererMount } from '../src/client.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const RUNTIME_ID = '@deepseek-ai/dsh-client-runtime'
const RENDERER_ID = '@deepseek-ai/dsh-client-ui-renderer'
const win = globalThis as DshWindow
const moduleFace = modulesClient as unknown as Record<string, unknown>
let mount: DesktopRendererMount | undefined

function entry(id: string, rev: string): WebBootEntry {
  const stem = id.replace(/^@/u, '').replaceAll('/', '-')
  return { id, rev, url: `app://dsh-gui/plugins/${stem}-${rev}.js?rev=${rev}` }
}

function registration(id: string, factory: ClientBundleRegistration['factory']): ClientBundleRegistration {
  return { id, factory }
}

async function mountFixture(): Promise<{
  facade: ClientModuleLoaderTarget
  root: HTMLElement
  mounted: DesktopRendererMount
}> {
  const graph: WebBootGraph = {
    rev: 'desktop-graph',
    entries: [
      entry(MODULES_ID, '1111111111111111'),
      entry(RUNTIME_ID, '2222222222222222'),
      entry(RENDERER_ID, '3333333333333333'),
    ],
  }
  const boot = clientBootAssets(graph)
  ;(0, eval)(boot.facadeSource)
  const facade = win.__ModuleLoader__ as ClientModuleLoaderTarget
  facade.load(registration(MODULES_ID, () => moduleFace))
  facade.load(registration(RUNTIME_ID, () => ({ apply: () => {} })))
  facade.load(registration(RENDERER_ID, () => ({
    apply(ctx: Context) {
      ctx.reflect.provide('uiRenderer', {
        mount(root: HTMLElement) {
          root.textContent = 'desktop renderer mounted'
          return () => { root.textContent = '' }
        },
      })
    },
  })))
  const root = document.createElement('main')
  document.body.append(root)
  const mounted = await mountDesktopRenderer(root, graph)
  return { facade, root, mounted }
}

afterEach(async () => {
  await mount?.dispose()
  mount = undefined
  delete win.__ModuleLoader__
  delete win.__DSH_BOOT__
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('desktop parser-stage bootstrap', () => {
  it('uses the production facade to activate registrations and mount the renderer', async () => {
    const fixture = await mountFixture()
    mount = fixture.mounted

    expect(fixture.root.textContent).toBe('desktop renderer mounted')
    expect(fixture.root.textContent).not.toContain('Failed to load plugins')
    expect(fixture.facade.mode).toBe('live')
    expect(fixture.facade.pendingQueue).toEqual([])
    expect((globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__).toBeDefined()
    await mount.dispose()
    mount = undefined
    expect((globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__).toBeUndefined()
    expect(win.__DSH_BOOT__).toBeUndefined()
  })

  it('retracts the carrier and graph when upstream disposal fails', async () => {
    mount = (await mountFixture()).mounted
    const dispose = AppWebEntry.prototype.dispose
    vi.spyOn(AppWebEntry.prototype, 'dispose').mockImplementationOnce(async function () {
      await dispose.call(this)
      throw new Error('dispose failed')
    })

    await expect(mount.dispose()).rejects.toThrow('dispose failed')
    mount = undefined
    expect((globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__).toBeUndefined()
    expect(win.__DSH_BOOT__).toBeUndefined()
  })
})
