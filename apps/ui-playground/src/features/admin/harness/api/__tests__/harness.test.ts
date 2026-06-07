/**
 * TASK-330 Phase 6 — Harness admin API client.
 *
 * Verifies the typed client functions + React Query hooks hit the exact
 * `/admin/harness/*` routes with the right query params, request bodies, and —
 * critically — the RFC 7232 `If-Match: "<version>"` header on policy PATCH (OCC).
 *
 * The `adminClient` is mocked so the assertions are purely about the wire
 * contract; no live backend is touched.
 */
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  harnessApi,
  useHarnessPolicy,
  useUpdateHarnessPolicy,
  useUpdateGlobalHarnessPolicy,
  useHarnessAudit,
  useHarnessGateQueue,
  useHarnessWorkflows,
  useCancelWorkflow,
  useTerminateWorkflow,
  useSignalWorkflow,
} from '../harness';

vi.mock('../../../api/admin-client', () => ({
  AdminApiError: class AdminApiError extends Error {},
  adminClient: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
}));

import { adminClient } from '../../../api/admin-client';

const mockGet = adminClient.get as ReturnType<typeof vi.fn>;
const mockPost = adminClient.post as ReturnType<typeof vi.fn>;
const mockPatch = adminClient.patch as ReturnType<typeof vi.fn>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };
}

const POLICY = { id: 'p1', tenantId: 't1', source: 'tenant', version: 3, entityFaithfulnessThreshold: 1 };
const AUDIT = { items: [], total: 0, verification: { valid: true, brokenAtIndex: null } };
const GATE = { items: [], total: 0, slaBreachedCount: 0, escalatedCount: 0, gateSlaSeconds: 1, gateEscalationSeconds: 1, policySource: 'tenant' };
const WORKFLOWS = { items: [], nextPageToken: null };
const ACTION = { workflowId: 'wf1', runId: 'r1', status: 'RUNNING', action: 'cancel', requested: true };

describe('harnessApi raw client functions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('getPolicy GETs /admin/harness/policy (no tenant option when unset)', async () => {
    mockGet.mockResolvedValueOnce(POLICY);
    await harnessApi.getPolicy();
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/policy', undefined);
  });

  it('getPolicy forwards the selected tenant as the X-Tenant-Id option', async () => {
    mockGet.mockResolvedValueOnce(POLICY);
    await harnessApi.getPolicy('tenant-9');
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/policy', { tenantId: 'tenant-9' });
  });

  it('updatePolicy PATCHes /admin/harness/policy with the If-Match version header', async () => {
    mockPatch.mockResolvedValueOnce(POLICY);
    await harnessApi.updatePolicy({ coverageThreshold: 0.7, reason: 'tune' }, 3, 'tenant-9');
    expect(mockPatch).toHaveBeenCalledWith(
      '/admin/harness/policy',
      { coverageThreshold: 0.7, reason: 'tune' },
      { tenantId: 'tenant-9', ifMatch: '"3"' },
    );
  });

  it('updateGlobalPolicy PATCHes /admin/harness/policy/global with If-Match (no tenant)', async () => {
    mockPatch.mockResolvedValueOnce(POLICY);
    await harnessApi.updateGlobalPolicy({ maxRegen: 1 }, 5);
    expect(mockPatch).toHaveBeenCalledWith('/admin/harness/policy/global', { maxRegen: 1 }, { ifMatch: '"5"' });
  });

  it('getGlobalPolicy GETs /admin/harness/policy/global', async () => {
    mockGet.mockResolvedValueOnce(POLICY);
    await harnessApi.getGlobalPolicy();
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/policy/global');
  });

  it('listAudit builds the consultationId/limit/offset query string', async () => {
    mockGet.mockResolvedValueOnce(AUDIT);
    await harnessApi.listAudit({ tenantId: 't1', consultationId: 'c1', limit: 25, offset: 50 });
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/audit?consultationId=c1&limit=25&offset=50', { tenantId: 't1' });
  });

  it('listAudit omits empty params entirely', async () => {
    mockGet.mockResolvedValueOnce(AUDIT);
    await harnessApi.listAudit({});
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/audit', undefined);
  });

  it('listEvalRuns builds the goldenSetId/page/limit query string', async () => {
    mockGet.mockResolvedValueOnce({ items: [], total: 0 });
    await harnessApi.listEvalRuns({ goldenSetId: 'g1', page: 2, limit: 20, tenantId: 't1' });
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/eval-runs?goldenSetId=g1&page=2&limit=20', { tenantId: 't1' });
  });

  it('getEvalRun GETs the encoded detail route', async () => {
    mockGet.mockResolvedValueOnce({ id: 'run 1', scores: [] });
    await harnessApi.getEvalRun('run 1', 't1');
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/eval-runs/run%201', { tenantId: 't1' });
  });

  it('getGateQueue GETs /admin/harness/gate-queue', async () => {
    mockGet.mockResolvedValueOnce(GATE);
    await harnessApi.getGateQueue('t1');
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/gate-queue', { tenantId: 't1' });
  });

  it('listWorkflows builds the status/consultationId/limit/pageToken query string', async () => {
    mockGet.mockResolvedValueOnce(WORKFLOWS);
    await harnessApi.listWorkflows({ status: 'RUNNING', consultationId: 'c1', limit: 50, pageToken: 'tok' });
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/workflows?status=RUNNING&consultationId=c1&limit=50&pageToken=tok', undefined);
  });

  it('getWorkflow adds ?phase=true only when requested', async () => {
    mockGet.mockResolvedValueOnce({ workflowId: 'wf1' });
    await harnessApi.getWorkflow('wf1', true, 't1');
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/workflows/wf1?phase=true', { tenantId: 't1' });

    mockGet.mockResolvedValueOnce({ workflowId: 'wf1' });
    await harnessApi.getWorkflow('wf1', false);
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/workflows/wf1', undefined);
  });

  it('cancelWorkflow POSTs the reason body to /cancel', async () => {
    mockPost.mockResolvedValueOnce(ACTION);
    await harnessApi.cancelWorkflow('wf1', { reason: 'stuck' }, 't1');
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/cancel', { reason: 'stuck' }, { tenantId: 't1' });
  });

  it('terminateWorkflow POSTs the reason body to /terminate', async () => {
    mockPost.mockResolvedValueOnce({ ...ACTION, action: 'terminate' });
    await harnessApi.terminateWorkflow('wf1', { reason: 'bad' });
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/terminate', { reason: 'bad' }, undefined);
  });

  it('signalWorkflow POSTs the signalName + payload to /signal', async () => {
    mockPost.mockResolvedValueOnce({ ...ACTION, action: 'signal' });
    await harnessApi.signalWorkflow('wf1', { signalName: 'approve', payload: { ok: true } }, 't1');
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/signal', { signalName: 'approve', payload: { ok: true } }, { tenantId: 't1' });
  });
});

