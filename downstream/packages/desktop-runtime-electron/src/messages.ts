/** Electron IPC channel names and validation helpers. */

import { isAbsolute } from 'node:path'
import {
  DESKTOP_PROTOCOL_VERSION,
  MAX_DESKTOP_BODY_BYTES,
  isDesktopRendererUrl,
  type DesktopStreamItem,
  type DesktopUnaryRequest,
  type DesktopUnaryResponse,
} from '@acosmi/dsh-desktop-carrier-electron/protocol'

const MAX_DESKTOP_URL_BYTES = 4096
const MAX_DESKTOP_REQUEST_HEADERS = 2
const MAX_DESKTOP_RESPONSE_HEADERS = 3
const MAX_DESKTOP_HEADER_VALUE_BYTES = 256
const MAX_DESKTOP_STREAM_ERROR_BYTES = 256
const REQUEST_HEADER_NAMES = new Set(['content-type', 'accept'])
const RESPONSE_HEADER_NAMES = new Set(['content-type', 'content-encoding', 'cache-control'])

/** Renderer/main channels; preload exposes operations, never these names. */
export const IPC = Object.freeze({
  request: 'dsh:request',
  cancel: 'dsh:cancel',
  streamOpen: 'dsh:stream-open',
  streamNext: 'dsh:stream-next',
  streamClose: 'dsh:stream-close',
  productInfo: 'dsh:product-info',
  checkForUpdates: 'dsh:check-for-updates',
})

/** Pull-stream URLs admitted by the desktop carrier. */
export const STREAM_PATHS = new Set(['/api/events.mux', '/api/events.host'])

/** Validate and detach an untrusted renderer unary request. */
export function parseRendererUnary(value: unknown): DesktopUnaryRequest {
  if (!isExactRecord(value, ['version', 'requestId', 'url', 'method', 'headers', 'body'])
    || value.version !== DESKTOP_PROTOCOL_VERSION
    || typeof value.requestId !== 'string'
    || !validId(value.requestId)
    || value.method !== 'POST'
    || typeof value.url !== 'string'
    || !Array.isArray(value.headers)
    || !(value.body instanceof ArrayBuffer)) {
    throw new Error('desktop IPC rejected malformed unary request')
  }
  assertDesktopUrl(value.url, false)
  if (value.body.byteLength > MAX_DESKTOP_BODY_BYTES) throw new Error('desktop IPC request body is too large')
  const headers = parseHeaderRows(
    value.headers,
    REQUEST_HEADER_NAMES,
    MAX_DESKTOP_REQUEST_HEADERS,
    'desktop IPC request',
  )
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    requestId: value.requestId,
    url: value.url,
    method: 'POST',
    headers,
    body: value.body.slice(0),
  }
}

/** Validate one stream URL from the sandboxed renderer. */
export function parseRendererStreamUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('desktop IPC rejected malformed stream URL')
  const url = assertDesktopUrl(value, true)
  if (!STREAM_PATHS.has(url.pathname)) throw new Error('desktop IPC rejected unknown stream endpoint')
  return url.href
}

/** Validate a renderer correlation id. */
export function parseRendererId(value: unknown): string {
  if (typeof value !== 'string' || !validId(value)) throw new Error('desktop IPC rejected malformed request id')
  return value
}

/**
 * Validate and detach a utility-process unary response before renderer delivery.
 * @param value - untrusted process-message value.
 * @returns validated response with detached header rows and body bytes.
 */
export function parseUtilityUnaryResponse(value: unknown): DesktopUnaryResponse {
  if (!isExactRecord(value, ['version', 'status', 'headers', 'body'])
    || value.version !== DESKTOP_PROTOCOL_VERSION
    || !validResponseStatus(value.status)
    || !Array.isArray(value.headers)
    || !(value.body instanceof ArrayBuffer)
    || value.body.byteLength > MAX_DESKTOP_BODY_BYTES) {
    throw new Error('desktop utility returned a malformed unary response')
  }
  return {
    version: DESKTOP_PROTOCOL_VERSION,
    status: value.status,
    headers: parseHeaderRows(
      value.headers,
      RESPONSE_HEADER_NAMES,
      MAX_DESKTOP_RESPONSE_HEADERS,
      'desktop utility response',
    ),
    body: value.body.slice(0),
  }
}

