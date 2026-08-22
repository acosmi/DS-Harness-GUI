import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { desktopPresetPatch } from '../src/composition.ts'

describe('desktop Harness composition', () => {
  it('declares every plugin imported by each shipped agent preset', () => {
    const repositoryRoot = resolve(import.meta.dirname, '../../../..')
    const manifest = JSON.parse(readFileSync(
      resolve(repositoryRoot, 'downstream/bundles/desktop/package.json'),
      'utf8',
    )) as { dependencies: Record<string, string> }
    const presetRoot = resolve(repositoryRoot, 'apps/cli/config/agent-presets')
    const missing = new Set<string>()

    for (const entry of readdirSync(presetRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const source = readFileSync(resolve(presetRoot, entry.name, 'agent.cordis.yml'), 'utf8')
      for (const match of source.matchAll(/^\s*name:\s*['"]?(@[^'"\s]+)['"]?\s*$/gmu)) {
        const packageName = match[1]!.split('/').slice(0, 2).join('/')
        if (!(packageName in manifest.dependencies)) missing.add(packageName)
      }
    }

    expect([...missing].sort()).toEqual([])
  })

  it('mounts the shipped roster as the trusted system root with the standard default', () => {
    expect(desktopPresetPatch('/Applications/DSH-GUI.app/Contents/Resources/config/agent-presets')).toEqual({
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{
          path: '/Applications/DSH-GUI.app/Contents/Resources/config/agent-presets',
          trust: 'system',
        }],
      },
    })
  })

  it('rejects a working-directory-relative preset root', () => {
    expect(() => desktopPresetPatch('config/agent-presets')).toThrow(/must be absolute/)
  })

  it('keeps each channel account patch complete because Loader replaces config objects', () => {
    const bundleRoot = resolve(import.meta.dirname, '../../../bundles/desktop')
    const appManifest = JSON.parse(readFileSync(
      resolve(bundleRoot, '../../apps/desktop/package.json'),
      'utf8',
    )) as { version: string }
    for (const [channel, tokenKey] of [
      ['stable', 'com.acosmi.dsharness.gui:stable:profile-default:https://acosmi.com:account-current'],
      ['canary', 'com.acosmi.dsharness.gui.canary:canary:profile-default:https://acosmi.com:account-current'],
    ] as const) {
      expect(loadOverlayPatches('dsh-gui', resolve(bundleRoot, `cordis.${channel}.patch.yml`))).toEqual([{
        id: 'account-acosmi',
        config: {
          tokenKey,
          loginEnabled: true,
          gatewayBaseUrl: 'https://acosmi.com',
          oauthAppName: channel === 'stable' ? 'DSH-GUI' : 'DSH-GUI Canary',
          loginTimeoutMs: 180_000,
          logoutTimeoutMs: 10_000,
          refreshIntervalMs: 300_000,
          refreshJitterMs: 30_000,
          refreshTimeoutMs: 30_000,
          projectionPollIntervalMs: 60_000,
          productVersion: appManifest.version,
        },
      }])
    }
  })

  it('labels official DeepSeek models as API-key routes in the desktop catalog', () => {
    const bundleRoot = resolve(import.meta.dirname, '../../../bundles/desktop')
    expect(loadOverlayPatches('dsh-gui', resolve(bundleRoot, 'cordis.patch.yml'))).toContainEqual({
      id: 'llm-deepseek',
      config: {
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek API · DeepSeek-V4-Flash' },
          { id: 'deepseek-v4-pro', name: 'DeepSeek API · DeepSeek-V4-Pro' },
          {
            id: 'deepseek-v4-flash-vision-exp',
            name: 'DeepSeek API · DeepSeek-V4-Flash-Vision-Exp',
            inputModalities: ['text', 'image'],
          },
        ],
      },
    })
  })

  it('replaces the upstream harness identity with the DSH-GUI product persona', () => {
    const bundleRoot = resolve(import.meta.dirname, '../../../bundles/desktop')
    expect(loadOverlayPatches('dsh-gui', resolve(bundleRoot, 'cordis.patch.yml'))).toContainEqual({
      id: 'system-prompt',
      config: {
        includeHarnessIdentity: false,
        persona: "You are an AI agent in DSH-GUI, Acosmi's desktop AI agent workbench, powered by the {{model}} model. Your working directory is {{cwd}}.",
      },
    })
  })
})
