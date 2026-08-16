/** Anthropic-compatible Acosmi SSE translation into Harness stream chunks. */

import { classifySourcesEvent, type StreamEvent } from '@acosmi/sdk-ts'
import {
  CallId,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  EMPTY_RESPONSE_CODE,
  isContextWindowExceededError,
  isQuotaExceededError,
  LlmError,
  QUOTA_EXCEEDED_CODE,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import {
  acosmiPublicFailureMessage,
  mapAcosmiToolNameCollisionError,
  mapAcosmiWindowLimitError,
} from './errors.ts'
import type { AcosmiReplayState } from './serialize.ts'

interface OpenBlock {
  readonly type:
    | 'text'
    | 'thinking'
    | 'tool_use'
    | 'redacted_thinking'
    | 'server_tool_use'
    | 'web_search_tool_result'
  readonly raw: Record<string, unknown>
  readonly ephemeral: boolean
  text: string
  id?: string
  name?: string
  arguments: string
  signature: string
  citations?: unknown[]
}

/** Translate one complete provider response and require an explicit message stop. */
export async function* translateAcosmiStream(
  events: AsyncIterable<StreamEvent>,
  model: string,
): AsyncIterable<StreamChunk> {
  const blocks = new Map<number, OpenBlock>()
  const replay = new Map<number, Record<string, unknown>>()
  let usage: TokenUsage | undefined
  let finish: FinishReason | undefined
  let visibleBlocks = 0
  let sawStop = false

  for await (const event of events) {
    if (finish !== undefined
      && event.event !== 'message_stop'
      && event.event !== 'settled'
      && event.event !== 'pending_settle') {
      throw malformed('stream emitted an event after its finish reason')
    }
    const sources = classifySourcesEvent(event)
    if (sources.kind !== 'not_sources') {
      if (sources.kind === 'malformed_sources') {
        throw malformed(`sources event is invalid (${sources.code})`)
      }
      continue
    }
    if (event.event === 'ping' || event.event === '') continue
    const payload = parsePayload(event)
    switch (event.event) {
      case 'message_start': {
        const initial = objectField(objectField(payload, 'message'), 'usage')
        usage = mergeUsage(usage, initial)
        break
      }
      case 'content_block_start': {
        const index = integerField(payload, 'index')
        if (blocks.has(index) || replay.has(index)) throw malformed(`duplicate content block ${String(index)}`)
        const raw = objectField(payload, 'content_block')
        const block = openBlock(raw, event, index)
        blocks.set(index, block)
        if (block.type === 'text') yield { type: 'block-start', index, blockType: 'text' }
        else if (block.type === 'thinking') yield { type: 'block-start', index, blockType: 'reasoning' }
        else if (block.type === 'tool_use') yield { type: 'block-start', index, blockType: 'tool-call' }
        break
      }
      case 'content_block_delta': {
        const index = integerField(payload, 'index')
        const block = blocks.get(index)
        if (block === undefined) throw malformed(`delta for unopened content block ${String(index)}`)
        assertBlockEventMetadata(event, index, block.type, block.ephemeral)
        const delta = objectField(payload, 'delta')
        const type = stringField(delta, 'type')
        if (type === 'text_delta' && block.type === 'text') {
          const text = stringField(delta, 'text')
          block.text += text
          yield { type: 'text-delta', index, text }
        } else if (type === 'thinking_delta' && block.type === 'thinking') {
          const text = stringField(delta, 'thinking')
          block.text += text
          yield { type: 'reasoning-delta', index, text }
        } else if (type === 'signature_delta' && block.type === 'thinking') {
          block.signature += stringField(delta, 'signature')
        } else if (type === 'input_json_delta'
          && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
          const fragment = stringField(delta, 'partial_json')
          block.arguments += fragment
          if (block.type === 'tool_use') {
            yield {
              type: 'tool-call-delta',
              index,
              id: CallId(block.id ?? ''),
              ...(block.name === undefined ? {} : { name: block.name }),
              argumentsDelta: fragment,
            }
          }
        } else if (type === 'citations_delta' && block.type === 'text') {
          const citation = jsonObjectField(delta, 'citation')
          block.citations ??= []
          block.citations.push(citation)
        } else {
          throw malformed(`delta ${JSON.stringify(type)} does not match block ${JSON.stringify(block.type)}`)
        }
        break
      }
      case 'content_block_stop': {
        const index = integerField(payload, 'index')
        const block = blocks.get(index)
        if (block === undefined) throw malformed(`stop for unopened content block ${String(index)}`)
        assertBlockEventMetadata(event, index, block.type, block.ephemeral)
        blocks.delete(index)
        const ended = closeBlock(block)
        replay.set(index, ended.raw)
        if (ended.content !== undefined) {
          visibleBlocks++
          yield { type: 'block-end', index, block: ended.content }
        }
        break
      }
      case 'message_delta': {
        if (finish !== undefined) throw malformed('stream contains duplicate finish reasons')
        const delta = objectField(payload, 'delta')
        const stopReason = optionalString(delta, 'stop_reason')
        if (stopReason === undefined || stopReason.length === 0) throw malformed('stop reason is missing')
        finish = finishReason(stopReason)
        usage = mergeUsage(usage, objectField(payload, 'usage'))
        break
      }
      case 'message_stop': {
        if (blocks.size !== 0) throw malformed('message stopped with open content blocks')
        if (finish === undefined) throw malformed('message stopped without a finish reason')
        if (usage !== undefined) yield { type: 'usage', usage }
        const content = [...replay.entries()].sort(([left], [right]) => left - right).map(([, block]) => block)
        const replayState: AcosmiReplayState = { format: 'acosmi-anthropic-v1', version: 1, model, content }
        const reason: FinishReason = finish.kind === 'stop' && visibleBlocks === 0
          ? {
              kind: 'error',
              failure: {
                message: 'Acosmi managed-model service returned an empty response.',
                code: EMPTY_RESPONSE_CODE,
              },
            }
          : finish
        yield {
          type: 'finish',
          reason,
          ...(reason.kind === 'error' ? {} : { replayState }),
        }
        sawStop = true
        break
      }
      case 'failed':
      case 'error':
        throw providerEventError(payload)
      case 'started':
      case 'settled':
      case 'pending_settle':
        break
      default:
        throw malformed('stream contains an unsupported event type')
    }
    if (sawStop) return
  }
  throw new LlmError('Acosmi event stream ended without message_stop.', 'STREAM_CLOSED')
}

function openBlock(raw: Record<string, unknown>, event: StreamEvent, index: number): OpenBlock {
  const type = stringField(raw, 'type')
  if (type !== 'text' && type !== 'thinking' && type !== 'tool_use' && type !== 'redacted_thinking'
    && type !== 'server_tool_use' && type !== 'web_search_tool_result') {
    throw new LlmError(`Acosmi returned unsupported content block ${JSON.stringify(type)}.`, 'UNSUPPORTED_CONTENT')
  }
  const ephemeral = blockEphemeral(raw, event, index, type)
  return {
    type,
    raw: structuredClone(raw),
    ephemeral,
    text: type === 'text' ? optionalString(raw, 'text') ?? '' : optionalString(raw, 'thinking') ?? '',
    ...(type === 'tool_use' || type === 'server_tool_use'
      ? { id: nonEmptyStringField(raw, 'id'), name: nonEmptyStringField(raw, 'name') }
      : {}),
    arguments: (type === 'tool_use' || type === 'server_tool_use')
      && raw.input !== undefined && !isEmptyObject(raw.input)
      ? JSON.stringify(raw.input)
      : '',
    signature: optionalString(raw, 'signature') ?? '',
    ...(type === 'text' && raw.citations !== undefined
      ? { citations: jsonArrayField(raw, 'citations') }
      : {}),
  }
}

function closeBlock(block: OpenBlock): { raw: Record<string, unknown>; content?: ContentBlock } {
  switch (block.type) {
    case 'text': {
      const raw = {
        type: 'text',
        text: block.text,
        ...(block.citations === undefined ? {} : { citations: block.citations }),
        ...ephemeralMarker(block.ephemeral),
      }
      return { raw, content: { type: 'text', text: block.text } }
    }
    case 'thinking': {
      const raw = {
        type: 'thinking',
        thinking: block.text,
        ...(block.signature === '' ? {} : { signature: block.signature }),
        ...ephemeralMarker(block.ephemeral),
      }
      return { raw, content: { type: 'reasoning', text: block.text } }
    }
    case 'tool_use': {
      const args = block.arguments === '' ? '{}' : block.arguments
      try {
        JSON.parse(args)
      } catch (cause) {
        throw new LlmError('Acosmi returned malformed tool-call JSON.', 'MALFORMED_RESPONSE', { cause })
      }
      const raw = {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: JSON.parse(args) as unknown,
        ...ephemeralMarker(block.ephemeral),
      }
      return { raw, content: { type: 'tool-call', id: CallId(block.id ?? ''), name: block.name ?? '', arguments: args } }
    }
    case 'redacted_thinking':
      return {
        raw: {
          type: 'redacted_thinking',
          data: stringField(block.raw, 'data'),
          ...ephemeralMarker(block.ephemeral),
        },
      }
    case 'server_tool_use': {
      assertOnlyKeys(block.raw, ['type', 'id', 'name', 'input', 'server_name', 'caller', 'acosmi_ephemeral'])
      const args = block.arguments === '' ? '{}' : block.arguments
      let input: unknown
      try {
        input = JSON.parse(args) as unknown
      } catch (cause) {
        throw new LlmError('Acosmi returned malformed server-tool JSON.', 'MALFORMED_RESPONSE', { cause })
      }
      if (!isJsonValue(input)) throw malformed('server-tool input is not bounded JSON')
      return {
        raw: {
          type: 'server_tool_use',
          id: block.id,
          name: block.name,
          input,
          ...optionalStringRecord(block.raw, 'server_name'),
          ...optionalJsonRecord(block.raw, 'caller'),
          ...ephemeralMarker(block.ephemeral),
        },
      }
    }
    case 'web_search_tool_result': {
      assertOnlyKeys(block.raw, ['type', 'tool_use_id', 'content', 'acosmi_ephemeral'])
      const content = jsonValueField(block.raw, 'content')
      return {
        raw: {
          type: 'web_search_tool_result',
          tool_use_id: nonEmptyStringField(block.raw, 'tool_use_id'),
          content,
          ...ephemeralMarker(block.ephemeral),
        },
      }
    }
  }
}

function mergeUsage(current: TokenUsage | undefined, raw: Record<string, unknown>): TokenUsage | undefined {
  if (Reflect.ownKeys(raw).length === 0) return current
  const input = optionalNumber(raw, 'input_tokens') ?? current?.inputTokens ?? 0
  const output = optionalNumber(raw, 'output_tokens') ?? current?.outputTokens ?? 0
  const cacheRead = optionalNumber(raw, 'cache_read_input_tokens') ?? current?.cacheReadTokens
  const cacheWrite = optionalNumber(raw, 'cache_creation_input_tokens') ?? current?.cacheWriteTokens
  return {
    inputTokens: input,
    outputTokens: output,
    ...(cacheRead === undefined ? {} : { cacheReadTokens: cacheRead }),
    ...(cacheWrite === undefined ? {} : { cacheWriteTokens: cacheWrite }),
  }
}

function finishReason(value: string): FinishReason {
  switch (value) {
    case 'end_turn':
    case 'stop_sequence':
    case 'stop':
      return { kind: 'stop' }
    case 'tool_use':
      return { kind: 'tool-calls' }
    case 'max_tokens':
    case 'length':
      return { kind: 'max-tokens' }
    default:
      return {
        kind: 'error',
        failure: {
          message: 'Acosmi model stopped for an unsupported provider reason.',
          code: 'PROVIDER',
        },
      }
  }
}

function providerEventError(payload: Record<string, unknown>): LlmError {
  const error = typeof payload.error === 'object' && payload.error !== null
    ? payload.error as Record<string, unknown>
    : payload
  const windowLimit = mapAcosmiWindowLimitError(error)
  if (windowLimit !== undefined) return windowLimit
  const toolNameCollision = mapAcosmiToolNameCollisionError(error)
  if (toolNameCollision !== undefined) return toolNameCollision
  const type = optionalString(error, 'type') ?? 'provider_error'
  const message = optionalString(error, 'message') ?? 'Acosmi provider stream failed.'
  const detail = `${type} ${message}`
  const code = isContextWindowExceededError(detail)
    ? CONTEXT_WINDOW_EXCEEDED_CODE
    : isQuotaExceededError(detail)
      ? QUOTA_EXCEEDED_CODE
      : type.includes('rate_limit')
        ? 'RATE_LIMIT'
        : type.includes('overload') ? 'SERVER' : 'PROVIDER'
  return new LlmError(acosmiPublicFailureMessage(code), code)
}

function isEmptyObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Reflect.ownKeys(value).length === 0
}

