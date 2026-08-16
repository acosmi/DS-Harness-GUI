import type { Context } from '@deepseek-ai/cordis'
import type {
  AcosmiAccountService,
  AcosmiAccountSnapshot,
} from '@acosmi/dsh-account-acosmi'

export const name = 'acosmi-account-snapshot-fixture'

interface FixtureChatRequest {
  readonly max_tokens?: number
  readonly rawMessages?: unknown
  readonly tools?: unknown
}

interface FixtureStreamEvent {
  readonly event: string
  readonly data: string
  readonly blockIndex?: number
  readonly blockType?: string
  readonly ephemeral?: boolean
}

const MODEL = {
  id: 'managed-kimi-k3',
  name: 'Kimi K3',
  provider: 'moonshot',
  modelId: 'kimi-k3',
  maxTokens: 1_000_000,
  contextWindow: 1_000_000,
  isEnabled: true,
  preferred_format: 'anthropic',
  supported_formats: ['anthropic'],
  capabilities: {
    supports_thinking: true,
    supports_adaptive_thinking: true,
    supports_effort: true,
    supports_max_effort: false,
    supports_image_generation: false,
    supports_video_generation: false,
    supports_embedding: false,
    supports_rerank: false,
  },
}

const SNAPSHOT: AcosmiAccountSnapshot = {
  status: 'ready',
  loginAvailable: true,
  label: 'Acosmi member',
  modelStatus: 'ok',
  updatedAt: 0,
}

const CITATION = {
  type: 'web_search_result_location',
  url: 'https://example.test/kimi-k3',
  title: 'Kimi K3 verification',
  cited_text: 'The managed route completed.',
}

function streamEvent(
  event: string,
  data: Record<string, unknown>,
  metadata: Partial<FixtureStreamEvent> = {},
): FixtureStreamEvent {
  return { event, data: JSON.stringify(data), ...metadata }
}

const TOOL_RESPONSE: readonly FixtureStreamEvent[] = [
  streamEvent('started', {}),
  streamEvent('message_start', { message: { usage: { input_tokens: 222 } } }),
  streamEvent('content_block_start', {
    index: 0,
    content_block: { type: 'tool_use', id: 'fixture-call-1', name: 'bash', input: {} },
  }, { blockIndex: 0, blockType: 'tool_use', ephemeral: false }),
  streamEvent('content_block_delta', {
    index: 0,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"command":"printf \'alpha\\n\'","description":"Print deterministic alpha output"}',
    },
  }, { blockIndex: 0, blockType: 'tool_use', ephemeral: false }),
  streamEvent('content_block_stop', { index: 0 }, {
    blockIndex: 0,
    blockType: 'tool_use',
    ephemeral: false,
  }),
  streamEvent('content_block_start', {
    index: 1,
    content_block: { type: 'tool_use', id: 'fixture-call-2', name: 'bash', input: {} },
  }, { blockIndex: 1, blockType: 'tool_use', ephemeral: false }),
  streamEvent('content_block_delta', {
    index: 1,
    delta: {
      type: 'input_json_delta',
      partial_json: '{"command":"printf \'beta\\n\'","description":"Print deterministic beta output"}',
    },
  }, { blockIndex: 1, blockType: 'tool_use', ephemeral: false }),
  streamEvent('content_block_stop', { index: 1 }, {
    blockIndex: 1,
    blockType: 'tool_use',
    ephemeral: false,
  }),
  streamEvent('message_delta', {
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 12 },
  }),
  streamEvent('message_stop', {}),
]

const RESPONSE: readonly FixtureStreamEvent[] = [
  streamEvent('started', {}),
  streamEvent('sources', { sources: [] }),
  streamEvent('pending_settle', {}),
  streamEvent('message_start', { message: { usage: { input_tokens: 321 } } }),
  streamEvent('content_block_start', {
    index: 0,
    content_block: {
      type: 'server_tool_use',
      id: 'managed-search-1',
      name: 'web_search',
      input: {},
      acosmi_ephemeral: true,
    },
  }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: true }),
  streamEvent('content_block_delta', {
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"query":"Kimi K3 status"}' },
  }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: true }),
  streamEvent('content_block_stop', { index: 0 }, {
    blockIndex: 0,
    blockType: 'server_tool_use',
    ephemeral: true,
  }),
  streamEvent('content_block_start', {
    index: 1,
    content_block: {
      type: 'web_search_tool_result',
      tool_use_id: 'managed-search-1',
      content: [{ type: 'web_search_result', url: CITATION.url, title: CITATION.title }],
      acosmi_ephemeral: true,
    },
  }, { blockIndex: 1, blockType: 'web_search_tool_result', ephemeral: true }),
  streamEvent('content_block_stop', { index: 1 }, {
    blockIndex: 1,
    blockType: 'web_search_tool_result',
    ephemeral: true,
  }),
  streamEvent('content_block_start', {
    index: 2,
    content_block: { type: 'text', text: '', citations: [] },
  }, { blockIndex: 2, blockType: 'text', ephemeral: false }),
  streamEvent('content_block_delta', {
    index: 2,
    delta: { type: 'text_delta', text: 'Kimi K3 managed search completed.' },
  }, { blockIndex: 2, blockType: 'text', ephemeral: false }),
  streamEvent('content_block_delta', {
    index: 2,
    delta: { type: 'citations_delta', citation: CITATION },
  }, { blockIndex: 2, blockType: 'text', ephemeral: false }),
  streamEvent('content_block_stop', { index: 2 }, {
    blockIndex: 2,
    blockType: 'text',
    ephemeral: false,
  }),
  streamEvent('message_delta', {
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 8 },
  }),
  streamEvent('settled', {}),
  streamEvent('message_stop', {}),
]

