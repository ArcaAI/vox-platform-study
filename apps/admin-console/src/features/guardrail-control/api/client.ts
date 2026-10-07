/**
 * `admin/guardrail/*` through the BFF proxy (TASK-1050 W3c). Every write that the gateway guards with
 * `@RequiresIfMatch()` sends the model-row (or policy-row) version as a strong `If-Match` AND as the body
 * `expectedVersion`; the header wins server-side.
 */

import { getJson, postJson, putJson, putWithEtag, type QueryParams } from '@/shared/api';
import type {
  GuardrailActivity,
  GuardrailAvailabilityRow,
  GuardrailCatalogueEntry,
  GuardrailDryRunRequest,
  GuardrailDryRunResult,
  GuardrailEvaluationPage,
  GuardrailEvaluationQuery,
  GuardrailHealth,
  GuardrailJudgeCategoryTarget,
  GuardrailJudgeLanes,
  GuardrailJudgeMeta,
  GuardrailLaneResetResult,
  GuardrailMetricsWindow,
  GuardrailModelServingSummary,
  GuardrailPerformance,
  GuardrailPolicyKeys,
  GuardrailPolicyKeyWriteResult,
  GuardrailPolicyRevisions,
  GuardrailStoredPolicy,
} from './types';

const AVAILABILITY = 'admin/guardrail/availability';
const POLICY_KEYS = 'admin/guardrail/policy-keys';
const JUDGE_MODELS = 'admin/guardrail/judge-models';
const METRICS = 'admin/guardrail/metrics';

const enc = encodeURIComponent;
const ifMatch = (version: number) => `"${version}"`;

/** The `labelTaxonomy.*` classifier thresholds live on several model rows: every single-key route needs `?taskKey=`. */
export const LABEL_THRESHOLD_PREFIX = 'labelTaxonomy.';

/** `?taskKey=` for a label threshold (its row), nothing for a catalogue key. */
export function policyKeyTaskKey(entry: { key: string; taskKey: string }): string | undefined {
  return entry.key.startsWith(LABEL_THRESHOLD_PREFIX) ? entry.taskKey : undefined;
}

const taskKeyQuery = (taskKey?: string) => (taskKey ? `?taskKey=${enc(taskKey)}` : '');

// ── Rules ────────────────────────────────────────────────────────────────────

export function getGuardrailCatalogue(): Promise<GuardrailCatalogueEntry[]> {
  return getJson(`${AVAILABILITY}/catalogue`);
}

export function getGuardrailAvailability(tenantId: string): Promise<GuardrailAvailabilityRow> {
  return getJson(`${AVAILABILITY}/${enc(tenantId)}`);
}

/** Whole-row OCC write of the v2 policy (`version: 0` creates the row). */
export async function putGuardrailAvailability(
  tenantId: string,
  policies: GuardrailStoredPolicy | Record<string, never>,
  version: number,
): Promise<GuardrailAvailabilityRow> {
  const response = await putWithEtag<GuardrailAvailabilityRow>(
    `${AVAILABILITY}/${enc(tenantId)}`,
    { policies, expectedVersion: version },
    ifMatch(version),
  );
  return response.data;
}

// ── Policy keys ──────────────────────────────────────────────────────────────

export function listGuardrailPolicyKeys(): Promise<GuardrailPolicyKeys> {
  return getJson(POLICY_KEYS);
}

export async function updateGuardrailPolicyKey(
  key: string,
  value: unknown,
  modelVersion: number,
  taskKey?: string,
): Promise<GuardrailPolicyKeyWriteResult> {
  const response = await putWithEtag<GuardrailPolicyKeyWriteResult>(
    `${POLICY_KEYS}/${enc(key)}${taskKeyQuery(taskKey)}`,
    { value, expectedVersion: modelVersion },
    ifMatch(modelVersion),
  );
  return response.data;
}

