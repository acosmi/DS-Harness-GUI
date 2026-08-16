/** Desktop product availability for the official DeepSeek API route. */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelProviderAccess } from '@deepseek-ai/dsh-client-ui-model-selection/client'

type CredentialReader = Pick<IApiClient['credentials'], 'describe'>
type BlockReason = 'checking' | 'missing' | 'unavailable'

/** Localized reason factories read again when the application locale changes. */
export interface DeepSeekApiAccessCopy {
  /** @returns copy shown while credential state is loading. */
  checking(): string
  /** @returns copy shown when no official API key is configured. */
  missing(): string
  /** @returns copy shown when credential state cannot be read. */
  unavailable(): string
}

/** Projects the credential service's boolean status without ever reading secret material. */
export class DeepSeekApiAccessController {
  /** Observable provider access consumed by the shared model directory. */
  readonly store: SnapshotStore<ModelProviderAccess>

  private generation = 0
  private reason: BlockReason = 'checking'

  /**
   * @param credentials - credential status reader.
   * @param copy - localized block reason factories.
   */
  constructor(
    private readonly credentials: CredentialReader,
    private readonly copy: DeepSeekApiAccessCopy,
  ) {
    this.store = createSnapshotStore({ status: 'blocked', reason: copy.checking() })
  }

  /** Refresh whether the official API route has its own API key. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    this.reason = 'checking'
    this.publishBlocked()
    try {
      const response = await this.credentials.describe({ refs: ['DEEPSEEK_API_KEY'] })
      if (generation !== this.generation) return
      if (!response.result.ok) throw new Error(response.result.error.message)
      if (response.result.value.credentials.DEEPSEEK_API_KEY?.configured === true) {
        this.store.set({ status: 'available' })
        return
      }
      this.reason = 'missing'
      this.publishBlocked()
    } catch {
      if (generation !== this.generation) return
      this.reason = 'unavailable'
      this.publishBlocked()
    }
  }

  /** Re-render the current block reason after a locale switch. */
  relabel(): void {
    if (this.store.getSnapshot().status === 'blocked') this.publishBlocked()
  }

  private publishBlocked(): void {
    this.store.set({ status: 'blocked', reason: this.copy[this.reason]() })
  }
}
