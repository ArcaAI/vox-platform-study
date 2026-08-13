/** Harness observability + workflow ops (capabilities-matrix rows 30–31). */

import { getJson, postJson } from '@/shared/api';
import type {
  AuditListParams,
  CreateGoldenCaseBody,
  CreateGoldenSetBody,
  EditBurden,
  EvalRunDetail,
  EvalRunList,
  EvalRunListParams,
  GateEditCorpusExport,
  GateEditExemplarsParams,
  GateQueue,
  GoldenCaseList,
  GoldenCaseListParams,
  GoldenCaseMeta,
  GoldenSet,
  GoldenSetList,
  GoldenSetListParams,
  HarnessAuditList,
  HarnessWorkflowActionResult,
  HarnessWorkflowDetail,
  HarnessWorkflowList,
  LiveSessionStats,
  LiveSessionsList,
  SignalWorkflowBody,
  WorkflowActionBody,
  WorkflowListParams,
} from './types';

const HARNESS = 'admin/harness';

const workflowPath = (workflowId: string) => `${HARNESS}/workflows/${encodeURIComponent(workflowId)}`;

/** Newest-first WORM audit page + the chain-global integrity verdict. */
export function getHarnessAudit(params?: AuditListParams): Promise<HarnessAuditList> {
  return getJson(`${HARNESS}/audit`, params);
}

/** NOTE: `page` is 1-based on this endpoint (unlike the platform's 0-based lists). */
export function listEvalRuns(params?: EvalRunListParams): Promise<EvalRunList> {
  return getJson(`${HARNESS}/eval-runs`, params);
}

export function getEvalRun(evalRunId: string): Promise<EvalRunDetail> {
  return getJson(`${HARNESS}/eval-runs/${encodeURIComponent(evalRunId)}`);
}

// ───────────────── Golden sets (tenant leg) ─────────────────

const goldenSetPath = (goldenSetId: string) => `${HARNESS}/golden-sets/${encodeURIComponent(goldenSetId)}`;

/** Newest-first golden-set page. NOTE: `page` is 1-based (as on eval-runs). */
export function listGoldenSets(params?: GoldenSetListParams): Promise<GoldenSetList> {
  return getJson(`${HARNESS}/golden-sets`, params);
}

export function getGoldenSet(goldenSetId: string): Promise<GoldenSet> {
  return getJson(goldenSetPath(goldenSetId));
}

/**
 * A set's cases — PHI-SAFE METADATA ONLY. The gateway never surfaces the
 * encrypted `transcript`/`referenceNote`, so there is nothing clinical to
 * render from this response.
 */
export function listGoldenCases(goldenSetId: string, params?: GoldenCaseListParams): Promise<GoldenCaseList> {
  return getJson(`${goldenSetPath(goldenSetId)}/cases`, params);
}

/** Requires `manage:HarnessEval` (gateway-enforced). */
export function createGoldenSet(body: CreateGoldenSetBody): Promise<GoldenSet> {
  return postJson(`${HARNESS}/golden-sets`, body);
}

/** Requires `manage:HarnessEval`. PHI in, metadata out — the payload is never echoed. */
export function createGoldenCase(goldenSetId: string, body: CreateGoldenCaseBody): Promise<GoldenCaseMeta> {
  return postJson(`${goldenSetPath(goldenSetId)}/cases`, body);
}

/**
 * Export gate-edit corpus candidates for the "promote to golden case"
 * affordance (/ GAP-A1). Requires `manage:HarnessPolicy` (the
 * gateway gates this GET on `manage`, unusually for a read — the payload is
 * unreviewed clinical-derived proposals, not a plain catalog listing).
 */
export function listGateEditExemplars(params?: GateEditExemplarsParams): Promise<GateEditCorpusExport> {
  return getJson(`${HARNESS}/gate-edit-exemplars`, params);
}

/** Derived edit-burden scalars for ONE consultation. 404 = absent or cross-tenant. */
export function getEditBurden(consultationId: string): Promise<EditBurden> {
  return getJson(`${HARNESS}/edit-burden`, { consultationId });
}

export function getGateQueue(): Promise<GateQueue> {
  return getJson(`${HARNESS}/gate-queue`);
}

/** Temporal visibility list — cursor-paginated via `pageToken`. */
export function listWorkflows(params?: WorkflowListParams): Promise<HarnessWorkflowList> {
  return getJson(`${HARNESS}/workflows`, params);
}

export function getWorkflow(workflowId: string, params?: { phase?: boolean }): Promise<HarnessWorkflowDetail> {
  return getJson(workflowPath(workflowId), params?.phase ? { phase: true } : undefined);
}

export function signalWorkflow(workflowId: string, body: SignalWorkflowBody): Promise<HarnessWorkflowActionResult> {
  return postJson(`${workflowPath(workflowId)}/signal`, body);
}

/** Body is always a JSON object — the gateway's strict ValidationPipe rejects an absent body. */
export function cancelWorkflow(workflowId: string, body: WorkflowActionBody = {}): Promise<HarnessWorkflowActionResult> {
  return postJson(`${workflowPath(workflowId)}/cancel`, body);
}

export function terminateWorkflow(workflowId: string, body: WorkflowActionBody = {}): Promise<HarnessWorkflowActionResult> {
  return postJson(`${workflowPath(workflowId)}/terminate`, body);
}

export function listLiveSessions(): Promise<LiveSessionsList> {
  return getJson(`${HARNESS}/live/sessions`);
}

/** One session's latest PHI-safe stats snapshot (404 when absent or expired). */
export function getLiveSession(consultationId: string): Promise<LiveSessionStats> {
  return getJson(`${HARNESS}/live/sessions/${encodeURIComponent(consultationId)}`);
}
