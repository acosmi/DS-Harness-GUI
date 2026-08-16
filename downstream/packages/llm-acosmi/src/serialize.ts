/** Harness-to-Anthropic request conversion for the Acosmi managed-model API. */

import { createHash } from 'node:crypto'
import { getAdapterForModel, ProviderFormat } from '@acosmi/sdk-ts'
import type { ChatRequest, ManagedModel } from '@acosmi/sdk-ts'
import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'

/** Lossless provider state retained with a successful assistant message. */
export interface AcosmiReplayState {
  readonly format: 'acosmi-anthropic-v1'
  readonly version: 1
  readonly model: string
  readonly content: readonly Record<string, unknown>[]
}

/** Convert one Harness request without adding prompt text or hidden tools. */
export function serializeAcosmiRequest(options: GenerateOptions, model: ManagedModel): ChatRequest {
  const format = getAdapterForModel(model).format()
  const effort = resolveEffort(options, model)
  const tools = serializeTools(options, format)
  const replays = validateAssistantReplays(options.messages)
  const omittedToolResults = format === ProviderFormat.OpenAI
    ? collectEphemeralToolCallIds(replays)
    : new Set<string>()
  const serializedMessages = options.messages.flatMap(message => (
    serializeMessage(message, options.model, format, replays.get(message), omittedToolResults)
  ))
  return {
    rawMessages: format === ProviderFormat.Anthropic
      ? coalesceAnthropicUserMessages(serializedMessages)
      : serializedMessages,
    ...(options.system === undefined ? {} : { system: options.system }),
    ...(tools === undefined || tools.length === 0 ? {} : { tools }),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    ...(effort === undefined ? {} : { thinking: effort }),
    ...(options.stop === undefined
      ? {}
      : { extraBody: format === ProviderFormat.Anthropic ? { stop_sequences: options.stop } : { stop: options.stop } }),
    ...(options.sessionId === undefined ? {} : { endUserId: opaqueSessionId(options.sessionId) }),
  }
}

/** Keep consecutive Anthropic user content, including parallel tool results, in one provider turn. */
function coalesceAnthropicUserMessages(
  messages: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const message of messages) {
    const previous = result.at(-1)
    if (message.role !== 'user' || previous?.role !== 'user') {
      result.push(message)
      continue
    }
    previous.content = [
      ...(previous.content as Record<string, unknown>[]),
      ...(message.content as Record<string, unknown>[]),
    ]
  }
  return result
}

function serializeTools(options: GenerateOptions, format: ProviderFormat): unknown[] | undefined {
  if (options.tools === undefined) return undefined
  return options.tools.map(tool => format === ProviderFormat.Anthropic
    ? {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }
    : {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })
}

function serializeMessage(
  message: Message,
  targetModel: string,
  format: ProviderFormat,
  replay: AcosmiReplayState | undefined,
  omittedToolResults: ReadonlySet<string>,
): Record<string, unknown>[] {
  if (contentHasImage(message.content)) {
    throw new LlmError('Acosmi managed-model chat does not yet support Harness image blocks.', 'UNSUPPORTED_CONTENT')
  }
  if (message.role === 'system') {
    throw new LlmError('Acosmi history cannot contain an in-band system message.', 'UNSUPPORTED_CONTENT')
  }
  if (format === ProviderFormat.OpenAI) {
    return serializeOpenAIMessage(message, targetModel, replay, omittedToolResults)
  }
  if (message.role === 'assistant') {
    if (replay !== undefined) {
      if (replay.model === targetModel && canReplayExactAnthropic(replay.content)) {
        return [{ role: 'assistant', content: structuredClone(replay.content) }]
      }
      const content = serializePortableAssistantBlocks(message.content, replay.content)
      return content.length === 0 ? [] : [{ role: 'assistant', content }]
    }
    return [{ role: 'assistant', content: serializeAssistantBlocks(message.content) }]
  }

  const content: Record<string, unknown>[] = []
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'tool-result':
        content.push({
          type: 'tool_result',
          tool_use_id: block.toolCallId,
          content: flattenResult(block.content),
          ...(block.isError === undefined ? {} : { is_error: block.isError }),
        })
        break
      case 'reasoning':
      case 'tool-call':
        throw new LlmError(`Acosmi user history cannot contain ${block.type} blocks.`, 'UNSUPPORTED_CONTENT')
      case 'image':
        throw new LlmError('Acosmi managed-model chat does not yet support Harness image blocks.', 'UNSUPPORTED_CONTENT')
      default:
        throw new LlmError('Acosmi cannot serialize an extension content block.', 'UNSUPPORTED_CONTENT')
    }
  }
  return [{ role: 'user', content }]
}

