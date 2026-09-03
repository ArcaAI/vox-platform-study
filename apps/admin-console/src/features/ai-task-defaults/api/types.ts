/**
 * Wire types for the AI task-default admin surface.
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts
 */

import { AI_TASK_KEYS, isTenantEditableTaskKey, taskKeyService, type AiTaskKey } from '@/shared/catalog/ai-task-keys';

/**
 * Fixed task-key registry — MOVED to `@/shared/catalog/ai-task-keys` by
 * and re-exported here so this feature's public surface is unchanged.
 *
 * It moved because the unified AI-platform screen became a second reader, and
 * rule 13 forbids one feature importing another. The usual answer to that is a
 * minimal copy; a copy is wrong for THIS list, which has drifted from the
 * backend three times and is the reason `__tests__/ai-task-keys-lockstep.test.ts`
 * exists — two copies would need two guards. One declaration, one guard, and
 * that guard still reads the list through this re-export.
 */
export { AI_TASK_KEYS, isTenantEditableTaskKey, taskKeyService, type AiTaskKey };

/**
 * Text-generation primary selection keys — tenant-editable. The provider/model
 * this tenant uses for the streaming (live) and finalized summaries.
 */
export const TEXT_PRIMARY_TASK_KEYS = ['text.live', 'text.finalize'] as const;

/**
 * The prompt-template test-bench selection — tenant-editable, and its own
 * concern (authoring, not clinical documentation), so it is rendered apart from
 * the summarization keys rather than folded into them.
 *
 * this key was seeded and backend-live but had NO console surface
 * at all, while `resolveTestTextTarget` is fail-CLOSED — so an unconfigured
 * tenant got a `BadRequestException` for a value it had no way to set.
 */
export const TEXT_TEST_TASK_KEYS = ['text.test'] as const;

/**
 * Text-generation fallback selection keys — tenant-editable, OPTIONAL. Used only
 * when the primary provider fails; an unset key means no fallback runs.
 */
export const TEXT_FALLBACK_TASK_KEYS = ['text.live.fallback', 'text.finalize.fallback'] as const;

/**
 * Keys shown in the tenant read-only "Effective models" table: everything that
 * stays SUPER_ADMIN-only on write (guardrail / nlp / harness). Text generation
 * moved to its own tenant-editable "Text models" section, so it is excluded here.
 */
export const READ_ONLY_TASK_KEYS: readonly AiTaskKey[] = AI_TASK_KEYS.filter((key) => !key.startsWith('text.'));

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
 * pickers need). Tenant-accessible — unlike the super-admin-only
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
