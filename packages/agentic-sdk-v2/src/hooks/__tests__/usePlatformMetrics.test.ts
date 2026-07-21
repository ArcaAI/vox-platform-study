/**
 * usePlatformMetrics Hook Tests
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePlatformMetrics } from '../usePlatformMetrics';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { PLATFORM_METRICS_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePlatformMetrics', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockStore = { apiClient: { get: mockGet, post: vi.fn(), patch: vi.fn(), delete: vi.fn() }, logger: mockLogger };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => vi.clearAllMocks());

    it('starts with all tiles null and not loading', () => {
        const { result } = renderHook(() => usePlatformMetrics());
        expect(result.current.metrics).toBeNull();
        expect(result.current.sockets).toBeNull();
        expect(result.current.consumption).toBeNull();
        expect(result.current.isLoading).toBe(false);
    });

    it('refresh() fetches E1/E2/E3 and updates state; consumption is platform-wide when no tenantId', async () => {
        const metrics = { requestsPerMinute: 12, openSockets: 3, services: [], models: { running: 0, perModel: [] }, requestVolumeSeries: [] };
        const sockets = { open: 3, perMinute: 1, total: 3, refreshedAt: 'now' };
        const consumption = { transcriptionMinutes: 5, summaries24h: 2, storageUsedBytes: 100, storageQuotaBytes: null, consultations: { total: 9, today: 1 }, refreshedAt: 'now' };
        mockGet
            .mockResolvedValueOnce(metrics)
            .mockResolvedValueOnce(sockets)
            .mockResolvedValueOnce(consumption);

        const { result } = renderHook(() => usePlatformMetrics());
        await act(async () => { await result.current.refresh(); });

        expect(mockGet).toHaveBeenCalledWith(PLATFORM_METRICS_ENDPOINTS.METRICS);
        expect(mockGet).toHaveBeenCalledWith(PLATFORM_METRICS_ENDPOINTS.SOCKETS);
        expect(mockGet).toHaveBeenCalledWith(PLATFORM_METRICS_ENDPOINTS.CONSUMPTION(undefined));
        expect(result.current.metrics).toEqual(metrics);
        expect(result.current.sockets).toEqual(sockets);
        expect(result.current.consumption).toEqual(consumption);
    });

    it('refresh(tenantId) scopes the consumption roll-up to that tenant', async () => {
        mockGet.mockResolvedValue({});
        const { result } = renderHook(() => usePlatformMetrics());

        await act(async () => { await result.current.refresh('tenant-7'); });

        expect(mockGet).toHaveBeenCalledWith(PLATFORM_METRICS_ENDPOINTS.CONSUMPTION('tenant-7'));
    });

    it('refresh() degrades per-tile: a failing sockets call still lands metrics + consumption', async () => {
        const metrics = { requestsPerMinute: 1, openSockets: 0, services: [], models: { running: 0, perModel: [] }, requestVolumeSeries: [] };
        const consumption = { transcriptionMinutes: 0, summaries24h: 0, storageUsedBytes: 0, storageQuotaBytes: null, consultations: { total: 0, today: 0 }, refreshedAt: 'now' };
        mockGet
            .mockResolvedValueOnce(metrics)
            .mockRejectedValueOnce(new Error('sockets down'))
            .mockResolvedValueOnce(consumption);

        const { result } = renderHook(() => usePlatformMetrics());
        await act(async () => { await result.current.refresh(); });

        expect(result.current.metrics).toEqual(metrics);
        expect(result.current.sockets).toBeNull();
        expect(result.current.consumption).toEqual(consumption);
    });
});
