import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Why one session's composer is inert. */
export interface ComposerBlock {
  /** Localized placeholder owned by the plugin that raised the block. */
  readonly reason: string
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /** @param sessionId - affected session. @param block - next block, or undefined to clear it. */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /** @param sessionId - session to observe. @returns that session's block store. */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /** @param sessionId - session whose retained store is discarded. */
  forget(sessionId: SessionId): void
}
