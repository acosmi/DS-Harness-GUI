import type { ManagedModel } from '@acosmi/sdk-ts'
import type { AcosmiAccountService, AcosmiAccountSnapshot } from '@acosmi/dsh-account-acosmi'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

function snapshot(status: AcosmiAccountSnapshot['status']): AcosmiAccountSnapshot {
  return {
    status,
    loginAvailable: true,
    label: status === 'ready' ? 'Acosmi member' : 'Not signed in',
    updatedAt: 1,
  }
}

function selectableModel(): ManagedModel {
  return {
    id: 'managed-model',
    name: 'Managed Model',
    provider: 'deepseek',
    modelId: 'deepseek-v4-flash',
    isEnabled: true,
    capabilities: {},
  } as ManagedModel
}

describe('Acosmi provider route lifecycle', () => {
  it('does not activate a route when a superseded catalog confirmation resolves late', async () => {
    const context = new Context()
    await context.plugin(LlmRuntime)
    const catalog = Promise.withResolvers<{ status: 'ok'; models: ManagedModel[] }>()
    const discoveryStarted = Promise.withResolvers<void>()
    const listeners = new Set<(value: AcosmiAccountSnapshot) => void>()
    let current = snapshot('ready')
    const account = {
      models: () => {
        discoveryStarted.resolve()
        return catalog.promise
      },
      subscribe(owner: Context, listener: (value: AcosmiAccountSnapshot) => void) {
        return owner.effect(function* () {
          listeners.add(listener)
          listener(structuredClone(current))
          yield () => { listeners.delete(listener) }
        }, 'test.acosmi-account-subscription')
      },
    } as unknown as AcosmiAccountService
    context.provide('acosmiAccount', account)

    const applying = apply(context, { maxTokens: 8192, streamIdleTimeoutMs: 120_000 })
    await discoveryStarted.promise
    current = snapshot('signed-out')
    for (const listener of listeners) listener(structuredClone(current))
    catalog.resolve({ status: 'ok', models: [selectableModel()] })
    await applying

    expect(context.llm.listProviders()).toEqual([])
    await context.fiber.dispose()
  })
})