function serializeOpenAIMessage(
  message: Message,
  targetModel: string,
  replay: AcosmiReplayState | undefined,
  omittedToolResults: ReadonlySet<string>,
): Record<string, unknown>[] {
  if (message.role === 'assistant') {
    const source = message.source.kind === 'model' ? message.source : undefined
    const portable = source !== undefined
      && (source.provider !== 'acosmi'
        || source.model !== targetModel
        || (replay !== undefined && hasAnthropicSignedState(replay.content)))
    const serialized = serializeOpenAIAssistant(message, replay, portable)
    return serialized === undefined ? [] : [serialized]
  }

  const messages: Record<string, unknown>[] = []
  let text = ''
  let omittedToolResult = false
  const flushText = (): void => {
    if (text === '') return
    messages.push({ role: 'user', content: text })
    text = ''
  }
  for (const block of message.content) {
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'tool-result':
        if (omittedToolResults.has(block.toolCallId)) {
          omittedToolResult = true
          break
        }
        flushText()
        messages.push({
          role: 'tool',
          tool_call_id: block.toolCallId,
          content: flattenResult(block.content),
        })
        break
      case 'reasoning':
      case 'tool-call':
        throw new LlmError(`Acosmi OpenAI user history cannot contain ${block.type} blocks.`, 'UNSUPPORTED_CONTENT')
      case 'image':
        throw new LlmError('Acosmi managed-model chat does not yet support Harness image blocks.', 'UNSUPPORTED_CONTENT')
      default:
        throw new LlmError('Acosmi cannot serialize an extension content block.', 'UNSUPPORTED_CONTENT')
    }
  }
  flushText()
  return messages.length === 0 && !omittedToolResult ? [{ role: 'user', content: '' }] : messages
}

function serializeOpenAIAssistant(
  message: Message,
  replay: AcosmiReplayState | undefined,
  portable: boolean,
): Record<string, unknown> | undefined {
  let text = ''
  let reasoning = ''
  const toolCalls: Record<string, unknown>[] = []
  const visibleReplay = replay === undefined ? undefined : visibleReplayBlocks(replay.content)
  for (const [index, block] of message.content.entries()) {
    const replayBlock = visibleReplay?.[index]
    if (block.type !== 'reasoning' && replayBlock?.acosmi_ephemeral === true) continue
    switch (block.type) {
      case 'text':
        text += block.text
        break
      case 'reasoning':
        if (replay === undefined && message.source.kind === 'model' && message.source.provider === 'acosmi') {
          throw invalidReplay('reasoning history is missing its provider replay')
        }
        if (!portable) reasoning += block.text
        break
      case 'tool-call':
        assertJsonArguments(block.arguments)
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.arguments },
        })
        break
      case 'tool-result':
      case 'image':
        throw new LlmError(`Acosmi OpenAI assistant history cannot contain ${block.type} blocks.`, 'UNSUPPORTED_CONTENT')
      default:
        throw new LlmError('Acosmi cannot serialize an extension content block.', 'UNSUPPORTED_CONTENT')
    }
  }
  if ((replay !== undefined || portable) && text === '' && reasoning === '' && toolCalls.length === 0) {
    return undefined
  }
  return {
    role: 'assistant',
    content: text,
    ...(reasoning === '' ? {} : { reasoning_content: reasoning }),
    ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
  }
}

