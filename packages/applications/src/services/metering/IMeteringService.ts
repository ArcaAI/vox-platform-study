import { EntityId } from '@arcaai/domains';

/**
 * The rolling-monthly meter values for one tenant/window: the three ORIGINAL
 * business meters plus the six TASK-615 ledger-derived unit meters.
 * `transcriptionMinutes` is whole minutes (rounded from summed audio-ms), to
 * match the integer `monthly*` limit columns; every TASK-615 field is
 * likewise rounded to a whole unit for the same reason (the allowance columns
 * are integers/`BigInt`, never fractional).
 *
 * The six new fields are read from `AiUsageRollupDaily` (D5) — NOT summed from
 * the raw `AiUsageEvent` ledger — with one exception: `guardrailCalls` is a
 * distinct-`requestId` COUNT over the raw ledger, because the rollup's unique
 * dimension is `(tenantId, bucketStart, capability, provider, model, unit)`
 * with NO `operation` column, and `guardrail.validate` shares BOTH capability
 * (`LLM`) and every token unit with `generate`/`generate.stream`/
 * `presummarize`/`harness.step` — so at the rollup grain a guardrail call is
 * structurally indistinguishable from a summarization call. `operation`
 * SURVIVES on the raw event, so that is the only place a guardrail-specific
 * figure can be read from. This is also why `llmTokens` — read from the
 * rollup — necessarily INCLUDES guardrail's (and harness's) token
 * consumance: the rollup cannot separate it out. `monthlyLlmTokens` is priced
 * against a tenant's OWN generation, and guardrail/harness usage is
 * platform-mandated and never billed to the tenant (D16) — this is a known,
 * documented approximation of the current rollup schema, not a bug; see
 * `metering.service.ts` and the WS-H handoff notes for the exact tradeoff.
 */
export interface MeterUsage {
  consultations: number;
  transcriptionMinutes: number;
  summaries: number;
  /** STT_SESSION_SECONDS — `SESSION_SECOND` under capability `STT` (OQ1: session, not audio, seconds). */
  sttSessionSeconds: number;
  /** LLM_TOKENS — all five billable token kinds summed under capability `LLM` (see the header note on guardrail/harness inclusion). */
  llmTokens: number;
  /** TTS_CHARACTERS — `CHARACTER` under capability `TTS` (accepted input, Unicode code points). */
  ttsCharacters: number;
  /** NLP_TEXT_UNITS — `TEXT_UNIT` under capability `NLP` (chars/100, consultation-batched). */
  nlpTextUnits: number;
  /**
   * GUARDRAIL_CALLS — informational only (D6/D16: guardrail is metered but
   * NEVER quota-blocked; there is no `monthlyGuardrailCalls` allowance column
   * for `assertMeterQuota` to read). Distinct-`requestId` count over the raw
   * ledger for `operation: 'guardrail.validate'` — see the header note.
   */
  guardrailCalls: number;
  /** EMBEDDING_TOKENS — all five billable token kinds summed under capability `EMBEDDING`. */
  embeddingTokens: number;
}

/**
 * Rolling-monthly metering contract.
 *
 * Reads (`getCurrentUsage`) are a LIVE Postgres aggregate over the current UTC
 * calendar-month window — authoritative and near-realtime, correct even when
 * the reconcile job is off. `reconcileTenant` / `reconcileAllActiveTenants`
 * PERSIST those aggregates into `TenantUsageMeter` (the job body). All queries
 * are cross-tenant-safe (explicit `tenantId`, unscoped base client) so the job
 * can run with no CLS tenant context.
 */
export interface IMeteringService {
  /** Live aggregate of the CURRENT month window for one tenant (no writes). */
  getCurrentUsage(tenantId: EntityId, now?: Date): Promise<MeterUsage>;

  /** Aggregate + upsert the tenant's three meter rows for the current window. */
  reconcileTenant(tenantId: EntityId, now?: Date): Promise<MeterUsage>;

  /** Reconcile every tenant (the scheduled-job body). Returns the count done. */
  reconcileAllActiveTenants(now?: Date): Promise<{ tenants: number }>;
}

export const IMeteringService = Symbol('IMeteringService');
