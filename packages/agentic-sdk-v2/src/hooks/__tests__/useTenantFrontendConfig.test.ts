/**
 * useTenantFrontendConfig Hook Tests (TASK-328 A6)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTenantFrontendConfig } from '../useTenantFrontendConfig';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { TENANT_FRONTEND_CONFIG_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useTenantFrontendConfig', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPut = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPut.mockReset();
        mockStore = {
            apiClient: { get: mockGet, put: mockPut },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('starts with a null config', () => {
        const { result } = renderHook(() => useTenantFrontendConfig());
        expect(result.current.config).toBeNull();
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
    });

    describe('get', () => {
        it('GETs the config (no tenantId → tenant-admin CLS scope) and stores it', async () => {
            const cfg = { id: 'c1', tenantId: 't1', noiseCancel: true, vad: true, voiceEnrollment: false, diarization: false, version: 1 };
            mockGet.mockResolvedValue(cfg);
            const { result } = renderHook(() => useTenantFrontendConfig());

            let resp: unknown;
            await act(async () => { resp = await result.current.get(); });

            expect(mockGet).toHaveBeenCalledWith(TENANT_FRONTEND_CONFIG_ENDPOINTS.GET);
            expect(resp).toEqual(cfg);
            expect(result.current.config).toEqual(cfg);
        });

        it('appends ?tenantId= for a global admin', async () => {
            mockGet.mockResolvedValue(null);
            const { result } = renderHook(() => useTenantFrontendConfig());

            await act(async () => { await result.current.get('t-2'); });

            const [url] = mockGet.mock.calls[0];
            expect(url).toContain('tenantId=t-2');
        });

        it('tolerates a null body (tenant not yet configured)', async () => {
            mockGet.mockResolvedValue(null);
            const { result } = renderHook(() => useTenantFrontendConfig());

            let resp: unknown;
            await act(async () => { resp = await result.current.get(); });

            expect(resp).toBeNull();
            expect(result.current.config).toBeNull();
        });
    });

    describe('save', () => {
        it('PUTs the input and stores the returned config', async () => {
            const input = { asrModel: 'whisper-large-v3', noiseCancel: true, configJson: { vadThreshold: 0.5 } };
            const saved = { id: 'c1', tenantId: 't1', ...input, vad: true, voiceEnrollment: false, diarization: false, version: 2 };
            mockPut.mockResolvedValue(saved);
            const { result } = renderHook(() => useTenantFrontendConfig());

            let resp: unknown;
            await act(async () => { resp = await result.current.save(input); });

            expect(mockPut).toHaveBeenCalledWith(TENANT_FRONTEND_CONFIG_ENDPOINTS.UPSERT, input);
            expect(resp).toEqual(saved);
            expect(result.current.config).toEqual(saved);
        });

        it('appends ?tenantId= on save for a global admin', async () => {
            mockPut.mockResolvedValue({ id: 'c1', version: 1 });
            const { result } = renderHook(() => useTenantFrontendConfig());

            await act(async () => { await result.current.save({ vad: false }, 't-2'); });

            const [url] = mockPut.mock.calls[0];
            expect(url).toContain('tenantId=t-2');
        });

        it('surfaces save errors', async () => {
            mockPut.mockRejectedValue(new Error('precondition failed'));
            const { result } = renderHook(() => useTenantFrontendConfig());

            await act(async () => {
                try { await result.current.save({ vad: true, expectedVersion: 1 }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('precondition failed');
        });
    });
});
