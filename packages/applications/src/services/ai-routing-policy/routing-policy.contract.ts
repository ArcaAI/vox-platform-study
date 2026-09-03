/**
 * The JSONB structures on `AiRoutingPolicy`, as TypeScript
 *
 * The Prisma model keeps `matchJson` / `candidatesJson` / `fallbackJson` /
 * `healthJson` as JSONB precisely because they are nested; the shape rule
 * Lane F' recorded on the model is that "anything the resolver must MATCH ON,
 * ORDER BY or ENFORCE A CEILING WITH is a scalar column" and everything else
 * is "validated at the application layer". This file is that validation, plus
 * the vocabulary the resolver reasons over.
 *
 * ## Two things deliberately absent
 *
 * 1. **No residency taxonomy.** `residency` is an opaque LABEL supplied by the
 *    policy row. The gate asks only "is the hop's class EQUAL to the primary's",
 *    never "is class X permitted" — so there is no enumerated list of clouds in
 *    application code to drift from reality (rule 00: a label set is config, not
 *    a literal). New regions need a new policy row, never a new release.
 * 2. **No invented fallback defaults.** An ABSENT `fallbackJson` means
 * `maxDepth: 0` — no hop at all — not some plausible-looking number.
 *    requires a hard cap on hops; a default pulled out of the air would be a
 *    threshold wearing a config costume AND would silently authorise a hop the
 *    author never wrote. Absence is fail-closed here.
 *
 * The three gate flags DO carry defaults, and those defaults are the SECURE
 * posture (`requireSameResidencyClass: true`, `requireBaaCovered: true`,
 * `crossFundingAllowed: false`). That is not a tuning value — it is the
 * ruling expressed as the state you get when nobody said otherwise.
 */

/** One candidate in the ordered chain. */
export interface RoutingCandidate {
  /** Position in the chain. Lower serves first under `PRIORITY`. */
  rank: number;
  /** Split within a rank tier under `WEIGHTED`. */
  weight: number;
  /**
   * Names an `AiProviderConnection` by its `provider` under the `llm` service
   * — the model's real natural key is `(tenantId, service, provider)`, so this
   * is `provider`, NOT a free-form connection nickname. See the note in
   * `ai-routing-policy.service.ts` on the illustration.
   */
  connectionRef: string;
  /** Model id served by that connection. */
  model: string;
  /** Opaque residency-class label. Compared for EQUALITY only. */
  residency: string;
  /** Whether a BAA covers this vendor AND this model. Per-model, per-vendor. */
  baaCovered: boolean;
  /** Optional TTFT budget, advisory to the router. */
  maxTtftMs?: number | null;
}

/** The depth-bounded, typed fallback contract */
export interface RoutingFallbackContract {
  /** Hops AFTER the primary. Hard cap. 0 (and absence) = no fallback. */
  maxDepth: number;
  /** Typed triggers; opaque to this layer, consumed by the router. */
  triggers: string[];
  requireSameResidencyClass: boolean;
  requireBaaCovered: boolean;
  crossFundingAllowed: boolean;
}

/** Narrowing predicate — a per-model override is a row with a narrower match. */
export interface RoutingMatch {
  models?: string[] | null;
  metadata?: Record<string, string> | null;
  minContextTokens?: number | null;
  maxContextTokens?: number | null;
}

/** What a request tells the resolver about itself, for `match` evaluation. */
export interface RoutingRequestContext {
  /** The logical model the caller asked for, if any. */
  model?: string | null;
  /** Request metadata the policy may match on (e.g. `{ phi: 'true' }`). */
  metadata?: Record<string, string> | null;
  /** Context size of the request, for the min/max window predicates. */
  contextTokens?: number | null;
}

/**
 * The FAIL-CLOSED fallback contract: no hops, gates fully engaged.
 *
 * Returned whenever `fallbackJson` is absent or unparseable. A malformed
 * contract must never widen what a hop may do.
 */
