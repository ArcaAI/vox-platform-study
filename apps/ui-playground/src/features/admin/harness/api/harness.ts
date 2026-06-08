import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryOptions, type UseQueryResult } from '@tanstack/react-query';
import { adminClient, type RequestOptions } from '../../api/admin-client';

// ---------------------------------------------------------------------------
// Types — TASK-330 Phase 6 (Harness Administration & Observability).
//
// These mirror the JSON wire shapes of the backend DTOs that live in
// `@arcaai/applications` (`HarnessPolicyResponse`, `HarnessAuditListResponse`,
// `EvalRunListResponse`, `GateQueueResponse`, …) and the workflow-ops contracts
// owned by `apps/api` (`HarnessWorkflowSummary/Detail/ActionResult/ListResult`).
//
// They are re-declared locally because `@arcaai/applications` is a server-only
// NestJS package (it imports Prisma/Redis/`@nestjs/*`) that ui-playground does
// not — and cannot — depend on. Keep these in lock-step with the backend DTOs.
// ---------------------------------------------------------------------------

/** Free-form JSON value (the backend DTOs type these as `JsonValue`). */
export type JsonValue = unknown;

/** Where the effective policy was resolved from. */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/** The effective harness policy (`GET /admin/harness/policy`). */
export interface HarnessPolicyResponse {
  id: string | null;
  tenantId: string;
  source: HarnessPolicySource;
  entityFaithfulnessThreshold: number;
  coverageThreshold: number;
  citationPresenceThreshold: number;
  numericDoseThreshold: number;
  groundednessThreshold: number;
  safetyEnabled: boolean;
  phiEnabled: boolean;
  phiFailClosed: boolean;
  safetyProvider: string;
  safetyModel: string;
  smrProvider: string | null;
  smrModel: string | null;
  maxRegen: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  toolAllowlist: string[] | null;
  updatedAt: string | null;
  /** Row `_version` for OCC; echo as `If-Match: "<version>"` on PATCH. */
  version: number;
}

/** Sparse PATCH body for `/admin/harness/policy[/global]`. */
export interface UpdateHarnessPolicyRequest {
  entityFaithfulnessThreshold?: number;
  coverageThreshold?: number;
  citationPresenceThreshold?: number;
  numericDoseThreshold?: number;
  groundednessThreshold?: number;
  safetyEnabled?: boolean;
  phiEnabled?: boolean;
  phiFailClosed?: boolean;
  safetyProvider?: string;
  safetyModel?: string;
  smrProvider?: string | null;
  smrModel?: string | null;
  maxRegen?: number;
  gateSlaSeconds?: number;
  gateEscalationSeconds?: number;
  toolAllowlist?: string[] | null;
  reason?: string;
  /** OCC fallback for service-to-service callers; the UI uses the `If-Match` header. */
  expectedVersion?: number;
}

/** One WORM audit row (read projection of `HarnessAuditEvent`). */
export interface HarnessAuditEventResponse {
  id: string;
  tenantId: string;
  consultationId: string;
  contextItemVersionId: string | null;
  action: string;
  modelName: string;
  modelVersion: string;
  promptTemplateId: string | null;
  promptVersion: string | null;
  sensorScores: JsonValue;
  citations: JsonValue;
  gateDecision: string | null;
  clinicianId: string | null;
  attestationHash: string | null;
  prevHash: string;
  hash: string;
  createdAt: string;
  createdBy: string | null;
}

/** Hash-chain verification verdict for the tenant's full audit chain. */
export interface HarnessAuditVerificationResponse {
  valid: boolean;
  brokenAtIndex: number | null;
  reason?: string | null;
}

/** Paginated audit listing (`GET /admin/harness/audit`). */
export interface HarnessAuditListResponse {
  items: HarnessAuditEventResponse[];
  total: number;
  verification: HarnessAuditVerificationResponse;
}

