import { GatewayError } from '@/shared/api';
import type { ModelReferrer } from './types';

/**
 * The machine code a gateway error carries (`MODEL_IN_USE`, `HF_TOKEN_REQUIRED`, …).
 *
 * `GatewayError.code` holds the NestJS error NAME ("Conflict"); the domain code
 * rides in the body. Its exact key is not pinned by the contract yet (Lane R
 * owns it), so this looks in every place a Nest filter plausibly puts it —
 * `body.code`, `body.error.code`, `body.details.code` — then falls back to the
 * message text. It lives in this one file so realigning after merge is a
 * one-line edit.
 */
export function gatewayErrorCode(error: unknown): string | undefined {
  if (!(error instanceof GatewayError)) return undefined;
  const body = error.details as Record<string, unknown> | undefined;
  const candidates: unknown[] = [
    body?.code,
    (body?.error as Record<string, unknown> | undefined)?.code,
    (body?.details as Record<string, unknown> | undefined)?.code,
    error.code,
  ];
  for (const candidate of candidates) if (typeof candidate === 'string' && /^[A-Z][A-Z0-9_]+$/.test(candidate)) return candidate;
  const fromMessage = /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/.exec(error.message);
  return fromMessage?.[1];
}

/** Referrers a 409 `MODEL_IN_USE` carries, wherever the body nests them. */
export function referrersFromError(error: unknown): ModelReferrer[] {
  if (!(error instanceof GatewayError)) return [];
  const body = error.details as Record<string, unknown> | undefined;
  const nested = body?.details as Record<string, unknown> | undefined;
  const list = body?.referrers ?? nested?.referrers;
  return Array.isArray(list) ? (list as ModelReferrer[]) : [];
}
