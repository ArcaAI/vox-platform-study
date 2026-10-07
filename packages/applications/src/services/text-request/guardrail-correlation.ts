/**
 * TASK-1050 — the guardrail CORRELATION a gateway → TEXT call carries (README §9.6), and the one rule
 * that keeps it trustworthy.
 *
 * TEXT forwards every incoming `X-Hope-*` header to guardrail, which stamps the values on its
 * `GuardrailEvaluation` record — and `X-Hope-Guardrail-Override` re-runs a blocked request as `warn`.
 * So every `x-hope-*` name is INTERNAL (`@arcaai/types` `HOPE_INTERNAL_HEADER_PREFIX`): a header a
 * caller sent is never forwarded ({@link stripHopeInternalHeaders}), and the gateway sets the correlation
 * itself, from trusted context only ({@link guardrailCorrelationHeaders}).
 */
import { GUARDRAIL_CORRELATION_HEADERS } from '@arcaai/types';

/** `@arcaai/types` `HOPE_INTERNAL_HEADER_PREFIX` (restated: the dist that carries it may lag this file). */
const HOPE_INTERNAL_HEADER_PREFIX = 'x-hope-';

/** What the gateway knows about one call, from its OWN context (never from the caller's headers). */
export interface GuardrailCorrelation {
  readonly consultationId?: string | null;
  readonly itemId?: string | null;
  readonly runKey?: string | null;
  readonly runId?: string | null;
  readonly nodeId?: string | null;
}

/** The context items behind each guardrail region (`GenerateRequest.region_items`): `{ key: [{ itemId, itemVersion }] }`. */
export type GuardrailRegionItems = Readonly<Record<string, ReadonlyArray<{ readonly itemId: string; readonly itemVersion: number }>>>;

/** The canonical `X-Hope-*` headers for the fields that are known and non-empty. */
export function guardrailCorrelationHeaders(correlation: GuardrailCorrelation | null | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!correlation) return headers;
  for (const [field, header] of Object.entries(GUARDRAIL_CORRELATION_HEADERS) as [keyof GuardrailCorrelation, string][]) {
    const value = correlation[field];
    if (typeof value === 'string' && value.length > 0) headers[header] = value;
  }
  return headers;
}

/** `headers` without any `x-hope-*` entry (case-insensitive). Never mutates the input. */
export function stripHopeInternalHeaders<T extends Record<string, unknown>>(headers: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!name.toLowerCase().startsWith(HOPE_INTERNAL_HEADER_PREFIX)) out[name] = value;
  }
  return out as T;
}

/** A well-formed copy of `regionItems` (empty lists and malformed refs dropped), or `undefined`. */
export function regionItemsWire(regionItems: GuardrailRegionItems | null | undefined): Record<string, Array<{ itemId: string; itemVersion: number }>> | undefined {
  if (!regionItems) return undefined;
  const out: Record<string, Array<{ itemId: string; itemVersion: number }>> = {};
  for (const [key, refs] of Object.entries(regionItems)) {
    const valid = (refs ?? []).filter(
      (ref) => typeof ref?.itemId === 'string' && ref.itemId.length > 0 && Number.isInteger(ref.itemVersion) && ref.itemVersion >= 0,
    );
    if (valid.length > 0) out[key] = valid.map(({ itemId, itemVersion }) => ({ itemId, itemVersion }));
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
