/**
 * The AI task-key registry — the console mirror of `AI_TASK_KEYS` in
 * `packages/applications/src/services/ai-task-default/constants.ts`.
 *
 * It lives in `shared/catalog` rather than in one feature because TASK-845
 * gave it a SECOND reader: the unified AI-platform screen resolves routing
 * policies per task key, alongside the task-default surface that declared it
 * first. Rule 13 forbids one feature importing another, and `document-templates.ts`
 * next door records the usual answer to that — a minimal copy. A copy is the
 * wrong answer HERE: this list has already drifted from the backend three times,
 * and `features/ai-task-defaults/api/__tests__/ai-task-keys-lockstep.test.ts`
 * exists precisely because a comment saying "keep these in step" did not hold.
 * Two console copies would need two guards. So the registry is DECLARED once
 * here and re-exported by the feature that used to own it; the lockstep guard
 * reaches it through that re-export and keeps working unchanged.
 *
 * Hand-declared with no server import — the BFF boundary stands, and
 * `@arcaai/applications` is not a dependency of this app.
 */

export const AI_TASK_KEYS = [
  'guardrail.validate',
  'guardrail.safety',
  'guardrail.groundedness',
  // TASK-799 R6: the platform's PII redaction selections. SUPER_ADMIN-only on
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
