/**
 * TASK-1050 W3b — consultation details' guardrail plane (README §9.6, §9.7.4–§9.7.6, §9.8.1):
 *
 * | Read / command | Route (W2e) |
 * |---|---|
 * | evaluation grid (keyset, newest first; filters `action` = decision, `direction`, `check`) | `GET admin/consultations/:id/guardrail-evaluations` |
 * | withheld output of an outbound block (PHI, audited; SUPER_ADMIN / TENANT_ADMIN only → 403) | `GET admin/consultations/:id/guardrail-evaluations/:evaluationId/withheld` |
 * | notices + state | `GET consultations/:id/guardrail-notices` |
 * | acknowledge / resume (If-Match on the consultation) | `POST consultations/:id/guardrail-notices/:noticeId/ack`, `POST consultations/:id/guardrail-hold/resume` |
 *
 * Every evaluation row is verdicts and ids only — no content, no judge reasoning. The commands read
 * the consultation version fresh before writing (the activity page carries none).
 */
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { GuardrailHoldResolution } from '@arcaai/types';
import { getJson, getWithEtag, request, versionFromEtag } from '@/shared/api';
import type { GuardrailNoticeWithState } from '@/shared/guardrail/guardrail-notice-list';
import { toGuardrailNotices, type GuardrailNotice } from '@/shared/guardrail/notice';
import { consultationKeys } from './keys';

export interface GuardrailEvaluationItemRef {
  itemId: string;
  itemVersion: number;
}

export interface GuardrailEvaluationCheck {
  checkId: string;
  verdict: 'pass' | 'flag' | 'undetermined' | 'skipped' | string;
  score?: number;
  category?: string;
  confidence?: number;
  actionTaken: 'none' | 'ignore' | 'warn' | 'block' | 'unverified' | string;
  model: string | null;
  latencyMs: number;
  regionKeys: string[];
  items: GuardrailEvaluationItemRef[];
}

/** `GuardrailEvaluationRowResponse` (packages/applications, W2e). */
export interface GuardrailEvaluationRow {
  evaluationId: string;
  at: string;
  requestId: string;
  consultationId: string | null;
  runId: string | null;
  runKey: string | null;
  nodeId: string | null;
  agentSlug: string | null;
  caller: string;
  direction: 'inbound' | 'outbound';
  decision: 'allow' | 'warn' | 'block' | 'unverified';
  exempt: string | null;
  policyVersion: string;
  noticeIds: string[];
  checks: GuardrailEvaluationCheck[];
  hasWithheldContent: boolean;
}

export interface GuardrailEvaluationPage {
  consultationId: string;
  items: GuardrailEvaluationRow[];
  nextCursor: string | null;
  hasMore: boolean;
  limit: number;
}

export interface GuardrailEvaluationParams {
  /** The evaluation's decision (`allow | warn | block | unverified`). */
  action?: string;
  direction?: string;
  check?: string;
  /** W2e round 4: only this run's evaluations (the workflow run id). */
  runId?: string;
  /** W2e round 4: only this run's evaluations (the `AiActivityRun` run key). */
  runKey?: string;
  cursor?: string;
  limit?: number;
}

export interface GuardrailWithheldContent {
  evaluationId: string;
  consultationId: string;
  at: string;
  policyVersion: string;
  noticeIds: string[];
  content: string;
}

const admin = (id: string) => `admin/consultations/${encodeURIComponent(id)}`;
const business = (id: string) => `consultations/${encodeURIComponent(id)}`;

export function listGuardrailEvaluations(consultationId: string, params: GuardrailEvaluationParams = {}): Promise<GuardrailEvaluationPage> {
  return getJson(`${admin(consultationId)}/guardrail-evaluations`, { ...params });
}

export function getWithheldContent(consultationId: string, evaluationId: string): Promise<GuardrailWithheldContent> {
  return getJson(`${admin(consultationId)}/guardrail-evaluations/${encodeURIComponent(evaluationId)}/withheld`);
}

export async function listConsultationGuardrailNotices(consultationId: string): Promise<GuardrailNoticeWithState[]> {
  return toGuardrailNotices<GuardrailNoticeWithState>(await getJson<unknown>(`${business(consultationId)}/guardrail-notices`));
}

async function command<T>(consultationId: string, suffix: string, body: unknown): Promise<T> {
  const { data, etag } = await getWithEtag<{ version?: number }>(business(consultationId));
  const version = etag ? versionFromEtag(etag) : data?.version;
  if (typeof version !== 'number') throw new Error('The consultation version could not be read.');
  return (await request<T>(`${business(consultationId)}/${suffix}`, { method: 'POST', body, etag: `"${version}"` })).data;
}

export function acknowledgeConsultationNotice(consultationId: string, noticeId: string): Promise<unknown> {
  return command(consultationId, `guardrail-notices/${encodeURIComponent(noticeId)}/ack`, {});
}