function validateAssistantReplays(messages: readonly Message[]): ReadonlyMap<Message, AcosmiReplayState> {
  const replays = new Map<Message, AcosmiReplayState>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    const source = message.source.kind === 'model' ? message.source : undefined
    const replay = readReplayState(source?.replayState)
    if (replay === undefined) continue
    if (source?.provider !== 'acosmi' || replay.model !== source.model) {
      throw invalidReplay('model does not match the assistant source')
    }
    if (!replayMatches(message.content, replay.content)) {
      throw invalidReplay('content does not match the durable assistant projection')
    }
    replays.set(message, replay)
  }
  return replays
}

function collectEphemeralToolCallIds(replays: ReadonlyMap<Message, AcosmiReplayState>): ReadonlySet<string> {
  const result = new Set<string>()
  for (const [message, replay] of replays) {
    const visibleReplay = visibleReplayBlocks(replay.content)
    for (const [index, block] of message.content.entries()) {
      if (block.type === 'tool-call' && visibleReplay[index]?.acosmi_ephemeral === true) {
        result.add(block.id)
      }
    }
  }
  return result
}

function assertJsonArguments(argumentsJson: string): void {
  try {
    JSON.parse(argumentsJson)
  } catch (cause) {
    throw new LlmError('Acosmi tool-call history contains invalid JSON arguments.', 'INVALID_REPLAY_STATE', { cause })
  }
}

function serializeAssistantBlocks(blocks: readonly ContentBlock[]): Record<string, unknown>[] {
  return blocks.map(block => {
    switch (block.type) {
      case 'text':
        return { type: 'text', text: block.text }
      case 'reasoning':
        throw new LlmError(
          'Acosmi reasoning history is missing its provider signature and cannot be replayed safely.',
          'INVALID_REPLAY_STATE',
        )
      case 'tool-call': {
        assertJsonArguments(block.arguments)
        const input = JSON.parse(block.arguments) as unknown
        return { type: 'tool_use', id: block.id, name: block.name, input }
      }
      case 'tool-result':
      case 'image':
        throw new LlmError(`Acosmi assistant history cannot contain ${block.type} blocks.`, 'UNSUPPORTED_CONTENT')
      default:
        throw new LlmError('Acosmi cannot serialize an extension content block.', 'UNSUPPORTED_CONTENT')
    }
  })
}

/** Remove provider-signed reasoning while retaining portable assistant history after a model switch. */
function serializePortableAssistantBlocks(
  blocks: readonly ContentBlock[],
  replay: readonly Record<string, unknown>[],
): Record<string, unknown>[] {
  const visibleReplay = visibleReplayBlocks(replay)
  return blocks.flatMap((block, index): Record<string, unknown>[] => {
    const replayBlock = visibleReplay[index]
    if (replayBlock === undefined) throw invalidReplay('portable history does not match its visible projection')
    switch (block.type) {
      case 'text':
        return [{ type: 'text', text: block.text, ...ephemeralMarker(replayBlock) }]
      case 'reasoning':
        return []
      case 'tool-call': {
        assertJsonArguments(block.arguments)
        const input = JSON.parse(block.arguments) as unknown
        return [{
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input,
          ...ephemeralMarker(replayBlock),
        }]
      }
      case 'tool-result':
      case 'image':
        throw new LlmError(`Acosmi assistant history cannot contain ${block.type} blocks.`, 'UNSUPPORTED_CONTENT')
      default:
        throw new LlmError('Acosmi cannot serialize an extension content block.', 'UNSUPPORTED_CONTENT')
    }
  })
}

function flattenResult(blocks: readonly ContentBlock[]): string {
  const text: string[] = []
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        text.push(block.text)
        break
      case 'image':
        throw new LlmError('Acosmi tool results do not support image blocks.', 'UNSUPPORTED_CONTENT')
      case 'reasoning':
      case 'tool-call':
      case 'tool-result':
        throw new LlmError(
          `Acosmi tool results cannot contain ${block.type} blocks.`,
          'UNSUPPORTED_CONTENT',
        )
      default:
        throw new LlmError('Acosmi cannot serialize an extension tool-result block.', 'UNSUPPORTED_CONTENT')
    }
  }
  return text.join('') || '(no output)'
}