export function resetGuardrailPolicyKey(key: string, taskKey?: string): Promise<GuardrailPolicyKeyWriteResult> {
  return postJson(`${POLICY_KEYS}/${enc(key)}/reset${taskKeyQuery(taskKey)}`);
}

export function resetGuardrailPolicyLane(lane: string): Promise<GuardrailLaneResetResult> {
  return postJson(`${POLICY_KEYS}/reset`, undefined, { lane });
}

export function listGuardrailPolicyRevisions(key: string, limit = 50, taskKey?: string): Promise<GuardrailPolicyRevisions> {
  return getJson(`${POLICY_KEYS}/${enc(key)}/revisions`, { limit, taskKey });
}

export function restoreGuardrailPolicyRevision(key: string, revisionId: string, taskKey?: string): Promise<GuardrailPolicyKeyWriteResult> {
  return postJson(`${POLICY_KEYS}/${enc(key)}/revisions/${enc(revisionId)}/restore${taskKeyQuery(taskKey)}`);
}

// ── Judge models ─────────────────────────────────────────────────────────────

/** `GET …/judge-meta` (W2h round 3): the current `_metadata.judge`, its seed default and `defaultChangedSinceEdit`. */
export function getGuardrailJudgeMeta(modelId: string): Promise<GuardrailJudgeMeta> {
  return getJson(`${JUDGE_MODELS}/${enc(modelId)}/judge-meta`);
}

export async function updateGuardrailJudgeMeta(
  modelId: string,
  body: { categoryMap?: Record<string, GuardrailJudgeCategoryTarget>; tiers?: Record<string, string> },
  version: number,
): Promise<GuardrailJudgeMeta> {
  const response = await putWithEtag<GuardrailJudgeMeta>(
    `${JUDGE_MODELS}/${enc(modelId)}/judge-meta`,
    { ...body, expectedVersion: version },
    ifMatch(version),
  );
  return response.data;
}

export function resetGuardrailJudgeMeta(modelId: string): Promise<GuardrailJudgeMeta> {
  return postJson(`${JUDGE_MODELS}/${enc(modelId)}/judge-meta/reset`);
}

export function getGuardrailJudgeLanes(): Promise<GuardrailJudgeLanes> {
  return getJson('admin/guardrail/judge-lanes');
}

export function updateGuardrailJudgeLanes(selections: { lane: string; modelId: string }[]): Promise<GuardrailJudgeLanes> {
  return putJson('admin/guardrail/judge-lanes', { selections });
}

/** Read-only serving summary of a judge model (the registry, `/ai-models`, edits it). */
export function getGuardrailModelSummary(modelId: string): Promise<GuardrailModelServingSummary | null> {
  return getJson(`admin/ai-models/${enc(modelId)}`);
}

export function runGuardrailDryRun(body: GuardrailDryRunRequest): Promise<GuardrailDryRunResult> {
  return postJson('admin/guardrail/dry-run', body);
}

// ── Monitoring ───────────────────────────────────────────────────────────────

function windowParams(window: GuardrailMetricsWindow): QueryParams {
  return { from: window.from, to: window.to, bucket: window.bucket, tenantId: window.tenantId || undefined };
}

export function getGuardrailActivity(window: GuardrailMetricsWindow): Promise<GuardrailActivity> {
  return getJson(`${METRICS}/activity`, windowParams(window));
}

export function getGuardrailPerformance(): Promise<GuardrailPerformance> {
  return getJson(`${METRICS}/performance`);
}

export function getGuardrailHealth(): Promise<GuardrailHealth> {
  return getJson(`${METRICS}/health`);
}

export function listGuardrailEvaluations(query: GuardrailEvaluationQuery): Promise<GuardrailEvaluationPage> {
  return getJson(`${METRICS}/evaluations`, {
    ...windowParams(query),
    decision: query.decision || undefined,
    direction: query.direction || undefined,
    checkId: query.checkId || undefined,
    consultationId: query.consultationId || undefined,
    cursor: query.cursor,
    limit: query.limit,
  });
}