export function resumeConsultationHold(consultationId: string, resolution: GuardrailHoldResolution): Promise<unknown> {
  return command(consultationId, 'guardrail-hold/resume', { noticeId: resolution.noticeId, resolution: resolution.resolution });
}

/**
 * Warn / block counts per context item: every notice counts once for each item it marks, and an
 * evaluation check that warned or blocked counts for the items it screened — unless that evaluation
 * already raised a notice (which was counted). Feeds the per-item badge on the timeline.
 */
export function guardrailCountsByItem(
  notices: readonly GuardrailNotice[],
  evaluations: readonly GuardrailEvaluationRow[],
): Map<string, { warn: number; block: number }> {
  const counts = new Map<string, { warn: number; block: number }>();
  const bump = (itemId: string, kind: 'warn' | 'block') => {
    const entry = counts.get(itemId) ?? { warn: 0, block: 0 };
    entry[kind] += 1;
    counts.set(itemId, entry);
  };
  const noticed = new Set(notices.map((notice) => notice.noticeId));
  for (const notice of notices) {
    const kind = notice.type === 'guardrail.blocked' ? 'block' : 'warn';
    for (const itemId of notice.itemIds) bump(itemId, kind);
  }
  for (const evaluation of evaluations) {
    if (evaluation.noticeIds.some((id) => noticed.has(id))) continue;
    for (const check of evaluation.checks) {
      const kind = check.actionTaken === 'block' ? 'block' : check.actionTaken === 'warn' ? 'warn' : null;
      if (!kind) continue;
      for (const item of check.items) bump(item.itemId, kind);
    }
  }
  return counts;
}

// ─── hooks ───

export const guardrailKeys = {
  evaluations: (id: string, params: GuardrailEvaluationParams) => [...consultationKeys.root, 'guardrail-evaluations', id, params] as const,
  notices: (id: string) => [...consultationKeys.root, 'guardrail-notices', id] as const,
};

export function useGuardrailEvaluations(consultationId: string, params: GuardrailEvaluationParams = {}, enabled = true) {
  return useQuery({
    queryKey: guardrailKeys.evaluations(consultationId, params),
    queryFn: () => listGuardrailEvaluations(consultationId, params),
    enabled: enabled && !!consultationId,
  });
}

/**
 * The evaluations of specific runs. A run summary's id may be the workflow `runId` or the activity
 * `runKey`, so each id is asked both ways (W2e round 4 filters); the rows are merged by `evaluationId`
 * and filtered here too, so a gateway that ignores the filter (returns the newest page) still yields
 * only those runs' rows.
 */
export function useRunGuardrailEvaluations(consultationId: string, runIds: readonly string[], limit = 100) {
  const queries = useQueries({
    queries: runIds.flatMap((runId) =>
      (['runId', 'runKey'] as const).map((field) => {
        const params: GuardrailEvaluationParams = { [field]: runId, limit };
        return {
          queryKey: guardrailKeys.evaluations(consultationId, params),
          queryFn: () => listGuardrailEvaluations(consultationId, params),
          enabled: !!consultationId,
        };
      }),
    ),
  });
  const wanted = new Set(runIds);
  const seen = new Set<string>();
  const rows: GuardrailEvaluationRow[] = [];
  for (const query of queries) {
    for (const row of query.data?.items ?? []) {
      if (seen.has(row.evaluationId)) continue;
      if (!((row.runId && wanted.has(row.runId)) || (row.runKey && wanted.has(row.runKey)))) continue;
      seen.add(row.evaluationId);
      rows.push(row);
    }
  }
  return {
    rows,
    isPending: queries.length > 0 && queries.some((query) => query.isPending),
    isError: queries.length > 0 && queries.every((query) => query.isError),
  };
}

export function useConsultationGuardrailNotices(consultationId: string, enabled = true) {
  return useQuery({
    queryKey: guardrailKeys.notices(consultationId),
    queryFn: () => listConsultationGuardrailNotices(consultationId),
    enabled: enabled && !!consultationId,
    retry: false,
  });
}

function useInvalidateGuardrail() {
  const queryClient = useQueryClient();
  return () => void queryClient.invalidateQueries({ queryKey: consultationKeys.root });
}

export function useAcknowledgeConsultationNotice(consultationId: string) {
  const invalidate = useInvalidateGuardrail();
  return useMutation({ mutationFn: (noticeId: string) => acknowledgeConsultationNotice(consultationId, noticeId), onSettled: invalidate });
}

export function useResumeConsultationHold(consultationId: string) {
  const invalidate = useInvalidateGuardrail();
  return useMutation({
    mutationFn: (resolution: GuardrailHoldResolution) => resumeConsultationHold(consultationId, resolution),
    onSettled: invalidate,
  });
}

/** An audited PHI read, fetched only when the admin asks for it. */
export function useWithheldContent(consultationId: string) {
  return useMutation({ mutationFn: (evaluationId: string) => getWithheldContent(consultationId, evaluationId) });
}
