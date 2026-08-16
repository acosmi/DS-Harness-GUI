import { createHash } from 'node:crypto'
import { Client, type ManagedModel } from '@acosmi/sdk-ts'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { serializeAcosmiRequest } from '../src/serialize.ts'

function model(
  capabilities: Record<string, unknown> = {},
  overrides: Partial<ManagedModel> = {},
): ManagedModel {
  return {
    id: 'managed-model',
    name: 'Managed Model',
    provider: 'anthropic',
    modelId: 'claude-test',
    maxTokens: 8192,
    isEnabled: true,
    capabilities: {
      supports_thinking: true,
      supports_adaptive_thinking: true,
      supports_isp: false,
      supports_web_search: false,
      supports_tool_search: false,
      supports_structured_output: false,
      supports_effort: true,
      supports_max_effort: true,
      supports_fast_mode: false,
      supports_auto_mode: false,
      supports_1m_context: false,
      supports_prompt_cache: false,
      supports_cache_editing: false,
      supports_token_efficient: false,
      supports_redact_thinking: true,
      max_input_tokens: 100_000,
      max_output_tokens: 8192,
      ...capabilities,
    },
    ...overrides,
  } as ManagedModel
}

function message(role: Message['role'], content: Message['content'], source: Message['source']): Message {
  return { id: 'message-id' as never, role, content, source }
}

function options(messages: Message[], overrides: Partial<GenerateOptions> = {}): GenerateOptions {
  return {
    provider: 'acosmi',
    model: 'managed-model',
    messages,
    ...overrides,
  }
}

