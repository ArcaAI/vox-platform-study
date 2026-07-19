import { ModelTaskType } from '@arcaai/domains';

/**
 * TASK-506 — the AI tasks whose default model is selected through
 * `AiTaskDefault` rows (the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel` for non-pipeline tasks). Extensible:
 * new keys are added here + a compatibility mapping below + a
 * `models.<taskKey>` descriptor in the settings registry.
 */
// TASK-511 (Phase 3A) — `smr.live` / `smr.finalize` route the two SMR generation
// flows (live-documentation delta vs. final/comprehensive summary). They are the
// AiTaskDefault-first precedence source for `HarnessPolicyService.resolveSmrSelection`.
export const AI_TASK_KEYS = ['guardrail.validate', 'nlp.ner', 'nlp.classification', 'smr.live', 'smr.finalize'] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * taskKey → the `AiModel.taskType` a bound slug must carry. Upserts reject a
 * slug whose registry row declares a different task type.
 */
export const AI_TASK_MODEL_TASK_TYPES: Record<AiTaskKey, ModelTaskType> = {
  'guardrail.validate': ModelTaskType.GUARDRAIL,
  'nlp.ner': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.classification': ModelTaskType.TEXT_CLASSIFICATION,
  // SMR generation models are text-generation models in the registry.
  'smr.live': ModelTaskType.TEXT_GENERATION,
  'smr.finalize': ModelTaskType.TEXT_GENERATION,
};

/**
 * Task-key prefixes whose writes are GLOBAL-ADMIN-ONLY (a privilege boundary →
 * 403, NOT the 404-over-403 cross-tenant posture):
 *  - `guardrail.` (owner directive 2026-07-17)
 *  - `smr.`       (TASK-511 Phase 3A — platform-owned model routing)
 */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIXES = ['guardrail.', 'smr.'] as const;

/** @deprecated Use {@link GLOBAL_ADMIN_ONLY_TASK_PREFIXES}. Retained for back-compat. */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIX = 'guardrail.';
