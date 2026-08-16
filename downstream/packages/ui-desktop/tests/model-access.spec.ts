import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { DeepSeekApiAccessController } from '../src/client/model-access.ts'

type CredentialReader = Pick<IApiClient['credentials'], 'describe'>

function reader(configured: boolean): CredentialReader {
  return {
    describe: async request => ({
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: { credentials: { DEEPSEEK_API_KEY: { configured, source: configured ? 'memory' : 'missing' } } },
      },
    }),
  } as CredentialReader
}

const copy = {
  checking: () => 'checking',
  missing: () => 'configure API or use account models',
  unavailable: () => 'status unavailable',
}

describe('official DeepSeek API access', () => {
  it('keeps an unconfigured API route blocked without consulting account state', async () => {
    const controller = new DeepSeekApiAccessController(reader(false), copy)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toEqual({
      status: 'blocked',
      reason: 'configure API or use account models',
    })
  })

  it('enables the official route only from its own credential status', async () => {
    const controller = new DeepSeekApiAccessController(reader(true), copy)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toEqual({ status: 'available' })
  })

  it('fails closed with a distinct status-read message', async () => {
    const controller = new DeepSeekApiAccessController({
      describe: async () => { throw new Error('offline') },
    } as CredentialReader, copy)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toEqual({ status: 'blocked', reason: 'status unavailable' })
  })
})