/**
 * Validate a utility-process stream identifier before retaining it in main.
 * @param value - untrusted process-message value.
 * @returns validated stream correlation identifier.
 */
export function parseUtilityStreamId(value: unknown): string {
  if (typeof value !== 'string' || !validId(value)) {
    throw new Error('desktop utility returned a malformed stream id')
  }
  return value
}

/**
 * Validate and detach one utility-process stream item before renderer delivery.
 * @param value - untrusted process-message value.
 * @returns validated stream metadata, bytes, terminal marker, or public error.
 */
export function parseUtilityStreamItem(value: unknown): DesktopStreamItem {
  if (!isRecord(value) || typeof value.type !== 'string') {
    throw new Error('desktop utility returned a malformed stream item')
  }
  switch (value.type) {
    case 'opened':
      if (!isExactRecord(value, ['type', 'status', 'headers'])
        || !validResponseStatus(value.status)
        || !Array.isArray(value.headers)) {
        throw new Error('desktop utility returned malformed stream metadata')
      }
      return {
        type: 'opened',
        status: value.status,
        headers: parseHeaderRows(
          value.headers,
          RESPONSE_HEADER_NAMES,
          MAX_DESKTOP_RESPONSE_HEADERS,
          'desktop utility stream',
        ),
      }
    case 'chunk':
      if (!isExactRecord(value, ['type', 'data'])
        || !(value.data instanceof ArrayBuffer)
        || value.data.byteLength > MAX_DESKTOP_BODY_BYTES) {
        throw new Error('desktop utility returned a malformed stream chunk')
      }
      return { type: 'chunk', data: value.data.slice(0) }
    case 'end':
      if (!isExactRecord(value, ['type'])) throw new Error('desktop utility returned a malformed stream end')
      return { type: 'end' }
    case 'error':
      if (!isExactRecord(value, ['type', 'message'])
        || typeof value.message !== 'string'
        || value.message.length === 0
        || Buffer.byteLength(value.message, 'utf8') > MAX_DESKTOP_STREAM_ERROR_BYTES) {
        throw new Error('desktop utility returned a malformed stream error')
      }
      return { type: 'error', message: value.message }
    default:
      throw new Error('desktop utility returned an unknown stream item')
  }
}

/**
 * Require the utility process to return no value for a lifecycle operation.
 * @param value - untrusted process-message value.
 */
export function assertUtilityVoid(value: unknown): asserts value is undefined {
  if (value !== undefined) throw new Error('desktop utility returned an invalid empty response')
}

/**
 * Convert a throwing validation step into rejection for a one-way IPC message.
 * @param validate - sender and payload validation performed before any effect.
 * @returns the validated value, or `undefined` when the message must be ignored.
 */
export function acceptRendererOneWayMessage<T>(validate: () => T): T | undefined {
  try {
    return validate()
  } catch (_rejectedRendererMessage) {
    // One-way IPC has no response channel through which to report validation failure.
    return undefined
  }
}

/** Remove details that could contain provider, path, account, or secret data. */
export function publicFailure(error: unknown): string {
  if (error instanceof Error && /cancel|abort/iu.test(error.name + error.message)) return 'Request was cancelled.'
  return 'The desktop Host could not complete this operation.'
}

/** Whether a utility-process message is an ordinary record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Post across the main/utility transport without leaking a closed-port exception.
 * @param port - either side of the Electron process message link.
 * @param message - detached process message.
 * @returns whether the transport accepted the message.
 */
export function tryPostDesktopMessage(
  port: { postMessage(message: unknown): void },
  message: Record<string, unknown>,
): boolean {
  try {
    port.postMessage(message)
    return true
  } catch (_closedTransport) {
    // A closed process transport has no remaining recipient or recovery reply path.
    return false
  }
}

/** Parse a secret value returned across the trusted main/utility process link. */
export function parseHostOptionalSecret(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('desktop main returned an invalid credential value')
  }
  return value
}

/** Parse a boolean returned across the trusted main/utility process link. */
export function parseHostBoolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('desktop main returned an invalid boolean')
  return value
}

/** Require an empty success result across the trusted main/utility process link. */
export function assertHostVoid(value: unknown): asserts value is undefined {
  if (value !== undefined) throw new Error('desktop main returned an invalid empty response')
}

/** Parse a native directory result returned across the trusted main/utility process link. */
export function parseHostDirectorySelection(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || !isAbsolute(value)) {
    throw new Error('desktop main returned an invalid directory')
  }
  return value
}

