import { ModelTaskType } from '@arcaai/domains';

/**
 * The AI tasks whose default model is selected through
 * `AiTaskDefault` rows (the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel` for non-pipeline tasks). Extensible:
 * new keys are added here + a compatibility mapping below + a
 * `models.<taskKey>` descriptor in the settings registry.
 */
// `smr.live` / `smr.finalize` route the two SMR generation
// flows (live-documentation delta vs. final/comprehensive summary). They are the
// AiTaskDefault-first precedence source for `HarnessPolicyService.resolveSmrSelection`.
// additive keys moving the last env-selected surfaces into the DB
// control plane: `guardrail.safety` (GLiNER content-safety detector),
// `guardrail.groundedness` (MiniCheck NLI fact-checker), `harness.judge`
// (LLM-as-judge), and `nlp.diagnosis` (the diagnosis suggester, split out of
// the mis-keyed `nlp.classification` doc-type classifier).
export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  'nlp.ner',
  'nlp.classification',
  'nlp.diagnosis',
  'smr.live',
  'smr.finalize',
  'harness.judge',
] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * taskKey → the `AiModel.taskType` a bound slug must carry. Upserts reject a
 * slug whose registry row declares a different task type.
 */
export const AI_TASK_MODEL_TASK_TYPES: Record<AiTaskKey, ModelTaskType> = {
  'guardrail.validate': ModelTaskType.GUARDRAIL,
  // GLiNER content-safety detector (token-level PII/label spans).
  'guardrail.safety': ModelTaskType.TOKEN_CLASSIFICATION,
  // MiniCheck is an NLI/entailment fact-checker; TEXT_CLASSIFICATION
  // is the closest existing ModelTaskType (no dedicated NLI type exists).
  'guardrail.groundedness': ModelTaskType.TEXT_CLASSIFICATION,
  'nlp.ner': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.classification': ModelTaskType.TEXT_CLASSIFICATION,
  // diagnosis suggester (symptom→disease text classification).
  'nlp.diagnosis': ModelTaskType.TEXT_CLASSIFICATION,
  // SMR generation models are text-generation models in the registry.
  'smr.live': ModelTaskType.TEXT_GENERATION,
  'smr.finalize': ModelTaskType.TEXT_GENERATION,
  // the harness LLM-as-judge is a text-generation model.
  'harness.judge': ModelTaskType.TEXT_GENERATION,
};

/**
 * Task-key prefixes whose writes AND effective resolution are GLOBAL-ADMIN-ONLY
 * (a privilege boundary → 403 on write, NOT the 404-over-403 cross-tenant posture).
 * Runtime reads ignore per-tenant override rows and use the SYSTEM row only
 * (tenants may only *use* platform defaults for these surfaces).
 *  - `guardrail.` (owner directive 2026-07-17)
 * - `smr.`
 * - `nlp.`
 * - `harness.`
 */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'smr.', 'nlp.', 'harness.'] as const;

/** @deprecated Use {@link GLOBAL_ADMIN_ONLY_TASK_PREFIXES}. Retained for back-compat. */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIX = 'guardrail.';

/** True when `taskKey` is under a GLOBAL_ADMIN-only prefix. */
export function isGlobalAdminOnlyTaskKey(taskKey: string): boolean {
  return GLOBAL_ADMIN_ONLY_TASK_PREFIXES.some((p) => taskKey.startsWith(p));
}