function resolveEffort(options: GenerateOptions, model: ManagedModel): ChatRequest['thinking'] {
  const caps = model.capabilities
  if (options.purpose === 'session-title') {
    return caps.supports_thinking || caps.supports_adaptive_thinking
      ? { type: 'disabled', level: 'off' }
      : undefined
  }
  const selected = options.reasoningEffort
  if (selected === undefined) return undefined
  const effort = String(selected)
  if (effort === 'off' && (caps.supports_thinking || caps.supports_adaptive_thinking)) {
    return { type: 'disabled', level: 'off' }
  }
  if (effort === 'high' && caps.supports_effort) return { type: 'adaptive', level: 'high' }
  if (effort === 'max' && caps.supports_effort && caps.supports_max_effort) {
    return { type: 'adaptive', level: 'max' }
  }
  throw new LlmError(
    `Acosmi model "${model.id}" does not support reasoning effort "${effort}".`,
    'UNSUPPORTED_REASONING_EFFORT',
  )
}

function readReplayState(value: unknown): AcosmiReplayState | undefined {
  if (value === undefined) return undefined
  if (!isExactRecord(value, ['format', 'version', 'model', 'content'])
    || value.format !== 'acosmi-anthropic-v1'
    || value.version !== 1
    || typeof value.model !== 'string'
    || value.model.length === 0
    || !Array.isArray(value.content)) throw invalidReplay('invalid state header')
  return {
    format: 'acosmi-anthropic-v1',
    version: 1,
    model: value.model,
    content: value.content.map((block, index) => readReplayBlock(block, index)),
  }
}

function readReplayBlock(value: unknown, index: number): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidReplay(`block ${String(index)} is not an object`)
  }
  const block = value as Record<string, unknown>
  switch (block.type) {
    case 'text':
      if (!hasOnlyKeys(block, ['type', 'text', 'citations', 'acosmi_ephemeral'])
        || typeof block.text !== 'string'
        || !validEphemeralMarker(block)
        || (block.citations !== undefined && !isJsonArray(block.citations))) {
        throw invalidReplay(`block ${String(index)} is not valid text`)
      }
      return {
        type: 'text',
        text: block.text,
        ...(block.citations === undefined ? {} : { citations: structuredClone(block.citations) }),
        ...ephemeralMarker(block),
      }
    case 'thinking': {
      if (!hasOnlyKeys(block, ['type', 'thinking', 'signature', 'acosmi_ephemeral'])
        || typeof block.thinking !== 'string'
        || (block.signature !== undefined && typeof block.signature !== 'string')
        || !validEphemeralMarker(block)) {
        throw invalidReplay(`block ${String(index)} is not valid thinking`)
      }
      return {
        type: 'thinking',
        thinking: block.thinking,
        ...(block.signature === undefined ? {} : { signature: block.signature }),
        ...ephemeralMarker(block),
      }
    }
    case 'redacted_thinking':
      if (!hasOnlyKeys(block, ['type', 'data', 'acosmi_ephemeral'])
        || typeof block.data !== 'string' || !validEphemeralMarker(block)) {
        throw invalidReplay(`block ${String(index)} is not valid redacted thinking`)
      }
      return { type: 'redacted_thinking', data: block.data, ...ephemeralMarker(block) }
    case 'tool_use':
      if (!hasOnlyKeys(block, ['type', 'id', 'name', 'input', 'acosmi_ephemeral'])
        || typeof block.id !== 'string'
        || block.id.length === 0
        || typeof block.name !== 'string'
        || block.name.length === 0
        || !isJsonValue(block.input)
        || !validEphemeralMarker(block)) {
        throw invalidReplay(`block ${String(index)} is not valid tool use`)
      }
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: structuredClone(block.input),
        ...ephemeralMarker(block),
      }
    case 'server_tool_use':
      if (!hasOnlyKeys(block, ['type', 'id', 'name', 'input', 'server_name', 'caller', 'acosmi_ephemeral'])
        || typeof block.id !== 'string'
        || block.id.length === 0
        || typeof block.name !== 'string'
        || block.name.length === 0
        || !isJsonValue(block.input)
        || (block.server_name !== undefined && typeof block.server_name !== 'string')
        || (block.caller !== undefined && !isJsonValue(block.caller))
        || !validEphemeralMarker(block)) {
        throw invalidReplay(`block ${String(index)} is not valid server tool use`)
      }
      return {
        type: 'server_tool_use',
        id: block.id,
        name: block.name,
        input: structuredClone(block.input),
        ...(block.server_name === undefined ? {} : { server_name: block.server_name }),
        ...(block.caller === undefined ? {} : { caller: structuredClone(block.caller) }),
        ...ephemeralMarker(block),
      }
    case 'web_search_tool_result':
      if (!hasOnlyKeys(block, ['type', 'tool_use_id', 'content', 'acosmi_ephemeral'])
        || typeof block.tool_use_id !== 'string'
        || block.tool_use_id.length === 0
        || !isJsonValue(block.content)
        || !validEphemeralMarker(block)) {
        throw invalidReplay(`block ${String(index)} is not a valid web-search tool result`)
      }
      return {
        type: 'web_search_tool_result',
        tool_use_id: block.tool_use_id,
        content: structuredClone(block.content),
        ...ephemeralMarker(block),
      }
    default:
      throw invalidReplay(`block ${String(index)} has an unknown type`)
  }
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && hasOnlyKeys(value as Record<string, unknown>, keys)
    && keys.every(key => Object.hasOwn(value, key))
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
}

