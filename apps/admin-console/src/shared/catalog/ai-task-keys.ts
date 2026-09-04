/**
 * The AI task-key registry — the console mirror of `AI_TASK_KEYS` in
 * `packages/applications/src/services/ai-task-default/constants.ts`.
 *
 * It lives in `shared/catalog` because more than one feature reads it. This
 * list has already drifted from the backend three times, and
 * `shared/catalog/__tests__/ai-task-keys-lockstep.test.ts` exists precisely
 * because a comment saying "keep these in step" did not hold — the guard parses
 * the backend constants file and fails on any difference. (TASK-862 deleted
 * `features/ai-task-defaults`, the feature that used to re-export this; the
 * registry is declared once, here.)
 *
 * Hand-declared with no server import — the BFF boundary stands, and
 * `@arcaai/applications` is not a dependency of this app.
 */

export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  // the platform's PII redaction selections. SUPER_ADMIN-only on
  // write, so they are read-only wherever a tenant can see them.
  'guardrail.pii',
  'guardrail.pii.spans',
  'nlp.ner',
  'nlp.classification',
  'nlp.diagnosis',
  'nlp.sentiment',
  'nlp.toxicity',
  'text.live',
  'text.finalize',
  'text.test',
  'harness.judge',
  'vlm.extract',
  // The text-generation fallback selections are their own tenant-editable keys
  // (opt-in; an unset key means no fallback runs).
  'text.live.fallback',
  'text.finalize.fallback',
] as const;

export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * The owning service a task key routes to, derived from its prefix. Groups the
 * Tasks tab, and decides which keys a tenant may edit at all.
 */
export function taskKeyService(taskKey: string): string {
  return taskKey.split('.')[0] ?? taskKey;
}

/**
 * Whether a task key's SELECTION is editable by a tenant admin. Only `text.*`
 * is tenant-owned today — guardrail / nlp / harness / vlm selection stays
 * SUPER_ADMIN-only on write (`SUPER_ADMIN_ONLY_TASK_PREFIXES` on the backend),
 * so the console renders those read-only rather than offering a control the
 * gateway will refuse.
 */
export function isTenantEditableTaskKey(taskKey: string): boolean {
  return taskKey.startsWith('text.');
}
