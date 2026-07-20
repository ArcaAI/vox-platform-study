/**
 * useDnaDashboard Hook Tests (TASK-328 A5)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDnaDashboard } from '../useDnaDashboard';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { DNA_STYLE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return {
        ...actual,
        useAgenticStore: vi.fn(),
    };
});

const fakeDashboard = {
    usersWithStyle: 7,
    avgVersions: 2.5,
    recentActivity: {
        dailyCounts: [
            { date: '2026-02-17', count: 3 },
            { date: '2026-02-18', count: 5 },
        ],
        latest: [
            { id: 'usage-1', doctorId: 'doc-1', dnaReportId: 'rep-1', dnaVersionNumber: 2, consultationId: 'c-1', createdAt: '2026-02-18T10:00:00.000Z' },
        ],
        total: 8,
        windowDays: 30,
    },
};

describe('useDnaDashboard (TASK-328 A5)', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('initial state', () => {
        it('returns null dashboard, not loading, no error', () => {
            const { result } = renderHook(() => useDnaDashboard());
            expect(result.current.dashboard).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('fetchDashboard', () => {
        it('GETs the dashboard endpoint (no tenantId) and stores the result', async () => {
            mockGet.mockResolvedValue(fakeDashboard);
            const { result } = renderHook(() => useDnaDashboard());

            let returned: unknown;
            await act(async () => {
                returned = await result.current.fetchDashboard();
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.ADMIN_DASHBOARD(undefined));
            expect(returned).toEqual(fakeDashboard);
            expect(result.current.dashboard).toEqual(fakeDashboard);
            expect(result.current.isLoading).toBe(false);
        });

        it('passes tenantId through to the endpoint for a global admin', async () => {
            mockGet.mockResolvedValue(fakeDashboard);
            const { result } = renderHook(() => useDnaDashboard());

            await act(async () => {
                await result.current.fetchDashboard('tenant-9');
            });

            expect(mockGet).toHaveBeenCalledWith(DNA_STYLE_ENDPOINTS.ADMIN_DASHBOARD('tenant-9'));
            expect(mockGet).toHaveBeenCalledWith('/admin/dna-writing-styles/dashboard?tenantId=tenant-9');
        });

        it('sets error on failure', async () => {
            const error = new Error('Network error');
            mockGet.mockRejectedValue(error);
            const { result } = renderHook(() => useDnaDashboard());

            await act(async () => {
                try {
                    await result.current.fetchDashboard();
                } catch {
                    /* expected */
                }
            });

            expect(result.current.error).toEqual(error);
            expect(result.current.isLoading).toBe(false);
        });

        it('throws when apiClient is not available', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDnaDashboard());

            await expect(
                act(async () => {
                    await result.current.fetchDashboard();
                }),
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