function validEphemeralMarker(value: Record<string, unknown>): boolean {
  return value.acosmi_ephemeral === undefined || value.acosmi_ephemeral === true
}

function ephemeralMarker(value: Record<string, unknown>): Record<string, true> | Record<string, never> {
  return value.acosmi_ephemeral === true ? { acosmi_ephemeral: true } : {}
}

function isJsonArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && isJsonValue(value)
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (depth >= 100) return false
  if (Array.isArray(value)) return value.every(entry => isJsonValue(entry, depth + 1))
  return typeof value === 'object'
    && Reflect.getPrototypeOf(value) === Object.prototype
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && isJsonValue(Reflect.get(value, key), depth + 1))
}

function invalidReplay(detail: string): LlmError {
  return new LlmError(`Invalid Acosmi replay state: ${detail}.`, 'INVALID_REPLAY_STATE')
}

function replayMatches(blocks: readonly ContentBlock[], replay: readonly Record<string, unknown>[]): boolean {
  const visibleReplay = visibleReplayBlocks(replay)
  if (visibleReplay.length !== blocks.length) return false
  return blocks.every((block, index) => replayBlockMatches(block, visibleReplay[index]))
}

function visibleReplayBlocks(replay: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return replay.filter(block => block.type !== 'redacted_thinking'
    && block.type !== 'server_tool_use' && block.type !== 'web_search_tool_result')
}

function canReplayExactAnthropic(replay: readonly Record<string, unknown>[]): boolean {
  return replay.every(block => block.type !== 'thinking'
    || (typeof block.signature === 'string' && block.signature.length > 0))
}

function hasAnthropicSignedState(replay: readonly Record<string, unknown>[]): boolean {
  return replay.some(block => block.type === 'redacted_thinking'
    || (block.type === 'thinking' && typeof block.signature === 'string' && block.signature.length > 0))
}

function replayBlockMatches(block: ContentBlock, replay: Record<string, unknown> | undefined): boolean {
  if (replay === undefined) return false
  if (block.type === 'text') return replay.type === 'text' && replay.text === block.text
  if (block.type === 'reasoning') return replay.type === 'thinking' && replay.thinking === block.text
  if (block.type !== 'tool-call'
    || replay.type !== 'tool_use'
    || replay.id !== block.id
    || replay.name !== block.name) return false

  let input: unknown
  try {
    input = JSON.parse(block.arguments) as unknown
  } catch {
    return false
  }
  return jsonValuesEqual(input, replay.input ?? {})
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right
  if (typeof left !== typeof right) return false
  if (typeof left === 'string' || typeof left === 'boolean') return left === right
  if (typeof left === 'number') {
    return typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right) && left === right
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonValuesEqual(value, right[index]))
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && jsonValuesEqual(leftRecord[key], rightRecord[key]))
}

function opaqueSessionId(value: string): string {
  return `dsh_${createHash('sha256').update(value).digest('hex')}`
}
