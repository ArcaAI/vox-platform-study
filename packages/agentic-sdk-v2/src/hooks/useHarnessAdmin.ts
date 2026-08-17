/**
 * @arcaai/vox - useHarnessAdmin Hook
 *
 * Read-only admin surface for the Clinical Documentation Harness
 * (`/admin/harness/*`). Policy / audit / eval-runs / gate-queue are
 * database-backed and work regardless of the harness service state;
 * `listWorkflows` proxies the harness Temporal client and the server returns
 * 503 when the harness service (`:8866`) is down — callers must catch and
 * degrade honestly (em-dash / unavailable card).
 *
 * Tenant scoping mirrors the server posture: tenant admins are pinned to
 * their CLS tenant; super-admins act cross-tenant via the `X-Tenant-Id`
 * header the SDK already sends.
 */

import { useCallback } from 'react';
import { useApiOperation } from './useApiOperation';
import { HARNESS_ADMIN_ENDPOINTS } from '../core/constants';
import { appendFilters } from '../utils/urlUtils';

/** Where the effective policy was resolved from. */
export type HarnessPolicySource = 'tenant' | 'system-default' | 'code-default';

/** The effective harness policy (index signature lets unmapped knobs pass through). */
export interface HarnessPolicy {
  id: string | null;
  tenantId: string;
  source: HarnessPolicySource;
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
  updatedAt?: string | null;
  version: number;
  [key: string]: unknown;
}

/** One WORM audit row. */
export interface HarnessAuditEvent {
  id: string;
  tenantId: string;
  consultationId: string;
  action: string;
  modelName: string;
  modelVersion: string;
  gateDecision?: string | null;
  clinicianId?: string | null;
  prevHash: string;
  hash: string;
  createdAt: string;
  [key: string]: unknown;
}

export interface HarnessAuditList {
  items: HarnessAuditEvent[];
  total: number;
  verification: { valid: boolean; brokenAtIndex: number | null; reason?: string | null };
}

/** One eval run (list projection). */
export interface HarnessEvalRun {
  id: string;
  tenantId: string;
  goldenSetId: string;
  modelName: string;
  modelVersion?: string | null;
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  aggregateScores?: unknown;
  createdAt: string;
  [key: string]: unknown;
}

export interface HarnessEvalRunList {
  items: HarnessEvalRun[];
  total: number;
}

/** Eval run detail = run + per-case metric scores. */
export interface HarnessEvalRunDetail extends HarnessEvalRun {
  scores: Array<{ id: string; goldenCaseId: string; metric: string; score: number; maxScore?: number | null; [key: string]: unknown }>;
}

/** One consultation awaiting clinician review. */
export interface HarnessGateQueueItem {
  consultationId: string;
  status: string;
  pendingSince: string;
  ageSeconds: number;
  slaDueAt: string;
  escalationDueAt: string;
  slaBreached: boolean;
  escalated: boolean;
  [key: string]: unknown;
}

export interface HarnessGateQueue {
  items: HarnessGateQueueItem[];
  total: number;
  slaBreachedCount: number;
  escalatedCount: number;
  gateSlaSeconds: number;
  gateEscalationSeconds: number;
  policySource: HarnessPolicySource;
}

/** One Temporal document workflow (server returns 503 when the harness is down). */
export interface HarnessWorkflow {
  workflowId: string;
  runId: string | null;
  consultationId: string | null;
  tenantId: string | null;
  status: string;
  phase?: string | null;
  startedAt?: string | null;
  closeTime?: string | null;
  [key: string]: unknown;
}

export interface HarnessWorkflowList {
  items: HarnessWorkflow[];
  nextPageToken: string | null;
}

export interface UseHarnessAdminReturn {
  isLoading: boolean;
  error: Error | null;
  /** Effective policy for the caller tenant (tenant row → global default → code default). */
  getPolicy: () => Promise<HarnessPolicy>;
  /** WORM audit trail (newest-first) + chain-integrity verdict. */
  listAudit: (params?: { consultationId?: string; action?: string; limit?: number; offset?: number }) => Promise<HarnessAuditList>;
  /** Eval runs, newest-first. */
  listEvalRuns: (params?: { goldenSetId?: string; page?: number; limit?: number }) => Promise<HarnessEvalRunList>;
  /** One eval run with its per-case scores. */
  getEvalRun: (id: string) => Promise<HarnessEvalRunDetail>;
  /** Consultations awaiting clinician review with SLA/escalation state. */
  listGateQueue: () => Promise<HarnessGateQueue>;
  /** Temporal workflows — rejects with SERVICE_UNAVAILABLE when the harness is down. */
  listWorkflows: (params?: { status?: string; consultationId?: string; limit?: number }) => Promise<HarnessWorkflowList>;
}

export function useHarnessAdmin(): UseHarnessAdminReturn {
  const { execute, isLoading, error } = useApiOperation('useHarnessAdmin');

  const getPolicy = useCallback(
    () => execute<HarnessPolicy>('getPolicy', (client) => client.get<HarnessPolicy>(HARNESS_ADMIN_ENDPOINTS.POLICY)),
    [execute],
  );

  const listAudit = useCallback(
    (params?: { consultationId?: string; action?: string; limit?: number; offset?: number }) =>
      execute<HarnessAuditList>('listAudit', (client) =>
        client.get<HarnessAuditList>(
          appendFilters(HARNESS_ADMIN_ENDPOINTS.AUDIT, {
            consultationId: params?.consultationId,
            action: params?.action,
            limit: params?.limit !== undefined ? String(params.limit) : undefined,
            offset: params?.offset !== undefined ? String(params.offset) : undefined,
          }),
        ),
      ),
    [execute],
  );

  const listEvalRuns = useCallback(
    (params?: { goldenSetId?: string; page?: number; limit?: number }) =>
      execute<HarnessEvalRunList>('listEvalRuns', (client) =>
        client.get<HarnessEvalRunList>(
          appendFilters(HARNESS_ADMIN_ENDPOINTS.EVAL_RUNS, {
            goldenSetId: params?.goldenSetId,
            page: params?.page !== undefined ? String(params.page) : undefined,
            limit: params?.limit !== undefined ? String(params.limit) : undefined,
          }),
        ),
      ),
    [execute],
  );

  const getEvalRun = useCallback(
    (id: string) => execute<HarnessEvalRunDetail>('getEvalRun', (client) => client.get<HarnessEvalRunDetail>(HARNESS_ADMIN_ENDPOINTS.EVAL_RUN(id))),
    [execute],
  );

  const listGateQueue = useCallback(
    () => execute<HarnessGateQueue>('listGateQueue', (client) => client.get<HarnessGateQueue>(HARNESS_ADMIN_ENDPOINTS.GATE_QUEUE)),
    [execute],
  );

  const listWorkflows = useCallback(
    (params?: { status?: string; consultationId?: string; limit?: number }) =>
      execute<HarnessWorkflowList>('listWorkflows', (client) =>
        client.get<HarnessWorkflowList>(
          appendFilters(HARNESS_ADMIN_ENDPOINTS.WORKFLOWS, {
            status: params?.status,
            consultationId: params?.consultationId,
            limit: params?.limit !== undefined ? String(params.limit) : undefined,
          }),
        ),
      ),
    [execute],
  );

  return { isLoading, error, getPolicy, listAudit, listEvalRuns, getEvalRun, listGateQueue, listWorkflows };
}