/** One eval run (read projection of `EvalRun`). */
export interface EvalRunResponse {
  id: string;
  tenantId: string;
  goldenSetId: string;
  modelName: string;
  modelVersion: string | null;
  promptTemplateId: string | null;
  promptVersion: string | null;
  judgeModel: string | null;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  aggregateScores: JsonValue | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One per-case metric score within an eval run (read projection of `EvalScore`). */
export interface EvalScoreResponse {
  id: string;
  tenantId: string;
  evalRunId: string;
  goldenCaseId: string;
  metric: string;
  score: number;
  maxScore: number | null;
  rationale: string | null;
  judgeModel: string | null;
  details: JsonValue | null;
  createdAt: string;
}

/** An eval run with its per-case scores (`GET /admin/harness/eval-runs/:id`). */
export interface EvalRunDetailResponse extends EvalRunResponse {
  scores: EvalScoreResponse[];
}

/** Paginated eval-run listing (`GET /admin/harness/eval-runs`). */
export interface EvalRunListResponse {
  items: EvalRunResponse[];
  total: number;
}

/** One consultation awaiting clinician review (gate queue item). */
export interface GateQueueItemResponse {
  consultationId: string;
  status: string;
  pendingSince: string;
  ageSeconds: number;
  generateCount: number;
  regenCount: number;
  slaDueAt: string;
  escalationDueAt: string;
  slaBreached: boolean;
  escalated: boolean;
}

/** The gate queue for a tenant + the policy timers used to compute deadlines. */
export interface GateQueueResponse {
  items: GateQueueItemResponse[];
  total: number;
  slaBreachedCount: number;
  escalatedCount: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  policySource: HarnessPolicySource;
}

// --- Workflow ops (contracts owned by apps/api `HarnessOpsClient`) ----------

/** A Temporal workflow summary as projected by the harness admin surface. */
export interface HarnessWorkflowSummary {
  workflowId: string;
  runId: string | null;
  consultationId: string | null;
  tenantId: string | null;
  status: string;
  phase: string | null;
  startedAt: string | null;
  closeTime: string | null;
  regenCount: number | null;
  escalations: number | null;
  slaSeconds: number | null;
}

/** A single workflow's full description (`?phase=true` adds the loop phase). */
export interface HarnessWorkflowDetail extends HarnessWorkflowSummary {
  historyLength: number | null;
  pendingActivities: unknown[] | null;
  memo: Record<string, unknown> | null;
  searchAttributes: Record<string, unknown> | null;
  result: unknown | null;
}

/** The harness acknowledgement of a cancel / terminate / signal request. */
export interface HarnessWorkflowActionResult {
  workflowId: string;
  runId: string | null;
  status: string;
  action: 'cancel' | 'terminate' | 'signal';
  requested: boolean;
}

/** A page of workflow summaries (Temporal `list_workflows` is cursor-paginated). */
export interface HarnessWorkflowListResult {
  items: HarnessWorkflowSummary[];
  nextPageToken: string | null;
}

export interface WorkflowActionRequest {
  reason?: string;
}

export interface SignalWorkflowRequest {
  signalName: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Request param shapes
// ---------------------------------------------------------------------------

export interface AuditListParams {
  tenantId?: string;
  consultationId?: string;
  /** A single `HarnessAuditAction` (e.g. `GATE_DECISION`); server-side filter. */
  action?: string;
  /** Inclusive lower bound on `createdAt` (ISO-8601 instant); server-side filter. */
  from?: string;
  /** Inclusive upper bound on `createdAt` (ISO-8601 instant); server-side filter. */
  to?: string;
  limit?: number;
  offset?: number;
}

export interface EvalRunListParams {
  tenantId?: string;
  goldenSetId?: string;
  page?: number;
  limit?: number;
}

export interface WorkflowListParams {
  tenantId?: string;
  status?: string;
  consultationId?: string;
  limit?: number;
  pageToken?: string;
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const BASE = '/admin/harness';

/** Build a `?a=1&b=2` suffix, dropping `undefined` / empty values. */
function qs(params: Record<string, string | number | undefined | null>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const str = search.toString();
  return str ? `?${str}` : '';
}

/** `RequestOptions` carrying the selected tenant only when one is set. */
function tenantOpts(tenantId?: string): RequestOptions | undefined {
  return tenantId ? { tenantId } : undefined;
}

// ---------------------------------------------------------------------------
// Query keys
// ---------------------------------------------------------------------------

export const harnessKeys = {
  all: ['admin', 'harness'] as const,
  policy: (tenantId?: string) => [...harnessKeys.all, 'policy', tenantId ?? null] as const,
  globalPolicy: () => [...harnessKeys.all, 'policy', 'global'] as const,
  audit: (params: AuditListParams) => [...harnessKeys.all, 'audit', params] as const,
  evalRuns: (params: EvalRunListParams) => [...harnessKeys.all, 'eval-runs', params] as const,
  evalRun: (id: string, tenantId?: string) => [...harnessKeys.all, 'eval-run', id, tenantId ?? null] as const,
  gateQueue: (tenantId?: string) => [...harnessKeys.all, 'gate-queue', tenantId ?? null] as const,
  workflows: (params: WorkflowListParams) => [...harnessKeys.all, 'workflows', params] as const,
  workflow: (id: string, phase: boolean, tenantId?: string) => [...harnessKeys.all, 'workflow', id, phase, tenantId ?? null] as const,
};

// ---------------------------------------------------------------------------
// Raw client functions (thin wrappers over adminClient)
// ---------------------------------------------------------------------------

export const harnessApi = {
  getPolicy: (tenantId?: string) => adminClient.get<HarnessPolicyResponse>(`${BASE}/policy`, tenantOpts(tenantId)),

  updatePolicy: (body: UpdateHarnessPolicyRequest, version: number, tenantId?: string) =>
    adminClient.patch<HarnessPolicyResponse>(`${BASE}/policy`, body, { ...tenantOpts(tenantId), ifMatch: `"${version}"` }),

  getGlobalPolicy: () => adminClient.get<HarnessPolicyResponse>(`${BASE}/policy/global`),

  updateGlobalPolicy: (body: UpdateHarnessPolicyRequest, version: number) =>
    adminClient.patch<HarnessPolicyResponse>(`${BASE}/policy/global`, body, { ifMatch: `"${version}"` }),

  listAudit: (params: AuditListParams) =>
    adminClient.get<HarnessAuditListResponse>(
      `${BASE}/audit${qs({
        consultationId: params.consultationId,
        action: params.action,
        from: params.from,
        to: params.to,
        limit: params.limit,
        offset: params.offset,
      })}`,
      tenantOpts(params.tenantId),
    ),

  listEvalRuns: (params: EvalRunListParams) =>
    adminClient.get<EvalRunListResponse>(
      `${BASE}/eval-runs${qs({ goldenSetId: params.goldenSetId, page: params.page, limit: params.limit })}`,
      tenantOpts(params.tenantId),
    ),

  getEvalRun: (id: string, tenantId?: string) =>
    adminClient.get<EvalRunDetailResponse>(`${BASE}/eval-runs/${encodeURIComponent(id)}`, tenantOpts(tenantId)),

  getGateQueue: (tenantId?: string) => adminClient.get<GateQueueResponse>(`${BASE}/gate-queue`, tenantOpts(tenantId)),

  listWorkflows: (params: WorkflowListParams) =>
    adminClient.get<HarnessWorkflowListResult>(
      `${BASE}/workflows${qs({ status: params.status, consultationId: params.consultationId, limit: params.limit, pageToken: params.pageToken })}`,
      tenantOpts(params.tenantId),
    ),

  getWorkflow: (id: string, phase = false, tenantId?: string) =>
    adminClient.get<HarnessWorkflowDetail>(
      `${BASE}/workflows/${encodeURIComponent(id)}${qs({ phase: phase ? 'true' : undefined })}`,
      tenantOpts(tenantId),
    ),

  cancelWorkflow: (id: string, body: WorkflowActionRequest, tenantId?: string) =>
    adminClient.post<HarnessWorkflowActionResult>(`${BASE}/workflows/${encodeURIComponent(id)}/cancel`, body, tenantOpts(tenantId)),

  terminateWorkflow: (id: string, body: WorkflowActionRequest, tenantId?: string) =>
    adminClient.post<HarnessWorkflowActionResult>(`${BASE}/workflows/${encodeURIComponent(id)}/terminate`, body, tenantOpts(tenantId)),

  signalWorkflow: (id: string, body: SignalWorkflowRequest, tenantId?: string) =>
    adminClient.post<HarnessWorkflowActionResult>(`${BASE}/workflows/${encodeURIComponent(id)}/signal`, body, tenantOpts(tenantId)),
};

// ---------------------------------------------------------------------------
// Query hooks
// ---------------------------------------------------------------------------

type QueryOpts<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>;

/**
 * React Query v5 removed the per-`useQuery` `onError` callback. `QueryWithError`
 * restores an opt-in `onError` for the observability hooks so the Overview /
 * Audit / Evals pages can `toast.error` on a failed fetch (in addition to the
 * inline error state). It fires once per distinct error, not on every render.
 */
type QueryWithError<T> = QueryOpts<T> & { onError?: (error: unknown) => void };

function useOnQueryError<T>(query: UseQueryResult<T>, onError?: (error: unknown) => void): void {
  const callbackRef = useRef(onError);
  callbackRef.current = onError;
  const { isError, error } = query;
  useEffect(() => {
    if (isError) callbackRef.current?.(error);
  }, [isError, error]);
}

export function useHarnessPolicy(tenantId?: string, options?: QueryOpts<HarnessPolicyResponse>) {
  return useQuery({
    queryKey: harnessKeys.policy(tenantId),
    queryFn: () => harnessApi.getPolicy(tenantId),
    ...options,
  });
}

export function useGlobalHarnessPolicy(options?: QueryOpts<HarnessPolicyResponse>) {
  return useQuery({
    queryKey: harnessKeys.globalPolicy(),
    queryFn: () => harnessApi.getGlobalPolicy(),
    ...options,
  });
}

export function useHarnessAudit(params: AuditListParams, options?: QueryWithError<HarnessAuditListResponse>) {
  const { onError, ...queryOptions } = options ?? {};
  const query = useQuery({
    queryKey: harnessKeys.audit(params),
    queryFn: () => harnessApi.listAudit(params),
    ...queryOptions,
  });
  useOnQueryError(query, onError);
  return query;
}

export function useHarnessEvalRuns(params: EvalRunListParams, options?: QueryWithError<EvalRunListResponse>) {
  const { onError, ...queryOptions } = options ?? {};
  const query = useQuery({
    queryKey: harnessKeys.evalRuns(params),
    queryFn: () => harnessApi.listEvalRuns(params),
    ...queryOptions,
  });
  useOnQueryError(query, onError);
  return query;
}

export function useHarnessEvalRun(id: string | undefined, tenantId?: string, options?: QueryOpts<EvalRunDetailResponse>) {
  return useQuery({
    queryKey: harnessKeys.evalRun(id ?? '', tenantId),
    queryFn: () => harnessApi.getEvalRun(id as string, tenantId),
    enabled: !!id,
    ...options,
  });
}

export function useHarnessGateQueue(tenantId?: string, options?: QueryWithError<GateQueueResponse>) {
  const { onError, ...queryOptions } = options ?? {};
  const query = useQuery({
    queryKey: harnessKeys.gateQueue(tenantId),
    queryFn: () => harnessApi.getGateQueue(tenantId),
    ...queryOptions,
  });
  useOnQueryError(query, onError);
  return query;
}

export function useHarnessWorkflows(params: WorkflowListParams, options?: QueryOpts<HarnessWorkflowListResult>) {
  return useQuery({
    queryKey: harnessKeys.workflows(params),
    queryFn: () => harnessApi.listWorkflows(params),
    ...options,
  });
}

export function useHarnessWorkflow(id: string | undefined, phase = false, tenantId?: string, options?: QueryOpts<HarnessWorkflowDetail>) {
  return useQuery({
    queryKey: harnessKeys.workflow(id ?? '', phase, tenantId),
    queryFn: () => harnessApi.getWorkflow(id as string, phase, tenantId),
    enabled: !!id,
    ...options,
  });
}

// ---------------------------------------------------------------------------
// Mutation hooks
// ---------------------------------------------------------------------------

export interface UpdatePolicyVars {
  body: UpdateHarnessPolicyRequest;
  version: number;
  tenantId?: string;
}

export function useUpdateHarnessPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, version, tenantId }: UpdatePolicyVars) => harnessApi.updatePolicy(body, version, tenantId),
    onSuccess: (data, { tenantId }) => qc.setQueryData(harnessKeys.policy(tenantId), data),
  });
}

export function useUpdateGlobalHarnessPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ body, version }: Omit<UpdatePolicyVars, 'tenantId'>) => harnessApi.updateGlobalPolicy(body, version),
    onSuccess: (data) => qc.setQueryData(harnessKeys.globalPolicy(), data),
  });
}

export interface WorkflowActionVars {
  workflowId: string;
  reason?: string;
  tenantId?: string;
}

export function useCancelWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, reason, tenantId }: WorkflowActionVars) => harnessApi.cancelWorkflow(workflowId, { reason }, tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: harnessKeys.all }),
  });
}

export function useTerminateWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, reason, tenantId }: WorkflowActionVars) => harnessApi.terminateWorkflow(workflowId, { reason }, tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: harnessKeys.all }),
  });
}

export interface SignalWorkflowVars {
  workflowId: string;
  signalName: string;
  payload?: Record<string, unknown>;
  tenantId?: string;
}

export function useSignalWorkflow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ workflowId, signalName, payload, tenantId }: SignalWorkflowVars) =>
      harnessApi.signalWorkflow(workflowId, { signalName, payload }, tenantId),
    onSuccess: () => qc.invalidateQueries({ queryKey: harnessKeys.all }),
  });
}
