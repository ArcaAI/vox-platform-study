import { ModelTaskType } from '@arcaai/domains';

/**
 * TASK-506 — the AI tasks whose default model is selected through
 * `AiTaskDefault` rows (the Class-3 generalization of
 * `HarnessPolicy.smrProvider/smrModel` for non-pipeline tasks). Extensible:
 * new keys are added here + a compatibility mapping below + a
 * `models.<taskKey>` descriptor in the settings registry.
 */
export const AI_TASK_KEYS = ['guardrail.validate', 'nlp.ner', 'nlp.classification'] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * taskKey → the `AiModel.taskType` a bound slug must carry. Upserts reject a
 * slug whose registry row declares a different task type.
 */
export const AI_TASK_MODEL_TASK_TYPES: Record<AiTaskKey, ModelTaskType> = {
  'guardrail.validate': ModelTaskType.GUARDRAIL,
  'nlp.ner': ModelTaskType.TOKEN_CLASSIFICATION,
  'nlp.classification': ModelTaskType.TEXT_CLASSIFICATION,
};

/** Task-key prefix whose writes are GLOBAL-ADMIN-ONLY (owner directive 2026-07-17). */
export const GLOBAL_ADMIN_ONLY_TASK_PREFIX = 'guardrail.';
