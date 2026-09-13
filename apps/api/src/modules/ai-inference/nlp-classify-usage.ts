/**
 * The `nlp.classify` batch (TASK-957 F-7b).
 *
 * ============================================================================
 * WHY A SECOND NLP OPERATION AND NOT `ner.extract`
 * ============================================================================
 * `ner.extract` is entity extraction. The classification benches run DIFFERENT
 * models — a disease classifier, a symptom NER, and (for topic/intent) an LLM
 * on another service entirely — at different prices. `operation` is the only
 * dimension on which a rollup could ever tell the two apart, and rows merged
 * under one name can never be separated again for a tenant asking what its
 * spend went on. So they are two operations from the start.
 *
 * Shaped deliberately like `consultation/shared/nerUsageEvent.ts`, down to the
 * TEXT_UNIT / REQUEST pair and the `built-in` provider: both are the platform's
 * own in-process weights, there is no cloud or BYOK NLP plane to classify
 * against, and a reader comparing the two rows should see one shape.
 */
import { appendComputeAndByteUnits, UsageIdempotencyKey, type ComputeDevice, type UsageEventBatchInput } from '@arcaai/applications';
import { AiCapability, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

export interface NlpClassifyUsageParams {
  tenantId: string;
  /**
   * Ties every unit row of THIS ONE invocation together and keys the idempotency base. A FRESH
   * id per call, never a reused one: two classifications in a session must be two rows, or the
   * second is silently discarded at the ledger as a replay.
   */
  requestId: string;
  /** ATTRIBUTION only — the acting clinician, when the caller is one. */
  doctorId?: string | null;
  /**
   * Characters SENT for classification, for the `TEXT_UNIT` row (100 characters to the unit,
   * exactly as `ner.extract` counts).
   *
   * OMITTED for a DELEGATED route (`/topic`, `/intent`): there the classification is an LLM
   * call billed in tokens, and charging the same work again as NLP text units would bill one
   * activity twice, on two capabilities.
   */
  charCount?: number | null;
  /** The resolved `AiModel.sourceUri`, or null when the caller resolved none. */
  model: string | null;
  /** `apps/nlp`'s own wall clock in the model, for this call. Omitted ⇒ no compute row. */
  inferenceMs?: number | null;
  /** The device `apps/nlp` reported. It DECIDES the unit, so an unrecognised value records none. */
  device?: ComputeDevice | null;
}

/**
 * Build the batch, or `null` when there is nothing to record.
 *
 * `null` rather than an empty batch for the one case that reaches it: a delegated route whose
 * `apps/nlp` reported no timing of its own — no text units by construction, no seconds measured,
 * so there is no honest row to write.
 */
export function buildNlpClassifyUsage(params: NlpClassifyUsageParams): UsageEventBatchInput | null {
  const units = [];
  if (typeof params.charCount === 'number' && params.charCount > 0) {
    units.push({ unit: AiUsageUnit.TEXT_UNIT, quantity: params.charCount / 100 }, { unit: AiUsageUnit.REQUEST, quantity: 1 });
  }

  const batch: UsageEventBatchInput = {
    common: {
      tenantId: params.tenantId,
      idempotencyKey: UsageIdempotencyKey.nlpRequest(params.requestId),
      occurredAt: new Date(),
      capability: AiCapability.NLP,
      operation: 'nlp.classify',
      // The platform's own in-process weights — no cloud/BYOK NLP plane exists, and the
      // `AiModel` seed files these catalogue rows under the same provider.
      provider: 'built-in',
      model: params.model,
      deployment: AiDeploymentKind.SELF_HOSTED,
      doctorId: params.doctorId ?? null,
      requestId: params.requestId,
    },
    units,
  };

  // This function BUILDS the batch, so this function appends (compute-units.ts's rule). A
  // SELF_HOSTED + INTERNAL row can never split a cost basis, so `platformBatch` is unreachable
  // here; bytes are not applicable, because no vendor is called.
  const { batch: augmented } = appendComputeAndByteUnits(batch, { device: params.device, totalMs: params.inferenceMs });
  return augmented.units.length > 0 ? augmented : null;
}
