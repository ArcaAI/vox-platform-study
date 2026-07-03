import type { RateLimitTierName, RateLimitValueSource } from '@arcaai/vox';

/**
 * TASK-403 — pure presentation logic for the Rate Limits surface (design frame
 * `14` v2): "limit / window" strings and the db/code/default provenance pills.
 */

/** Window ttl (ms) → "60s" / "2m" / "500ms". The canonical 60s window stays in seconds (design: "100 req / 60s"). */
export function formatWindow(ttlMs: number): string {
  if (ttlMs < 1_000) return `${ttlMs}ms`;
  const seconds = ttlMs / 1_000;
  if (seconds > 60 && seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/** Design string shape for tier cards: "100 req / 60s". */
export function formatLimitPerWindow(limit: number, ttlMs: number): string {
  return `${limit} req / ${formatWindow(ttlMs)}`;
}

/**
 * Provenance pill color: `db` = live admin override (brand teal), `code` =
 * route-decorator baseline (info), `default` = static fallback (neutral).
 */
export function sourceColorRole(source: RateLimitValueSource): 'hope' | 'info' | 'neutral' {
  if (source === 'db') return 'hope';
  if (source === 'code') return 'info';
  return 'neutral';
}

/** The design highlights `strict` as the auth-critical baseline. */
export const AUTH_CRITICAL_TIER: RateLimitTierName = 'strict';

const TIER_DESCRIPTIONS: Record<RateLimitTierName, string> = {
  default: 'Baseline for every throttled route without a stricter tier.',
  strict: 'Tight bound for auth-critical endpoints (login, credential stuffing).',
  heavy: 'Expensive compute endpoints (summaries, exports).',
  relaxed: 'High-volume read endpoints (monitoring, polling).',
};

export function tierDescription(tier: RateLimitTierName): string {
  return TIER_DESCRIPTIONS[tier];
}