function assertRequest(request: FixtureChatRequest): void {
  if (request.max_tokens !== 8192) {
    throw new Error(`Acosmi snapshot expected max_tokens=8192, received ${String(request.max_tokens)}`)
  }
  if (!isUnknownArray(request.tools)) throw new Error('Acosmi snapshot expected Harness tools')
  const names = request.tools.map((tool) => {
    if (typeof tool !== 'object' || tool === null || Array.isArray(tool)) {
      throw new Error('Acosmi snapshot received a malformed tool definition')
    }
    const candidate = 'name' in tool ? tool.name : undefined
    if (typeof candidate !== 'string' || candidate === '') {
      throw new Error('Acosmi snapshot received a tool without a name')
    }
    return candidate
  })
  if (new Set(names).size !== names.length) {
    throw new Error('Acosmi snapshot received duplicate Harness tool names')
  }
  if (names.filter(candidate => candidate === 'web_search').length !== 1) {
    throw new Error('Acosmi snapshot expected exactly one client web_search tool')
  }
}

function assertParallelToolResultsShareOneUserTurn(request: FixtureChatRequest): void {
  if (!isUnknownArray(request.rawMessages)) {
    throw new Error('Acosmi snapshot expected serialized raw messages')
  }
  for (const [index, message] of request.rawMessages.entries()) {
    if (messageRole(message) === 'user' && messageRole(request.rawMessages[index - 1]) === 'user') {
      throw new Error('Acosmi snapshot received consecutive Anthropic user turns')
    }
  }
  const final = request.rawMessages.at(-1)
  if (typeof final !== 'object' || final === null || Array.isArray(final)
    || !('content' in final) || !isUnknownArray(final.content)) {
    throw new Error('Acosmi snapshot expected a final Anthropic user turn')
  }
  const ids = final.content.map((block) => {
    if (typeof block !== 'object' || block === null || Array.isArray(block)
      || !('type' in block) || block.type !== 'tool_result'
      || !('tool_use_id' in block) || typeof block.tool_use_id !== 'string') {
      throw new Error('Acosmi snapshot received a malformed parallel tool result')
    }
    return block.tool_use_id
  })
  if (ids.length !== 2 || ids[0] !== 'fixture-call-1' || ids[1] !== 'fixture-call-2') {
    throw new Error('Acosmi snapshot expected both parallel tool results in provider order')
  }
}

function messageRole(value: unknown): unknown {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'role' in value
    ? value.role
    : undefined
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function createClient() {
  let requests = 0
  return {
    isAuthorized: (): boolean => true,
    chatMessagesStream(
      _modelId: string,
      request: FixtureChatRequest,
      signal?: AbortSignal,
      onUpstreamActivity?: () => void,
    ): AsyncIterable<FixtureStreamEvent> {
      assertRequest(request)
      requests++
      if (requests === 2) assertParallelToolResultsShareOneUserTurn(request)
      if (requests > 2) throw new Error('Acosmi snapshot received an unexpected third request')
      const response = requests === 1 ? TOOL_RESPONSE : RESPONSE
      return {
        async * [Symbol.asyncIterator](): AsyncIterator<FixtureStreamEvent> {
          for (const event of response) {
            if (signal?.aborted === true) throw signal.reason
            onUpstreamActivity?.()
            yield structuredClone(event)
          }
        },
      }
    },
  }
}

/** Provide a deterministic authorized account at the SDK-client seam. */
export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  const client = createClient()
  const account = {
    models: async () => ({
      models: [structuredClone(MODEL)],
      status: 'ok',
    }),
    sdkSession: () => ({ client, signal: lifetime.signal }),
    subscribe(owner: Context, listener: (snapshot: AcosmiAccountSnapshot) => void): () => void {
      const dispose = owner.effect(function* () {
        listener(structuredClone(SNAPSHOT))
        yield () => {}
      }, 'acosmi-account-snapshot-fixture.subscription')
      return () => { void dispose() }
    },
  } as unknown as AcosmiAccountService
  ctx.provide('acosmiAccount', account)
  ctx.effect(() => () => { lifetime.abort(new Error('Acosmi snapshot fixture stopped')) })
}
