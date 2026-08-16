import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { ModelDirectory } from '../src/client/directory.ts'

describe('model directory transport failures', () => {
  it('leaves loading and selecting states with fixed client-safe errors', async () => {
    const sessions = {
      models: async () => { throw new Error('token=plain-secret account=private') },
      selectModel: async () => { throw new Error('token=other-secret path=/private/workspace') },
    }
    const directory = new ModelDirectory(sessions, 'session' as SessionId, () => true)

    await expect(directory.load()).rejects.toThrow('session.models transport failed')
    expect(directory.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'The model catalog could not be loaded.',
    })
    await expect(directory.select({ provider: 'provider', model: 'model' }))
      .rejects.toThrow('session.selectModel transport failed')
    expect(directory.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'The model selection could not be saved.',
    })
    expect(JSON.stringify(directory.store.getSnapshot())).not.toMatch(/plain-secret|other-secret|private\/workspace/u)
  })
})