function parsePayload(event: StreamEvent): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(event.data)
  } catch (cause) {
    throw new LlmError(`Acosmi returned malformed ${event.event || 'unnamed'} event JSON.`, 'MALFORMED_RESPONSE', { cause })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw malformed('event payload is not an object')
  return value as Record<string, unknown>
}

function objectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = value[key]
  if (field === undefined) return {}
  if (typeof field !== 'object' || field === null || Array.isArray(field)) throw malformed(`${key} is not an object`)
  return field as Record<string, unknown>
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key]
  if (typeof field !== 'string') throw malformed(`${key} is not a string`)
  return field
}

function nonEmptyStringField(value: Record<string, unknown>, key: string): string {
  const field = stringField(value, key)
  if (field.length === 0) throw malformed(`${key} is empty`)
  return field
}

function optionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  if (field === undefined || field === null) return undefined
  if (typeof field !== 'string') throw malformed(`${key} is not a string`)
  return field
}

function optionalStringRecord(value: Record<string, unknown>, key: string): Record<string, string> {
  return value[key] === undefined ? {} : { [key]: stringField(value, key) }
}

function optionalJsonRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  return value[key] === undefined ? {} : { [key]: jsonValueField(value, key) }
}

function jsonValueField(value: Record<string, unknown>, key: string): unknown {
  const field = value[key]
  if (!isJsonValue(field)) throw malformed(`${key} is not bounded JSON`)
  return structuredClone(field)
}

