/**
 * Wire types for the AI task-default admin surface.
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts
 */

/**
 * Fixed task-key registry — the console mirror of `AI_TASK_KEYS` in
 * `packages/applications/src/services/ai-task-default/constants.ts`.
 *
 * This list had drifted to 3 keys while the backend carried 9,
 * so the tenant surface could never show the truth about six of them. Keep the
 * two lists in lockstep — a key added on the backend is invisible here until it
 * is added below.
 */
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
  // TASK-588: the SMR fallback selections are their own tenant-editable keys
  // (opt-in; an unset key means no fallback runs).
  'smr.live.fallback',
  'smr.finalize.fallback',
] as const;
export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * SMR primary selection keys — tenant-editable (TASK-588). The provider/model
 * this tenant uses for the streaming (live) and finalized summaries.
 */
export const SMR_PRIMARY_TASK_KEYS = ['smr.live', 'smr.finalize'] as const;

/**
 * SMR fallback selection keys — tenant-editable, OPTIONAL (TASK-588). Used only
 * when the primary provider fails; an unset key means no fallback runs.
 */
export const SMR_FALLBACK_TASK_KEYS = ['smr.live.fallback', 'smr.finalize.fallback'] as const;

/**
 * Keys shown in the tenant read-only "Effective models" table: everything that
 * stays GLOBAL_ADMIN-only on write (guardrail / nlp / harness). SMR moved to its
 * own tenant-editable "SMR models" section (TASK-588), so it is excluded here.
 */
export const READ_ONLY_TASK_KEYS: readonly AiTaskKey[] = AI_TASK_KEYS.filter((key) => !key.startsWith('smr.'));

/** Reserved SYSTEM tenant owning the platform-default rows. */
export const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

/** Summary of the resolved AiModel registry row backing an effective default. */
export interface AiTaskModelSummary {
  id: string;
  slug: string;
  name: string;
  provider: string | null;
  architecture: string | null;
  taskType: string;
  format: string;
  sourceUri: string;
}

/** GET admin/ai-task-defaults(?taskKey=) — the RESOLVED default for a key. */
export interface EffectiveAiTaskDefault {
  tenantId: string;
  taskKey: string;
  modelSlug: string | null;
  /** Winning cascade tier; null = neither row exists (service env fallback applies). */
  source: 'tenant' | 'system' | null;
  configJson?: Record<string, unknown> | null;
  model: AiTaskModelSummary | null;
}

/** GET admin/ai-task-defaults/row — raw row (`version: 0` placeholder when absent). */
export interface AiTaskDefaultRow {
  tenantId: string;
  taskKey: string;
  modelSlug: string | null;
  configJson?: Record<string, unknown> | null;
  resourceStatus?: string;
  version: number;
  createdAt?: string;
  updatedAt?: string;
}

/** PUT admin/ai-task-defaults/row body — expectedVersion is the OCC token (0 = create). */
export interface UpsertAiTaskDefaultRequest {
  modelSlug: string;
  configJson?: Record<string, unknown>;
  expectedVersion: number;
}

/**
 * GET admin/ai-task-defaults/options rows (gateway ModelResponse subset the
 * pickers need). Tenant-accessible — unlike the global-admin-only
 * /admin/ai-models surface.
 */
export interface TaskModelOption {
  id: string;
  name: string;
  slug: string;
  description?: string | null;
  provider?: string | null;
  architecture?: string | null;
  taskType: string;
  format: string;
  sourceUri: string;
  resourceStatus: string;
}
