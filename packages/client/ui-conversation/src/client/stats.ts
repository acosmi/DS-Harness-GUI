import type { ContextPressureProjection } from '@deepseek-ai/dsh-token-meter/client'

/**
 * Compact token count: 517 / 12.2K / 517K / 1.2M.
 * @param n - token count.
 * @returns compact display text with at most one decimal below three digits.
 */
export function formatTokens(n: number): string {
  const scaled = (v: number): string =>
    v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10)
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** Context-window occupancy resolved from the durable pressure projection. */
export interface ContextOccupancy {
  percent: number
  usedTokens: number
  contextWindow: number
}

/**
 * Approximate context occupancy using the provider sample carried forward by
 * the token-meter projection.
 * @param pressure - the session's context-pressure projection value.
 * @returns occupancy, or null until both numerator and capacity are known.
 */
export function contextOccupancy(
  pressure: ContextPressureProjection | undefined,
): ContextOccupancy | null {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  if (usedTokens === undefined || pressure?.contextWindow === undefined) return null
  return {
    percent: Math.min(100, Math.round(usedTokens / pressure.contextWindow * 100)),
    usedTokens,
    contextWindow: pressure.contextWindow,
  }
}