function jsonObjectField(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const field = jsonValueField(value, key)
  if (typeof field !== 'object' || field === null || Array.isArray(field)) {
    throw malformed(`${key} is not an object`)
  }
  return field as Record<string, unknown>
}

function jsonArrayField(value: Record<string, unknown>, key: string): unknown[] {
  const field = jsonValueField(value, key)
  if (!Array.isArray(field)) throw malformed(`${key} is not an array`)
  return field
}

function integerField(value: Record<string, unknown>, key: string): number {
  const field = value[key]
  if (!Number.isSafeInteger(field) || (field as number) < 0) throw malformed(`${key} is not a non-negative integer`)
  return field as number
}

function optionalNumber(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key]
  if (field === undefined) return undefined
  if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw malformed(`${key} is not a token count`)
  return field
}

function blockEphemeral(
  raw: Record<string, unknown>,
  event: StreamEvent,
  index: number,
  type: string,
): boolean {
  const marker = raw.acosmi_ephemeral
  if (marker !== undefined && typeof marker !== 'boolean') {
    throw malformed(`content block ${String(index)} has an invalid ephemeral marker`)
  }
  if (event.ephemeral !== undefined && typeof event.ephemeral !== 'boolean') {
    throw malformed(`content block ${String(index)} has invalid SDK ephemeral metadata`)
  }
  if (marker !== undefined && event.ephemeral !== undefined && marker !== event.ephemeral) {
    throw malformed(`content block ${String(index)} disagrees with its SDK ephemeral metadata`)
  }
  const ephemeral = marker === true || event.ephemeral === true
  assertBlockEventMetadata(event, index, type, ephemeral)
  return ephemeral
}

function assertBlockEventMetadata(
  event: StreamEvent,
  index: number,
  type: string,
  ephemeral: boolean,
): void {
  if (event.blockIndex !== undefined && event.blockIndex !== index) {
    throw malformed(`content block ${String(index)} disagrees with its SDK index metadata`)
  }
  if (event.blockType !== undefined && event.blockType !== type) {
    throw malformed(`content block ${String(index)} disagrees with its SDK type metadata`)
  }
  if (event.ephemeral !== undefined && event.ephemeral !== ephemeral) {
    throw malformed(`content block ${String(index)} disagrees with its SDK ephemeral metadata`)
  }
}

function ephemeralMarker(ephemeral: boolean): Record<string, true> | Record<string, never> {
  return ephemeral ? { acosmi_ephemeral: true } : {}
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key))) {
    throw malformed('provider-only content block has unknown fields')
  }
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

function malformed(message: string): LlmError {
  return new LlmError(`Malformed Acosmi stream: ${message}.`, 'MALFORMED_RESPONSE')
}
