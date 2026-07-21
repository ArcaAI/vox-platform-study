/**
 * useHarnessAdmin Hook Tests
 *
 * Read-only Clinical Documentation Harness admin surface. DB-backed reads
 * (policy / audit / eval runs / gate queue) plus the Temporal workflows proxy,
 * which the server answers with 503 when the harness service is down — the
 * hook must surface that as a clean error the UI can degrade on.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHarnessAdmin } from '../useHarnessAdmin';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { HARNESS_ADMIN_ENDPOINTS } from '../../core/constants';
import { AgenticError } from '../../types/common';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useHarnessAdmin', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockStore = { apiClient: { get: mockGet }, logger: mockLogger };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('getPolicy', () => {
        it('GETs HARNESS_ADMIN_ENDPOINTS.POLICY and returns the effective policy', async () => {
            const policy = { id: 'pol-1', tenantId: 't-1', source: 'tenant', version: 3, gateSlaSeconds: 86400 };
            mockGet.mockResolvedValue(policy);
            const { result } = renderHook(() => useHarnessAdmin());

            let resp: any;
            await act(async () => { resp = await result.current.getPolicy(); });

            expect(mockGet).toHaveBeenCalledWith(HARNESS_ADMIN_ENDPOINTS.POLICY);
            expect(resp).toEqual(policy);
        });
    });

    describe('listAudit', () => {
        it('GETs the audit trail with limit/offset as query strings', async () => {
            const page = { items: [{ id: 'a-1', action: 'GATE_DECISION' }], total: 1, verification: { valid: true, brokenAtIndex: null } };
            mockGet.mockResolvedValue(page);
            const { result } = renderHook(() => useHarnessAdmin());

            let resp: any;
            await act(async () => { resp = await result.current.listAudit({ limit: 25, offset: 50 }); });

            expect(mockGet).toHaveBeenCalledWith(`${HARNESS_ADMIN_ENDPOINTS.AUDIT}?limit=25&offset=50`);
            expect(resp.total).toBe(1);
            expect(resp.verification.valid).toBe(true);
        });

        it('GETs the bare audit path when no params are given', async () => {
            mockGet.mockResolvedValue({ items: [], total: 0, verification: { valid: true, brokenAtIndex: null } });
            const { result } = renderHook(() => useHarnessAdmin());

            await act(async () => { await result.current.listAudit(); });

            expect(mockGet).toHaveBeenCalledWith(HARNESS_ADMIN_ENDPOINTS.AUDIT);
        });
    });

    describe('listEvalRuns / getEvalRun', () => {
        it('GETs eval runs with pagination', async () => {
            mockGet.mockResolvedValue({ items: [], total: 0 });
            const { result } = renderHook(() => useHarnessAdmin());

            await act(async () => { await result.current.listEvalRuns({ page: 2, limit: 10 }); });

            expect(mockGet).toHaveBeenCalledWith(`${HARNESS_ADMIN_ENDPOINTS.EVAL_RUNS}?page=2&limit=10`);
        });

        it('GETs one eval run by id (URL-encoded)', async () => {
            mockGet.mockResolvedValue({ id: 'run 1', scores: [] });
            const { result } = renderHook(() => useHarnessAdmin());

            await act(async () => { await result.current.getEvalRun('run 1'); });

            expect(mockGet).toHaveBeenCalledWith(HARNESS_ADMIN_ENDPOINTS.EVAL_RUN('run 1'));
            expect(HARNESS_ADMIN_ENDPOINTS.EVAL_RUN('run 1')).toBe('/admin/harness/eval-runs/run%201');
        });
    });

    describe('listGateQueue', () => {
        it('GETs the gate queue and returns SLA counters', async () => {
            const queue = { items: [], total: 0, slaBreachedCount: 0, escalatedCount: 0, gateSlaSeconds: 86400, gateEscalationSeconds: 43200, policySource: 'code-default' };
            mockGet.mockResolvedValue(queue);
            const { result } = renderHook(() => useHarnessAdmin());

            let resp: any;
            await act(async () => { resp = await result.current.listGateQueue(); });

            expect(mockGet).toHaveBeenCalledWith(HARNESS_ADMIN_ENDPOINTS.GATE_QUEUE);
            expect(resp.gateSlaSeconds).toBe(86400);
        });
    });

    describe('listWorkflows (Temporal-backed, degrades when harness is down)', () => {
        it('GETs workflows with a status filter', async () => {
            mockGet.mockResolvedValue({ items: [], nextPageToken: null });
            const { result } = renderHook(() => useHarnessAdmin());

            await act(async () => { await result.current.listWorkflows({ status: 'RUNNING', limit: 5 }); });

            expect(mockGet).toHaveBeenCalledWith(`${HARNESS_ADMIN_ENDPOINTS.WORKFLOWS}?status=RUNNING&limit=5`);
        });

        it('surfaces the 503 (harness down) as a catchable error, not a crash', async () => {
            mockGet.mockRejectedValue(new AgenticError('API_ERROR', 'Harness ops request failed'));
            const { result } = renderHook(() => useHarnessAdmin());

            let caught: unknown;
            await act(async () => {
                try { await result.current.listWorkflows(); } catch (e) { caught = e; }
            });

            expect(caught).toBeInstanceOf(AgenticError);
            expect((caught as AgenticError).code).toBe('API_ERROR');
            expect(result.current.error).not.toBeNull();
        });
    });

    describe('SDK not initialized', () => {
        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useHarnessAdmin());

            await expect(
                act(async () => { await result.current.getPolicy(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