export const NO_FALLBACK: RoutingFallbackContract = Object.freeze({
  maxDepth: 0,
  triggers: [],
  requireSameResidencyClass: true,
  requireBaaCovered: true,
  crossFundingAllowed: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const asFiniteInt = (value: unknown): number | null => (typeof value === 'number' && Number.isInteger(value) ? value : null);

/**
 * Parse `candidatesJson`. Throws nothing — an unparseable entry is DROPPED
 * rather than defaulted, because every field it would need a default for
 * (`residency`, `baaCovered`) is one the gates read. Guessing
 * `baaCovered: true` for a candidate whose author did not say so is exactly
 * the silent PHI redirection this ticket exists to prevent; guessing `false`
 * would be safe but would make a typo look like a policy decision. Dropping it
 * makes the omission visible as a missing candidate.
 *
 * Structural emptiness is already refused by `AiRoutingPolicyEntity.validate()`.
 */
export function parseCandidates(raw: unknown): RoutingCandidate[] {
  if (!Array.isArray(raw)) return [];
  const parsed: RoutingCandidate[] = [];
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    const connectionRef = entry.connectionRef;
    const model = entry.model;
    const residency = entry.residency;
    const baaCovered = entry.baaCovered;
    if (typeof connectionRef !== 'string' || connectionRef.length === 0) return;
    if (typeof model !== 'string' || model.length === 0) return;
    if (typeof residency !== 'string' || residency.length === 0) return;
    if (typeof baaCovered !== 'boolean') return;
    parsed.push({
      rank: asFiniteInt(entry.rank) ?? index,
      weight: asFiniteInt(entry.weight) ?? 100,
      connectionRef,
      model,
      residency,
      baaCovered,
      maxTtftMs: asFiniteInt(entry.maxTtftMs),
    });
  });
  return parsed;
}

/** Parse `fallbackJson`, falling CLOSED to {@link NO_FALLBACK} on absence. */
export function parseFallback(raw: unknown): RoutingFallbackContract {
  if (!isRecord(raw)) return NO_FALLBACK;
  const maxDepth = asFiniteInt(raw.maxDepth);
  return {
    maxDepth: maxDepth !== null && maxDepth > 0 ? maxDepth : 0,
    triggers: Array.isArray(raw.triggers) ? raw.triggers.filter((t): t is string => typeof t === 'string') : [],
    // Each flag relaxes only when the author said so EXPLICITLY with a boolean.
    // `undefined`, `null`, `"false"` and `0` all leave the gate engaged.
    requireSameResidencyClass: raw.requireSameResidencyClass !== false,
    requireBaaCovered: raw.requireBaaCovered !== false,
    crossFundingAllowed: raw.crossFundingAllowed === true,
  };
}

/** Parse `matchJson`. An absent/malformed match matches EVERYTHING (specificity 0). */
export function parseMatch(raw: unknown): RoutingMatch {
  if (!isRecord(raw)) return {};
  const models = Array.isArray(raw.models) ? raw.models.filter((m): m is string => typeof m === 'string') : null;
  const metadata = isRecord(raw.metadata)
    ? Object.fromEntries(Object.entries(raw.metadata).filter((pair): pair is [string, string] => typeof pair[1] === 'string'))
    : null;
  return {
    models: models && models.length > 0 ? models : null,
    metadata: metadata && Object.keys(metadata).length > 0 ? metadata : null,
    minContextTokens: asFiniteInt(raw.minContextTokens),
    maxContextTokens: asFiniteInt(raw.maxContextTokens),
  };
}

/**
 * Does `match` admit this request?
 *
 * A predicate the request cannot answer (it supplied no model, no metadata, no
 * context size) is treated as UNSATISFIED, not as vacuously true: a row that
 * narrows to `{"phi":"true"}` must not win for a request that never said it
 * carried PHI. Silence is not consent.
 */
export function matchesRequest(match: RoutingMatch, request: RoutingRequestContext): boolean {
  if (match.models) {
    if (!request.model || !match.models.includes(request.model)) return false;
  }
  if (match.metadata) {
    const supplied = request.metadata ?? {};
    for (const [key, value] of Object.entries(match.metadata)) {
      if (supplied[key] !== value) return false;
    }
  }
  if (match.minContextTokens !== null && match.minContextTokens !== undefined) {
    if (request.contextTokens === null || request.contextTokens === undefined) return false;
    if (request.contextTokens < match.minContextTokens) return false;
  }
  if (match.maxContextTokens !== null && match.maxContextTokens !== undefined) {
    if (request.contextTokens === null || request.contextTokens === undefined) return false;
    if (request.contextTokens > match.maxContextTokens) return false;
  }
  return true;
}

/**
 * How SPECIFIC a match predicate is — "most-specific match wins"
 *
 * One point per declared predicate. A row that pins both a model list and a
 * metadata key outranks one that pins only a model list; a row with no `match`
 * at all scores 0 and is the catch-all. Ties are broken by the explicit
 * `priority` column, then by the authored `policyVersion`.
 */
export function matchSpecificity(match: RoutingMatch): number {
  let score = 0;
  if (match.models) score += 1;
  if (match.metadata) score += Object.keys(match.metadata).length;
  if (match.minContextTokens !== null && match.minContextTokens !== undefined) score += 1;
  if (match.maxContextTokens !== null && match.maxContextTokens !== undefined) score += 1;
  return score;
}
