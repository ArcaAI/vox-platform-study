/**
 * Task keys governed by `TenantNlpTaskInstructions` (TASK-729) — the
 * open-taxonomy `nlp.*` task types whose per-tenant CONTENT (topic list /
 * intent list / free-text guidance) is tenant-writable. Deliberately a
 * separate, smaller list from `AI_TASK_KEYS` (ai-task-default/constants.ts):
 * that list governs MODEL/PROVIDER selection (super-admin-only for every
 * `nlp.*` key); this one governs tenant-authored INSTRUCTION CONTENT only,
 * and both `nlp.topic`/`nlp.intent` model selection still resolves through
 * `AiTaskDefault` under its unmodified lock — this table never carries a
 * `modelSlug`.
 */
export const TENANT_NLP_INSTRUCTION_TASK_KEYS = ['nlp.topic', 'nlp.intent'] as const;

export type TenantNlpInstructionTaskKey = (typeof TENANT_NLP_INSTRUCTION_TASK_KEYS)[number];

export function isKnownNlpInstructionTaskKey(taskKey: string): taskKey is TenantNlpInstructionTaskKey {
  return (TENANT_NLP_INSTRUCTION_TASK_KEYS as readonly string[]).includes(taskKey);
}
