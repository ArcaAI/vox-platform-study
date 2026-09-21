import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { appendComputeAndByteUnits } from '../../usageLedger/compute-units';
import { UsageEventBatchInput } from '../../usageLedger/dto';
import { UsageIdempotencyKey } from '../../usageLedger/idempotency-keys';
import { COMPUTE_DEVICES, type ComputeDevice, type UsageTrigger } from '../../usageLedger/usage-attributes';

/**
 * TASK-999 (D-2(c)) — `inference_ms` off an NLP response body, or `null`.
 *
 * Lives beside the builder that consumes it because it is a reader of the SAME wire contract:
 * `apps/nlp` reports its own `inference_ms` on every inference response, and every body that
 * carries it is typed `Record<string, unknown>` (proxied verbatim, or spread off an axios
 * response), so this is a shape check rather than trust in a schema the caller does not own.
 *
 * `apps/api/src/modules/ai-inference/ai-inference.controller.ts` holds a private copy predating
 * this one; the two agree exactly and should converge here when that file is next opened.
 */
export function nerInferenceMs(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * TASK-999 (D-2(c)) — the device, from the CLOSED vocabulary only.
 *
 * A near-miss spelling records NO compute row; it must never be coerced into the more expensive
 * unit (`GPU_SECOND` is priced roughly fifty times `CPU_SECOND`). Same provenance note as
 * {@link nerInferenceMs}.
 */
export function nerDevice(value: unknown): ComputeDevice | null {
  return typeof value === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(value) ? (value as ComputeDevice) : null;
}

export interface NerUsageEventParams {
  tenantId: string;
  /**
   * Ties every unit row of THIS ONE NER invocation together and keys the
   * idempotency base — the job id for the async `ner.processor.ts` path, a
   * freshly generated id for the synchronous `extractEntities` path. NEVER
   * shared across invocations: two calls in the same consultation MUST get
   * two distinct keys, or the second is silently dropped at the ledger.
   */
  requestId: string;
  /**
   * ATTRIBUTION only (a column on the event, not part of the identity/key).
   * May be — and normally is — the same value across many invocations for
   * one consultation. Optional: the playground
   * `/ai/nlp/entities` call site is a standalone inference proxy with NO
   * consultation context at all — omitted rather than fabricated.
   */
  consultationId?: string | null;
  /**
   * ATTRIBUTION only. Set for the playground call site when
   * the CLS caller is a clinician (DOCTOR/SPECIALIST/CONSULTANT); the two
   * existing consultation-scoped call sites (ner.processor, summary.service
   * extractEntities) leave it unset — the consultation's own doctorId already
   * covers attribution there.
   */
  doctorId?: string | null;
  /** Character count of the text SENT to NLP for THIS call. */
  charCount: number;
  /** The resolved AiRoutingPolicy model name, or null when resolution fail-opened (unknown, never guessed). */
  model: string | null;
  /**
   * TASK-959 §3.2 — wall-clock milliseconds `apps/nlp` spent in the model for THIS call
   * (`inference_ms`, on every inference response since the P-NLP lane).
   *
   * OPTIONAL because the three call sites adopt it as their own paths start carrying it, and
   * because an omitted reading must record NO compute row — a zero-second row would read as
   * "measured, and it was free".
   */
  inferenceMs?: number | null;
  /**
   * TASK-999 (D-2(c)) — the CALLER's wall clock around the NLP hop, in milliseconds.
   *
   * The fallback reading, used only when `apps/nlp` reported no `inference_ms` of its own:
   * `appendComputeAndByteUnits` prefers the engine's time and falls back to this, so a call
   * timed by both is metered on the engine's number and a call timed by neither still records
   * NO compute row (an unmeasured call must never bill as zero seconds).
   *
   * This is the ledger's answer to "how long did NER take". `NamedEntity.processingTimeMs` is
   * NOT: it is stamped identically on EVERY entity one call produced, so a `SUM` over it
   * multiplies one call's duration by its entity count. Nothing reads it for duration any more.
   */
  totalMs?: number | null;
  /**
   * TASK-959 §3.1 — the device the checkpoint was resolved onto, which DECIDES the unit
   * (`cuda`/`mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND`). Unlike the LLM engines, `apps/nlp`
   * reports its own device, so nothing here consults the settings cascade.
   */
  device?: ComputeDevice | null;
  /**
   * TASK-957 F-8 — WHICH PRODUCT ACTIVITY caused this extraction (OD-E's closed
   * vocabulary).
   *
   * Three call sites share this builder and they are three different
   * activities: the agent NER route, the playground `/ai/nlp/entities` bench,
   * and the clinical `extractEntities` hop. Only the CALLER knows which, so it
   * is passed in rather than derived — and it is OPTIONAL rather than
   * defaulted, because a default would put a guess on a rollup dimension whose
   * whole point is that a wrong value forks silently instead of failing.
   */
  trigger?: UsageTrigger | null;
}

/**
 * Build the NLP entity-extraction usage event (`ner.extract`).
 *
 * Shared by both clinical NER call sites — `ner.processor.ts` (durable BullMQ
 * job) and `summary.service.ts` (synchronous `extractEntities`) — so the
 * emission shape can't drift between them.
 *
 * ============================================================================
 * PER-INVOCATION BILLING, CONSULTATION ATTRIBUTION (revised — see below)
 * ============================================================================
 * `idempotencyKey` is derived from `requestId` — the ACTUAL NER invocation id
 * (a job id or a generated request id), never from `consultationId`. Each
 * invocation gets its own key and its own TEXT_UNIT/REQUEST quantities;
 * `consultationId` rides along only as an attribution column so rollups and
 * per-consultation cost views can group by it.
 *
 * An EARLIER version of this helper keyed on `consultationId` alone, reasoning
 * that "consultation-batched" meant collapsing every NER call for one
 * consultation onto a single ledger row via the drainer's idempotency dedup.
 * That was wrong: it silently DROPPED every invocation after the first one
 * for a consultation — real NLP work with zero corresponding usage record.
 * "Consultation-batched" is a CALL-PATTERN rule (invoke NLP with bigger
 * inputs, less often, to avoid per-utterance pricing minimums), not a
 * billing-identity rule. Metering must reflect what actually happened: N
 * invocations for a consultation bill as N rows, correctly attributed to that
 * consultation, never collapsed into one.
 */
export function buildNerUsageEvent(params: NerUsageEventParams): UsageEventBatchInput {
  const { tenantId, requestId, consultationId, doctorId, charCount, model, trigger } = params;
  // TASK-959 — the compute row is appended by the ONE shared helper, here, because this function
  // is what BUILDS the batch (see `usageLedger/compute-units.ts`). A NER row can only ever be
  // SELF_HOSTED + INTERNAL (apps/nlp runs the platform's own weights, and there is no
  // AiProviderConnection plane for NER at all), so `platformBatch` is unreachable for it and the
  // compute row always rides this batch. Bytes are not applicable: no vendor is called.
  const batch: UsageEventBatchInput = {
    common: {
      tenantId,
      idempotencyKey: UsageIdempotencyKey.nlpRequest(requestId),
      occurredAt: new Date(),
      capability: AiCapability.NLP,
      operation: 'ner.extract',
      // The platform's own in-process transformers pipeline — no external
      // cloud/BYOK NER path exists (matches the AiModel seed's `provider:
      // 'built-in'` for the medical-ner / symps-disease-bert catalog rows).
      provider: 'built-in',
      model,
      deployment: AiDeploymentKind.SELF_HOSTED,
      // Attribution only — never folded into the idempotency key.
      consultationId: consultationId ?? null,
      doctorId: doctorId ?? null,
      requestId,
      // Spread only when the caller declared one, so a row from a call site that
      // has not adopted it stays byte-identical to what it always emitted.
      ...(trigger ? { attributesJson: { trigger } } : {}),
    },
    units: [
      { unit: AiUsageUnit.TEXT_UNIT, quantity: charCount / 100 },
      { unit: AiUsageUnit.REQUEST, quantity: 1 },
    ],
  };

  // TASK-999 (D-2(c)) — `inference_ms` is the ENGINE's own reading and now rides `engineMs`,
  // which is where the appender's documented precedence (engine, then client wall clock) puts
  // it. Behaviour is unchanged for the two callers that pass only `inferenceMs`: the appender
  // picked the same number when it arrived as `totalMs`. What is new is that a caller may now
  // ALSO pass its own wall clock, so a duration lands on the row even when `apps/nlp` reported
  // none — which is the whole gap: the clinical `extractEntities` hop passed no timing at all,
  // so its `ner.extract` rows carried characters and no seconds.
  return appendComputeAndByteUnits(batch, { device: params.device, engineMs: params.inferenceMs, totalMs: params.totalMs }).batch;
}
