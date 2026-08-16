/** Acosmi-specific normalization for rolling-window request rejections. */

import {
  HTTPError,
  isWindowLimitError,
  isWindowLimitStreamError,
  StreamError,
} from '@acosmi/sdk-ts'
import { LlmError } from '@deepseek-ai/dsh-llm'

/** Stable non-retryable Harness code for an Acosmi rolling-window rejection. */
export const ACOSMI_WINDOW_LIMIT_CODE = 'WINDOW_LIMIT'

/** Stable non-retryable Harness code for duplicate final provider tool names. */
export const ACOSMI_TOOL_NAME_COLLISION_CODE = 'TOOL_NAME_COLLISION'

/**
 * Return client-safe copy for one normalized Acosmi failure code.
 * @param code - provider-neutral Harness failure code.
 * @returns fixed text that contains no SDK response fields.
 */
export function acosmiPublicFailureMessage(code: string): string {
  switch (code) {
    case 'AUTH': return 'Acosmi authorization failed.'
    case 'RATE_LIMIT': return 'Acosmi provider rate limit rejected this request.'
    case 'SERVER': return 'Acosmi managed-model service is temporarily unavailable.'
    case 'PROVIDER': return 'Acosmi managed-model request was rejected.'
    case 'TIMEOUT': return 'Acosmi managed-model request timed out.'
    case 'TRANSPORT': return 'Acosmi managed-model transport failed.'
    case 'EMPTY_RESPONSE': return 'Acosmi managed-model service returned an empty response.'
    case 'UNKNOWN_MODEL': return 'The selected Acosmi model is no longer available.'
    case 'CONTEXT_WINDOW_EXCEEDED': return 'The Acosmi request exceeds the selected model context window.'
    case 'QUOTA_EXCEEDED': return 'Acosmi account quota does not permit this request.'
    default: return 'Acosmi managed-model request failed.'
  }
}

/**
 * Normalize either Acosmi HTTP or streaming rolling-window diagnostics.
 *
 * The provider rejects on projected use, so its current-used value alone does
 * not prove that the account exhausted the window. Keep that outcome distinct
 * from both terminal account quota and transient request-rate limiting.
 * @param error - SDK HTTP, stream, or raw stream-event failure.
 * @returns a neutral rolling-window failure, or undefined for another failure class.
 */
export function mapAcosmiWindowLimitError(error: unknown): LlmError | undefined {
  if (isWindowLimitError(error)) {
    return new LlmError(
      'Acosmi rolling-window reservation rejected this request.',
      ACOSMI_WINDOW_LIMIT_CODE,
      {
        status: error.statusCode,
        ...(error.retryAfter > 0 ? { providerRetryAfterMs: error.retryAfter * 1000 } : {}),
        cause: error,
      },
    )
  }
  if (!isWindowLimitStreamError(error)) return undefined
  return new LlmError(
    'Acosmi rolling-window reservation rejected this request.',
    ACOSMI_WINDOW_LIMIT_CODE,
    { cause: error },
  )
}

/**
 * Normalize provider rejections caused by duplicate final tool names.
 * @param error - SDK HTTP, stream, or raw stream-event failure.
 * @returns a stable tool-name collision, or undefined for another failure class.
 */
export function mapAcosmiToolNameCollisionError(error: unknown): LlmError | undefined {
  const detail = errorDetail(error)
  if (!isToolNameCollision(detail)) return undefined
  return new LlmError(
    'Acosmi managed-model gateway produced duplicate final tool names.',
    ACOSMI_TOOL_NAME_COLLISION_CODE,
    { cause: error },
  )
}

function errorDetail(error: unknown): string {
  if (error instanceof HTTPError) return `${error.message}\n${error.body}`
  if (error instanceof StreamError) return `${error.message}\n${error.rawError}`
  if (error instanceof Error) return error.message
  if (typeof error !== 'object' || error === null || Array.isArray(error)) return String(error)
  return ['message', 'rawError', 'error']
    .map(key => Reflect.get(error, key))
    .filter((value): value is string => typeof value === 'string')
    .join('\n')
}

function isToolNameCollision(detail: string): boolean {
  return /\btool names? must be unique\b/iu.test(detail)
    || /\bfunction name\b[^\n]*\b(?:is\s+)?duplicated?\b/iu.test(detail)
}