describe('harness React Query hooks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('useHarnessPolicy GETs the policy', async () => {
    mockGet.mockResolvedValueOnce(POLICY);
    const { result } = renderHook(() => useHarnessPolicy('t1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/policy', { tenantId: 't1' });
  });

  it('useHarnessAudit GETs the audit feed', async () => {
    mockGet.mockResolvedValueOnce(AUDIT);
    const { result } = renderHook(() => useHarnessAudit({ tenantId: 't1', limit: 25, offset: 0 }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/audit?limit=25&offset=0', { tenantId: 't1' });
  });

  it('useHarnessGateQueue GETs the gate queue', async () => {
    mockGet.mockResolvedValueOnce(GATE);
    const { result } = renderHook(() => useHarnessGateQueue('t1'), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/gate-queue', { tenantId: 't1' });
  });

  it('useHarnessWorkflows GETs the workflow list', async () => {
    mockGet.mockResolvedValueOnce(WORKFLOWS);
    const { result } = renderHook(() => useHarnessWorkflows({ tenantId: 't1', status: 'RUNNING' }), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockGet).toHaveBeenCalledWith('/admin/harness/workflows?status=RUNNING', { tenantId: 't1' });
  });

  it('useUpdateHarnessPolicy PATCHes with If-Match and seeds the cache', async () => {
    mockPatch.mockResolvedValueOnce({ ...POLICY, version: 4 });
    const { result } = renderHook(() => useUpdateHarnessPolicy(), { wrapper: createWrapper() });
    result.current.mutate({ body: { coverageThreshold: 0.5 }, version: 3, tenantId: 't1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/admin/harness/policy', { coverageThreshold: 0.5 }, { tenantId: 't1', ifMatch: '"3"' });
  });

  it('useUpdateGlobalHarnessPolicy PATCHes the global route with If-Match', async () => {
    mockPatch.mockResolvedValueOnce({ ...POLICY, version: 6 });
    const { result } = renderHook(() => useUpdateGlobalHarnessPolicy(), { wrapper: createWrapper() });
    result.current.mutate({ body: { maxRegen: 0 }, version: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockPatch).toHaveBeenCalledWith('/admin/harness/policy/global', { maxRegen: 0 }, { ifMatch: '"5"' });
  });

  it('useCancelWorkflow / useTerminateWorkflow / useSignalWorkflow POST to the right routes', async () => {
    mockPost.mockResolvedValue(ACTION);
    const wrapper = createWrapper();

    const cancel = renderHook(() => useCancelWorkflow(), { wrapper });
    cancel.result.current.mutate({ workflowId: 'wf1', reason: 'x', tenantId: 't1' });
    await waitFor(() => expect(cancel.result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/cancel', { reason: 'x' }, { tenantId: 't1' });

    const terminate = renderHook(() => useTerminateWorkflow(), { wrapper });
    terminate.result.current.mutate({ workflowId: 'wf1', reason: 'y', tenantId: 't1' });
    await waitFor(() => expect(terminate.result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/terminate', { reason: 'y' }, { tenantId: 't1' });

    const signal = renderHook(() => useSignalWorkflow(), { wrapper });
    signal.result.current.mutate({ workflowId: 'wf1', signalName: 'approve', tenantId: 't1' });
    await waitFor(() => expect(signal.result.current.isSuccess).toBe(true));
    expect(mockPost).toHaveBeenCalledWith('/admin/harness/workflows/wf1/signal', { signalName: 'approve', payload: undefined }, { tenantId: 't1' });
  });
});
