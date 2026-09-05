import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { UsageEventBatchInput } from '../../usageLedger/dto';
import { UsageIdempotencyKey } from '../../usageLedger/idempotency-keys';

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
  const { tenantId, requestId, consultationId, doctorId, charCount, model } = params;
  return {
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
    },
    units: [
      { unit: AiUsageUnit.TEXT_UNIT, quantity: charCount / 100 },
      { unit: AiUsageUnit.REQUEST, quantity: 1 },
    ],
  };
}