describe('Acosmi request serialization', () => {
  it('maps user, tool, request, and reasoning controls without hidden prompt text', () => {
    const requestOptions = options([
      message('user', [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      message('assistant', [
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call-1' as never, name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'tool-call', id: 'call-2' as never, name: 'inspect', arguments: '{"path":"y"}' },
      ], { kind: 'model', provider: 'acosmi', model: 'managed-model' }),
      message('user', [{
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }], { kind: 'tool', callId: 'call-1' as never }),
      message('user', [{
        type: 'tool-result',
        toolCallId: 'call-2' as never,
        content: [{ type: 'text', text: 'inspection' }],
      }], { kind: 'tool', callId: 'call-2' as never }),
      message('user', [{ type: 'text', text: 'continue' }], { kind: 'user' }),
    ], {
      system: 'system text',
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      temperature: 0.2,
      maxTokens: 500,
      stop: ['STOP'],
      reasoningEffort: ReasoningEffortId('high'),
      sessionId: 'session/a b' as never,
    })
    const request = serializeAcosmiRequest(requestOptions, model())

    expect(request).toEqual({
      rawMessages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } },
          { type: 'tool_use', id: 'call-2', name: 'inspect', input: { path: 'y' } },
        ] },
        { role: 'user', content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'result', is_error: false },
          { type: 'tool_result', tool_use_id: 'call-2', content: 'inspection' },
          { type: 'text', text: 'continue' },
        ] },
      ],
      system: 'system text',
      tools: [{ name: 'lookup', description: 'Lookup', input_schema: { type: 'object' } }],
      temperature: 0.2,
      max_tokens: 500,
      thinking: { type: 'adaptive', level: 'high' },
      extraBody: { stop_sequences: ['STOP'] },
      endUserId: `dsh_${createHash('sha256').update('session/a b').digest('hex')}`,
    })
    expect(request.endUserId).not.toContain('session')
    expect(serializeAcosmiRequest(requestOptions, model({}, {
      provider: 'deepseek',
      supported_formats: ['anthropic'],
      preferred_format: 'anthropic',
    })).rawMessages).toEqual(request.rawMessages)
  })

  it('replays signed provider blocks for the same model and removes signed reasoning after a model switch', () => {
    const replay = {
      format: 'acosmi-anthropic-v1',
      version: 1,
      model: 'managed-model',
      content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'signed' },
        { type: 'text', text: 'answer' },
      ],
    }
    const history = message('assistant', [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'answer' },
    ], { kind: 'model', provider: 'acosmi', model: 'managed-model', replayState: replay })
    expect(serializeAcosmiRequest(options([history]), model()).rawMessages)
      .toEqual([{ role: 'assistant', content: replay.content }])

    const wrongModel = { ...history, source: { ...history.source, replayState: { ...replay, model: 'other' } } } as Message
    expect(() => serializeAcosmiRequest(options([wrongModel]), model())).toThrow(/assistant source/)
    expect(serializeAcosmiRequest(options([history], { model: 'other' }), model()).rawMessages)
      .toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'answer' }] }])

    const changedProjection = {
      ...history,
      content: [
        { type: 'reasoning' as const, text: 'modified reasoning' },
        { type: 'text' as const, text: 'answer' },
      ],
    }
    expect(() => serializeAcosmiRequest(options([changedProjection], { model: 'other' }), model()))
      .toThrow(/content does not match the durable assistant projection/)
  })

  it('keeps same-model reasoning portable when the provider format changes', () => {
    const signedReplay = {
      format: 'acosmi-anthropic-v1',
      version: 1,
      model: 'managed-model',
      content: [
        { type: 'thinking', thinking: 'signed reasoning', signature: 'signed' },
        { type: 'text', text: 'answer' },
      ],
    }
    const signedHistory = message('assistant', [
      { type: 'reasoning', text: 'signed reasoning' },
      { type: 'text', text: 'answer' },
    ], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: signedReplay,
    })
    const openAIModel = model({}, {
      provider: 'deepseek',
      supported_formats: ['openai'],
      preferred_format: 'openai',
    })
    expect(serializeAcosmiRequest(options([signedHistory]), openAIModel).rawMessages).toEqual([{
      role: 'assistant',
      content: 'answer',
    }])

    const unsignedReplay = {
      ...signedReplay,
      content: [
        { type: 'thinking', thinking: 'unsigned reasoning' },
        { type: 'text', text: 'answer' },
      ],
    }
    const unsignedHistory = message('assistant', [
      { type: 'reasoning', text: 'unsigned reasoning' },
      { type: 'text', text: 'answer' },
    ], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: unsignedReplay,
    })
    expect(serializeAcosmiRequest(options([unsignedHistory]), model()).rawMessages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    }])
  })

  it('omits a reasoning-only response when switching models instead of creating an empty assistant message', () => {
    const replay = {
      format: 'acosmi-anthropic-v1',
      version: 1,
      model: 'managed-model',
      content: [{ type: 'thinking', thinking: 'private reasoning', signature: 'signed' }],
    }
    const history = message('assistant', [{ type: 'reasoning', text: 'private reasoning' }], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: replay,
    })

    expect(serializeAcosmiRequest(options([history], { model: 'other' }), model()).rawMessages).toEqual([])
  })

  it('retains ephemeral markers so the SDK still strips temporary portable history', () => {
    const replay = {
      format: 'acosmi-anthropic-v1',
      version: 1,
      model: 'managed-model',
      content: [
        { type: 'text', text: 'permanent' },
        { type: 'text', text: 'temporary', acosmi_ephemeral: true },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'lookup',
          input: { q: 'temporary' },
          acosmi_ephemeral: true,
        },
      ],
    }
    const history = message('assistant', [
      { type: 'text', text: 'permanent' },
      { type: 'text', text: 'temporary' },
      { type: 'tool-call', id: 'call-1' as never, name: 'lookup', arguments: '{"q":"temporary"}' },
    ], { kind: 'model', provider: 'acosmi', model: 'managed-model', replayState: replay })
    const request = serializeAcosmiRequest(options([history], { model: 'other' }), model())
    const client = new Client({
      store: {
        async save() {},
        async load() { return null },
        async clear() {},
      },
    })

    expect(request.rawMessages).toEqual([{ role: 'assistant', content: [
      { type: 'text', text: 'permanent' },
      { type: 'text', text: 'temporary', acosmi_ephemeral: true },
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'lookup',
        input: { q: 'temporary' },
        acosmi_ephemeral: true,
      },
    ] }])
    client.setAutoStripEphemeralHistory(true)
    client.applyRequestSanitizers(request)
    expect(request.rawMessages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'permanent' }],
    }])
  })

  it('matches signed tool replay by JSON value instead of argument formatting', () => {
    const replay = {
      format: 'acosmi-anthropic-v1',
      version: 1,
      model: 'managed-model',
      content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'signed' },
        { type: 'tool_use', id: 'call-1', name: 'lookup', input: { nested: { b: 2, a: 1 } } },
      ],
    }
    const history = message('assistant', [
      { type: 'reasoning', text: 'private reasoning' },
      {
        type: 'tool-call',
        id: 'call-1' as never,
        name: 'lookup',
        arguments: '{ "nested": { "a": 1, "b": 2 } }',
      },
    ], { kind: 'model', provider: 'acosmi', model: 'managed-model', replayState: replay })

    expect(serializeAcosmiRequest(options([history]), model()).rawMessages)
      .toEqual([{ role: 'assistant', content: replay.content }])
    const result = message('user', [{
      type: 'tool-result',
      toolCallId: 'call-1' as never,
      content: [{ type: 'text', text: 'result' }],
    }], { kind: 'tool', callId: 'call-1' as never })
    expect(serializeAcosmiRequest(options([history, result], { model: 'other' }), model()).rawMessages)
      .toEqual([
        { role: 'assistant', content: [{
          type: 'tool_use',
          id: 'call-1',
          name: 'lookup',
          input: { nested: { b: 2, a: 1 } },
        }] },
        { role: 'user', content: [{
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'result',
        }] },
      ])
  })

  it('replays validated managed-search metadata through the SDK client history sanitizer', () => {
    const citation = {
      type: 'web_search_result_location',
      url: 'https://example.test/source',
      title: 'Source',
      cited_text: 'Evidence',
    }
    const replay = {
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
    }
    const history = message('assistant', [{ type: 'text', text: 'Answer' }], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: replay,
    })
    const request = serializeAcosmiRequest(options([history]), model())
    const client = new Client({
      store: {
        async save() {},
        async load() { return null },
        async clear() {},
      },
    })

    expect(request.rawMessages).toEqual([{ role: 'assistant', content: replay.content }])
    client.setAutoStripEphemeralHistory(true)
    client.applyRequestSanitizers(request)
    expect(request.rawMessages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Answer', citations: [citation] }],
    }])
    expect(serializeAcosmiRequest(options([history], { model: 'other' }), model()).rawMessages).toEqual([{
      role: 'assistant',
      content: [{ type: 'text', text: 'Answer' }],
    }])
  })

  it('rejects replay state with injected fields or a model that disagrees with its durable source', () => {
    const injected = message('assistant', [{ type: 'text', text: 'answer' }], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: {
        format: 'acosmi-anthropic-v1',
        version: 1,
        model: 'managed-model',
        content: [{ type: 'text', text: 'answer', hidden: 'provider-directive' }],
      },
    })
    expect(() => serializeAcosmiRequest(options([injected]), model())).toThrow(/Invalid Acosmi replay state/)

    const wrongSource = message('assistant', [{ type: 'text', text: 'answer' }], {
      kind: 'model',
      provider: 'acosmi',
      model: 'historical-model',
      replayState: {
        format: 'acosmi-anthropic-v1',
        version: 1,
        model: 'managed-model',
        content: [{ type: 'text', text: 'answer' }],
      },
    })
    expect(() => serializeAcosmiRequest(options([wrongSource]), model())).toThrow(/assistant source/)
  })

  it('uses OpenAI-native messages and function tools for OpenAI-format account models', () => {
    const openAIModel = model({}, {
      provider: 'deepseek',
      supported_formats: ['openai'],
      preferred_format: 'openai',
    })
    const request = serializeAcosmiRequest(options([
      message('user', [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      message('assistant', [
        { type: 'reasoning', text: 'reasoning' },
        { type: 'text', text: 'calling' },
        { type: 'tool-call', id: 'call-1' as never, name: 'lookup', arguments: '{"q":"x"}' },
      ], {
        kind: 'model',
        provider: 'acosmi',
        model: 'managed-model',
        replayState: {
          format: 'acosmi-anthropic-v1',
          version: 1,
          model: 'managed-model',
          content: [
            { type: 'thinking', thinking: 'reasoning' },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'call-1', name: 'lookup', input: { q: 'x' } },
          ],
        },
      }),
      message('user', [{
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [{ type: 'text', text: 'result' }],
      }], { kind: 'tool', callId: 'call-1' as never }),
    ], {
      tools: [{ name: 'lookup', description: 'Lookup', parameters: { type: 'object' } }],
      stop: ['STOP'],
    }), openAIModel)

    expect(request.rawMessages).toEqual([
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'calling',
        reasoning_content: 'reasoning',
        tool_calls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"x"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call-1', content: 'result' },
    ])
    expect(request.tools).toEqual([{
      type: 'function',
      function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
    }])
    expect(request.extraBody).toEqual({ stop: ['STOP'] })
  })

  it('converts Anthropic replay to portable OpenAI history and removes ephemeral linked results', () => {
    const openAIModel = model({}, {
      id: 'openai-model',
      provider: 'deepseek',
      supported_formats: ['openai'],
      preferred_format: 'openai',
    })
    const history = message('assistant', [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: 'permanent' },
      { type: 'text', text: 'temporary' },
      { type: 'tool-call', id: 'call-1' as never, name: 'keep', arguments: '{"q":"keep"}' },
      { type: 'tool-call', id: 'call-2' as never, name: 'drop', arguments: '{"q":"drop"}' },
    ], {
      kind: 'model',
      provider: 'acosmi',
      model: 'managed-model',
      replayState: {
        format: 'acosmi-anthropic-v1',
        version: 1,
        model: 'managed-model',
        content: [
          { type: 'thinking', thinking: 'private reasoning', signature: 'signed' },
          { type: 'text', text: 'permanent' },
          { type: 'text', text: 'temporary', acosmi_ephemeral: true },
          { type: 'tool_use', id: 'call-1', name: 'keep', input: { q: 'keep' } },
          {
            type: 'tool_use',
            id: 'call-2',
            name: 'drop',
            input: { q: 'drop' },
            acosmi_ephemeral: true,
          },
        ],
      },
    })
    const toolResults = message('user', [
      {
        type: 'tool-result',
        toolCallId: 'call-1' as never,
        content: [{ type: 'text', text: 'kept result' }],
      },
      {
        type: 'tool-result',
        toolCallId: 'call-2' as never,
        content: [{ type: 'text', text: 'temporary result' }],
      },
    ], { kind: 'tool', callId: 'call-2' as never })

    expect(serializeAcosmiRequest(options([history, toolResults], { model: 'openai-model' }), openAIModel).rawMessages)
      .toEqual([
        {
          role: 'assistant',
          content: 'permanent',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'keep', arguments: '{"q":"keep"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'kept result' },
      ])
  })

  it('maps title requests to thinking off and rejects unsupported or lossy history', () => {
    expect(serializeAcosmiRequest(options([], {
      purpose: 'session-title',
      reasoningEffort: ReasoningEffortId('max'),
    }), model()).thinking).toEqual({ type: 'disabled', level: 'off' })
    expect(() => serializeAcosmiRequest(options([], { reasoningEffort: ReasoningEffortId('max') }),
      model({ supports_max_effort: false }))).toThrow(/does not support/)
    expect(() => serializeAcosmiRequest(options([
      message('system', [{ type: 'text', text: 'bad' }], { kind: 'plugin', plugin: 'test', form: 'relay' }),
    ]), model())).toThrow(/in-band system/)
    expect(() => serializeAcosmiRequest(options([
      message('user', [{ type: 'image', mimeType: 'image/png', data: 'AA==' }], { kind: 'user' }),
    ]), model())).toThrow(/image blocks/)
    expect(() => serializeAcosmiRequest(options([
      message('assistant', [{ type: 'tool-call', id: 'call' as never, name: 'x', arguments: '{' }], {
        kind: 'model', provider: 'acosmi', model: 'managed-model',
      }),
    ]), model())).toThrow(/invalid JSON/)
    expect(() => serializeAcosmiRequest(options([
      message('user', [{
        type: 'tool-result',
        toolCallId: 'call' as never,
        content: [{ type: 'reasoning', text: 'must not be dropped' }],
      }], { kind: 'tool', callId: 'call' as never }),
    ]), model())).toThrow(/cannot contain reasoning/)
  })

  it('omits the title-request thinking field for a non-reasoning model', () => {
    const nonReasoning = model({
      supports_thinking: false,
      supports_adaptive_thinking: false,
      supports_effort: false,
      supports_max_effort: false,
    })

    expect(serializeAcosmiRequest(options([], { purpose: 'session-title' }), nonReasoning).thinking)
      .toBeUndefined()
  })
})
