/**
 * Wire types for the AI task-default admin surface (TASK-506 Phase 6).
 * Hand-declared to mirror the gateway DTOs — no server import (BFF boundary).
 * Source: apps/api/src/modules/ai-task-default/ai-task-default-admin.controller.ts
 */

/** Fixed task-key registry (mirrors AI_TASK_KEYS in @arcaai/applications). */
export const AI_TASK_KEYS = ['guardrail.validate', 'nlp.ner', 'nlp.classification'] as const;
export type AiTaskKey = (typeof AI_TASK_KEYS)[number];

/**
 * The tenant-editable subset. `guardrail.validate` is GLOBAL-ADMIN-ONLY
 * (owner directive 2026-07-17): the gateway 403s tenant-admin writes, and the
 * tenant screen must not render it at all — not even read-only.
 */
export const NLP_TASK_KEYS = ['nlp.ner', 'nlp.classification'] as const satisfies readonly AiTaskKey[];

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
