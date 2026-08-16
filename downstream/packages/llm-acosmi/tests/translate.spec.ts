import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@acosmi/sdk-ts'
import {
  ACOSMI_TOOL_NAME_COLLISION_CODE,
  ACOSMI_WINDOW_LIMIT_CODE,
} from '../src/errors.ts'
import { translateAcosmiStream } from '../src/translate.ts'

function event(name: string, value: unknown, metadata: Partial<StreamEvent> = {}): StreamEvent {
  return { event: name, data: JSON.stringify(value), ...metadata } as StreamEvent
}

async function collect(events: StreamEvent[]): Promise<unknown[]> {
  async function* source(): AsyncIterable<StreamEvent> {
    for (const item of events) yield item
  }
  const result: unknown[] = []
  for await (const item of translateAcosmiStream(source(), 'managed-model')) result.push(item)
  return result
}

describe('Acosmi stream translation', () => {
  it('translates text, thinking, tools, usage, finish, and lossless replay state', async () => {
    const chunks = await collect([
      event('started', {}),
      event('sources', { sources: [] }),
      event('pending_settle', {}),
      event('settled', {}),
      event('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 2 } } }),
      event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }),
      event('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'sig' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'text', text: 'pre' } }),
      event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: 'fix' } }),
      event('content_block_stop', { index: 1 }),
      event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'lookup', input: {} } }),
      event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } }),
      event('content_block_stop', { index: 2 }),
      event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }),
      event('message_stop', {}),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'reason' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reason' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'fix' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'prefix' } },
      { type: 'block-start', index: 2, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 2, id: 'call-1', name: 'lookup', argumentsDelta: '{"q":"x"}' },
      { type: 'block-end', index: 2, block: { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"q":"x"}' } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 7, cacheReadTokens: 2 } },
      {
        type: 'finish',
        reason: { kind: 'tool-calls' },
        replayState: {
          format: 'acosmi-anthropic-v1',
          version: 1,
          model: 'managed-model',
          content: [
            { type: 'thinking', thinking: 'reason', signature: 'sig' },
            { type: 'text', text: 'prefix' },
            { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } },
          ],
        },
      },
    ])
  })

  it('retains redacted thinking in replay without exposing it as model-visible content', async () => {
    const chunks = await collect([
      event('content_block_start', { index: 0, content_block: { type: 'redacted_thinking', data: 'opaque' } }),
      event('content_block_stop', { index: 0 }),
      event('content_block_start', { index: 1, content_block: { type: 'text', text: 'answer' } }),
      event('content_block_stop', { index: 1 }),
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
      event('message_stop', {}),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          format: 'acosmi-anthropic-v1',
          version: 1,
          model: 'managed-model',
          content: [
            { type: 'redacted_thinking', data: 'opaque' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
    ])
  })

  it('keeps managed web-search blocks out of Harness tools while preserving citations and ephemeral replay', async () => {
    const citation = {
      type: 'web_search_result_location',
      url: 'https://example.test/source',
      title: 'Source',
      cited_text: 'Evidence',
    }
    const chunks = await collect([
      event('content_block_start', {
        index: 0,
        content_block: {
          type: 'server_tool_use',
          id: 'srv-1',
          name: 'web_search',
          input: {},
          acosmi_ephemeral: true,
        },
      }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: true }),
      event('content_block_delta', {
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"query":"current evidence"}' },
      }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: true }),
      event('content_block_stop', { index: 0 }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: true }),
      event('content_block_start', {
        index: 1,
        content_block: {
          type: 'web_search_tool_result',
          tool_use_id: 'srv-1',
          content: [{ type: 'web_search_result', url: citation.url, title: citation.title }],
          acosmi_ephemeral: true,
        },
      }, { blockIndex: 1, blockType: 'web_search_tool_result', ephemeral: true }),
      event('content_block_stop', { index: 1 }, {
        blockIndex: 1,
        blockType: 'web_search_tool_result',
        ephemeral: true,
      }),
      event('content_block_start', {
        index: 2,
        content_block: { type: 'text', text: '', citations: [] },
      }, { blockIndex: 2, blockType: 'text', ephemeral: false }),
      event('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Answer' } }, {
        blockIndex: 2,
        blockType: 'text',
        ephemeral: false,
      }),
      event('content_block_delta', { index: 2, delta: { type: 'citations_delta', citation } }, {
        blockIndex: 2,
        blockType: 'text',
        ephemeral: false,
      }),
      event('content_block_stop', { index: 2 }, { blockIndex: 2, blockType: 'text', ephemeral: false }),
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
      event('message_stop', {}),
    ])

    expect(chunks).toEqual([
      { type: 'block-start', index: 2, blockType: 'text' },
      { type: 'text-delta', index: 2, text: 'Answer' },
      { type: 'block-end', index: 2, block: { type: 'text', text: 'Answer' } },
      {
        type: 'finish',
        reason: { kind: 'stop' },
        replayState: {
          format: 'acosmi-anthropic-v1',
          version: 1,
          model: 'managed-model',
          content: [
            {
              type: 'server_tool_use',
              id: 'srv-1',
              name: 'web_search',
              input: { query: 'current evidence' },
              acosmi_ephemeral: true,
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'srv-1',
              content: [{ type: 'web_search_result', url: citation.url, title: citation.title }],
              acosmi_ephemeral: true,
            },
            { type: 'text', text: 'Answer', citations: [citation] },
          ],
        },
      },
    ])
  })

  it('normalizes an in-band rolling-window rejection without claiming exhausted quota', async () => {
    await expect(collect([
      event('error', {
        error: {
          type: 'rate_limit_error',
          code: 'window_limit_exceeded',
          message: '已达 7 天用量上限',
        },
      }),
    ])).rejects.toMatchObject({
      code: ACOSMI_WINDOW_LIMIT_CODE,
      message: 'Acosmi rolling-window reservation rejected this request.',
    })
  })

  it('normalizes an in-band duplicate function name as a provider tool collision', async () => {
    await expect(collect([
      event('failed', {
        error: {
          type: 'invalid_request_error',
          message: 'Invalid request: function name web_search is duplicated',
        },
      }),
    ])).rejects.toMatchObject({
      code: ACOSMI_TOOL_NAME_COLLISION_CODE,
      message: 'Acosmi managed-model gateway produced duplicate final tool names.',
    })
  })

  it('fails closed on an empty success or an unsupported stop reason', async () => {
    await expect(collect([
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
      event('message_stop', {}),
    ])).resolves.toEqual([{
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: 'Acosmi managed-model service returned an empty response.',
          code: 'EMPTY_RESPONSE',
        },
      },
    }])

    await expect(collect([
      event('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } }),
      event('content_block_stop', { index: 0 }),
      event('message_delta', { delta: { stop_reason: 'content_filter' } }),
      event('message_stop', {}),
    ])).resolves.toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'partial' } },
      {
        type: 'finish',
        reason: {
          kind: 'error',
          failure: {
            message: 'Acosmi model stopped for an unsupported provider reason.',
            code: 'PROVIDER',
          },
        },
      },
    ])
  })

  it.each([
    ['invalid JSON', [{ event: 'message_start', data: '{' } as StreamEvent], /malformed message_start event JSON/],
    ['duplicate block', [
      event('content_block_start', { index: 0, content_block: { type: 'text' } }),
      event('content_block_start', { index: 0, content_block: { type: 'text' } }),
    ], /duplicate content block/],
    ['unopened delta', [event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } })], /unopened/],
    ['mismatched delta', [
      event('content_block_start', { index: 0, content_block: { type: 'text' } }),
      event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'x' } }),
    ], /does not match/],
    ['mismatched ephemeral metadata', [event('content_block_start', {
      index: 0,
      content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {}, acosmi_ephemeral: true },
    }, { blockIndex: 0, blockType: 'server_tool_use', ephemeral: false })], /ephemeral metadata/],
    ['mismatched delta metadata', [
      event('content_block_start', { index: 0, content_block: { type: 'text' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'x' } }, {
        blockIndex: 1,
        blockType: 'text',
        ephemeral: false,
      }),
    ], /SDK index metadata/],
    ['unknown server-tool replay field', [
      event('content_block_start', {
        index: 0,
        content_block: { type: 'server_tool_use', id: 'srv', name: 'web_search', input: {}, injected: true },
      }),
      event('content_block_stop', { index: 0 }),
    ], /unknown fields/],
    ['invalid citation delta', [
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'citations_delta', citation: [] } }),
    ], /citation is not an object/],
    ['empty tool identity', [
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: '', name: 'lookup', input: {} } }),
    ], /id is empty/],
    ['missing finish reason', [
      event('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } }),
      event('content_block_stop', { index: 0 }),
      event('message_stop', {}),
    ], /without a finish reason/],
    ['empty finish reason', [
      event('message_delta', { delta: { stop_reason: '' } }),
    ], /stop reason is missing/],
    ['duplicate finish reason', [
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
    ], /after its finish reason/],
    ['content after finish reason', [
      event('message_delta', { delta: { stop_reason: 'end_turn' } }),
      event('content_block_start', { index: 0, content_block: { type: 'text', text: 'late' } }),
    ], /after its finish reason/],
    ['malformed sources metadata', [event('sources', { sources: 'not-an-array' })], /sources event is invalid/],
    ['unknown stream event', [event('future_content', {})], /unsupported event type/],
    ['malformed tool JSON', [
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call', name: 'x', input: {} } }),
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }),
      event('content_block_stop', { index: 0 }),
    ], /malformed tool-call JSON/],
    ['open block at stop', [
      event('content_block_start', { index: 0, content_block: { type: 'text' } }),
      event('message_stop', {}),
    ], /open content blocks/],
    ['provider error', [event('error', {
      error: { type: 'rate_limit_error', message: 'token=plain-secret account=private' },
    })], /Acosmi provider rate limit rejected this request/],
    ['truncated stream', [event('ping', {})], /without message_stop/],
  ])('rejects %s', async (_label, events, expected) => {
    await expect(collect(events as StreamEvent[])).rejects.toThrow(expected as RegExp)
  })
})