/**
 * Validate the one external navigation DSH-GUI currently permits.
 * @param value - untrusted URL sent by the utility process.
 * @returns the canonical Acosmi authorization URL.
 */
export function parseAcosmiAuthorizationUrl(value: unknown): string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096) {
    throw new Error('desktop browser gate rejected malformed URL')
  }
  const url = new URL(value)
  if (url.origin !== 'https://acosmi.com' || url.pathname !== '/oauth/desktop/authorize'
    || url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new Error('desktop browser gate rejected URL authority or path')
  }
  const allowed = new Set([
    'client_id',
    'redirect_uri',
    'response_type',
    'code_challenge',
    'code_challenge_method',
    'state',
    'scope',
  ])
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new Error('desktop browser gate rejected authorization parameters')
    }
  }
  const clientId = requiredParameter(url, 'client_id')
  const state = requiredParameter(url, 'state')
  const challenge = requiredParameter(url, 'code_challenge')
  if (clientId.length > 512 || !/^[A-Za-z0-9_-]{43}$/u.test(state)
    || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
    || requiredParameter(url, 'response_type') !== 'code'
    || requiredParameter(url, 'code_challenge_method') !== 'S256'
    || requiredParameter(url, 'scope') !== 'ai') {
    throw new Error('desktop browser gate rejected authorization values')
  }
  const redirect = new URL(requiredParameter(url, 'redirect_uri'))
  const port = Number(redirect.port)
  if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1'
    || redirect.pathname !== '/callback' || redirect.username !== '' || redirect.password !== ''
    || redirect.search !== '' || redirect.hash !== '' || !Number.isInteger(port)
    || port < 1024 || port > 65_535) {
    throw new Error('desktop browser gate rejected OAuth callback')
  }
  return url.toString()
}

function requiredParameter(url: URL, name: string): string {
  const values = url.searchParams.getAll(name)
  if (values.length !== 1 || values[0] === undefined || values[0] === '') {
    throw new Error('desktop browser gate rejected a missing authorization parameter')
  }
  return values[0]
}

function assertDesktopUrl(value: string, stream: boolean): URL {
  if (Buffer.byteLength(value, 'utf8') > MAX_DESKTOP_URL_BYTES) {
    throw new Error('desktop IPC rejected oversized URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('desktop IPC rejected invalid URL')
  }
  if (!isDesktopRendererUrl(url) || url.search !== '' || url.hash !== '') {
    throw new Error('desktop IPC rejected URL authority or components')
  }
  if (stream && !url.pathname.startsWith('/api/')) throw new Error('desktop IPC rejected non-API stream')
  if (!stream && !validApplicationPath(url.pathname)) throw new Error('desktop IPC rejected request path')
  return url
}

function validApplicationPath(pathname: string): boolean {
  if (!pathname.startsWith('/')) return false
  const parts = pathname.slice(1).split('/')
  return parts.length >= 2
    && /^[A-Za-z0-9._~-]+$/u.test(parts[0] ?? '')
    && parts.slice(1).every(part => /^[A-Za-z0-9_$.-]+$/u.test(part))
}

function validId(value: string): boolean {
  return /^[A-Fa-f0-9-]{16,64}$/u.test(value)
}

function parseHeaderRows(
  value: unknown[],
  allowedNames: ReadonlySet<string>,
  maximumCount: number,
  owner: string,
): Array<readonly [string, string]> {
  if (value.length > maximumCount) throw new Error(`${owner} contains too many headers`)
  const result: Array<readonly [string, string]> = []
  const seen = new Set<string>()
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || typeof row[1] !== 'string') {
      throw new Error(`${owner} contains malformed headers`)
    }
    const name = row[0].toLowerCase()
    if (!allowedNames.has(name)) throw new Error(`${owner} rejected header ${name}`)
    if (seen.has(name)) throw new Error(`${owner} contains a duplicate header`)
    if (Buffer.byteLength(row[1], 'utf8') > MAX_DESKTOP_HEADER_VALUE_BYTES) {
      throw new Error(`${owner} contains an oversized header value`)
    }
    seen.add(name)
    result.push([name, row[1]])
  }
  return result
}

function validResponseStatus(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 200 && value <= 599
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key))
    && keys.every(key => Object.hasOwn(value, key))
}
