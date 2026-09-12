import { EntityId } from '@arcaai/domains';

/**
 * The rolling-monthly meter values for one tenant/window: the three ORIGINAL
 * business meters plus the six ledger-derived unit meters.
 * `transcriptionMinutes` is whole minutes (rounded from summed audio-ms), to
 * match the integer `monthly*` limit columns; every field is
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
 * `metering.service.ts` and the handoff notes for the exact tradeoff.
 */
export interface MeterUsage {
  consultations: number;
  transcriptionMinutes: number;
  summaries: number;
  /** WORKFLOW_INVOCATIONS — COUNT(WorkflowRun WHERE startedAt ∈ window), the same business-object shape as the other three. */
  workflowInvocations: number;
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

  /**
   * COMPUTE_SECONDS — `GPU_SECOND` + `CPU_SECOND` over the five INFERENCE
   * capabilities, excluding `guardrail.validate` (TASK-959 §3).
   *
   * OCCUPANCY, not physical hardware time: the seconds a request held a model
   * on a device. Every service already measures that per request; none can
   * attribute a physical GPU-second, because concurrency (LM Studio's parallel
   * slots, vLLM's continuous batching, STT's utterance batching, time-slicing)
   * is never recorded per call. COGS truth comes from a monthly DCGM
   * reconciliation, not from this figure (D-2).
   *
   * Guardrail is excluded for the same reason it is excluded from
   * `llmTokens`: it is platform-mandated safety the tenant did not ask for and
   * is never billed (D16). `harness.step` is NOT excluded — after TASK-957 F-1
   * it means the consultation lane, whose compute is the tenant's own clinical
   * work.
   */
  computeSeconds: number;

  /**
   * WORKFLOW_CPU_SECONDS — `CPU_SECOND` under capability `WORKFLOW` (§3.4).
   *
   * What `hope-harness-worker` itself burned orchestrating this tenant's runs,
   * as opposed to the inference those runs called. Disjoint from
   * {@link computeSeconds} by capability, so a workflow run's LLM seconds and
   * its worker CPU each count exactly once.
   *
   * `CPU_SECOND` alone, matching the name: the worker is a Python event loop
   * and the emitter stamps `device: 'cpu'` unconditionally, so a
   * `WORKFLOW`/`GPU_SECOND` row is not a shape anything produces.
   */
  workflowCpuSeconds: number;

  /**
   * The gigabytes this tenant was holding at the LATEST snapshot in the window
   * (§5).
   *
   * A LEVEL, not a sum. `STORAGE_GB_DAY` rows accumulate one per day, so
   * summing a month answers "GB-days consumed" — which is what the INVOICE
   * wants — while "how much am I storing" is the last snapshot alone. Adding
   * the month here would report roughly thirty times the truth.
   *
   * The one FRACTIONAL field on this interface. Rounding it would report `0`
   * for every tenant holding less than a gigabyte; the integer that reaches
   * `TenantUsageMeter` is the BYTE count derived from it.
   */
  storageGb: number;

  /**
   * `EGRESS_BYTE` + `INGRESS_BYTE` on CLOUD and BYOK legs, all capabilities
   * (§4).
   *
   * Self-hosted legs are deliberately excluded even though they are counted in
   * the ledger: LAN traffic to HOPE's own LM Studio is not third-party
   * consumption, and the figure exists to answer what left the platform.
   * Recorded for visibility and capacity planning; priced later, if at all
   * (D-3).
   */
  thirdPartyBytes: number;
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
