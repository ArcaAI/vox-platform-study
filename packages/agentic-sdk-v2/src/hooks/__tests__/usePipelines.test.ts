/**
 * usePipelines Hook Tests (TASK-032 WS-A)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePipelines } from '../usePipelines';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { PIPELINE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePipelines', () => {
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

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty pipelines and null selectedPipeline', () => {
            const { result } = renderHook(() => usePipelines());
            expect(result.current.pipelines).toEqual([]);
            expect(result.current.selectedPipeline).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from PIPELINE_ENDPOINTS.LIST and update state', async () => {
            const data = [
                { id: 'p-1', name: 'Default Pipeline', slug: 'default' },
                { id: 'p-2', name: 'Fast Pipeline', slug: 'fast' },
            ];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.LIST);
            expect(result.current.pipelines).toEqual(data);
            expect(resp).toEqual(data);
        });

        it('should pass pagination params', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list({ page: 2, limit: 5 }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('page=2'));
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => usePipelines());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should extract array from paginated wrapper response', async () => {
            const pipelines = [{ id: 'p-1', name: 'Default Pipeline', slug: 'default' }];
            mockGet.mockResolvedValue({ data: pipelines, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });

            expect(result.current.pipelines).toEqual(pipelines);
            expect(Array.isArray(result.current.pipelines)).toBe(true);
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ error: 'not found' });
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });

            expect(result.current.pipelines).toEqual([]);
        });
    });

    describe('get', () => {
        it('should GET from PIPELINE_ENDPOINTS.GET(id)', async () => {
            const pipeline = { id: 'p-1', name: 'Default Pipeline', slug: 'default' };
            mockGet.mockResolvedValue(pipeline);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('p-1'); });

            expect(mockGet).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.GET('p-1'));
            expect(resp).toEqual(pipeline);
        });
    });

    describe('getBySlug', () => {
        it('should GET from PIPELINE_ENDPOINTS.GET_BY_SLUG(slug)', async () => {
            const pipeline = { id: 'p-1', name: 'Default Pipeline', slug: 'default' };
            mockGet.mockResolvedValue(pipeline);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.getBySlug('default'); });

            expect(mockGet).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.GET_BY_SLUG('default'));
            expect(resp).toEqual(pipeline);
        });
    });

    describe('select', () => {
        it('should set selectedPipeline from loaded pipelines', async () => {
            const data = [
                { id: 'p-1', name: 'Default', slug: 'default' },
                { id: 'p-2', name: 'Fast', slug: 'fast' },
            ];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            act(() => { result.current.select('p-2'); });

            expect(result.current.selectedPipeline).toEqual(data[1]);
        });

        it('should set null when pipeline id not found', async () => {
            const data = [{ id: 'p-1', name: 'Default', slug: 'default' }];
            mockGet.mockResolvedValue(data);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            act(() => { result.current.select('nonexistent'); });

            expect(result.current.selectedPipeline).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ */
    /*  TASK-218 Priority 5: CRUD + validate methods                       */
    /* ------------------------------------------------------------------ */

    describe('createPipeline (TASK-218)', () => {
        it('should POST to PIPELINE_ENDPOINTS.CREATE with input', async () => {
            const mockPost = mockStore.apiClient.post;
            const input = { name: 'medical-pipeline', slug: 'medical', configYaml: 'stages: []' };
            const created = { id: 'p-new', ...input, resourceStatus: 'ENABLED' };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.createPipeline(input); });

            expect(mockPost).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created pipeline to pipelines array', async () => {
            const mockPost = mockStore.apiClient.post;
            const existing = [{ id: 'p-1', name: 'Default', slug: 'default' }];
            const created = { id: 'p-new', name: 'New', slug: 'new', configYaml: '' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.createPipeline({ name: 'New', slug: 'new', configYaml: '' }); });

            expect(result.current.pipelines).toEqual([...existing, created]);
        });
    });

    describe('updatePipeline (TASK-218)', () => {
        it('should PATCH to PIPELINE_ENDPOINTS.UPDATE(id) with data', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'p-1', name: 'Updated', slug: 'default', configYaml: 'stages: [stt]' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.updatePipeline('p-1', { name: 'Updated' });
            });

            expect(mockPatch).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.UPDATE('p-1'), { name: 'Updated' });
            expect(resp).toEqual(updated);
        });

        it('should update pipeline in array', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const initial = [
                { id: 'p-1', name: 'Default', slug: 'default' },
                { id: 'p-2', name: 'Fast', slug: 'fast' },
            ];
            const updated = { id: 'p-1', name: 'Renamed', slug: 'default' };
            mockGet.mockResolvedValue(initial);
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.updatePipeline('p-1', { name: 'Renamed' }); });

            expect(result.current.pipelines[0]).toEqual(updated);
            expect(result.current.pipelines[1]).toEqual(initial[1]);
        });
    });

    describe('deletePipeline (TASK-218)', () => {
        it('should DELETE from PIPELINE_ENDPOINTS.DELETE(id)', async () => {
            const mockDelete = mockStore.apiClient.delete;
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.deletePipeline('p-1'); });

            expect(mockDelete).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.DELETE('p-1'));
        });

        it('should remove pipeline from array', async () => {
            const mockDelete = mockStore.apiClient.delete;
            const initial = [
                { id: 'p-1', name: 'Default', slug: 'default' },
                { id: 'p-2', name: 'Fast', slug: 'fast' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.deletePipeline('p-1'); });

            expect(result.current.pipelines).toEqual([initial[1]]);
        });
    });

    describe('validateConfig (TASK-218)', () => {
        it('should POST to PIPELINE_ENDPOINTS.VALIDATE with configYaml', async () => {
            const mockPost = mockStore.apiClient.post;
            const validationResult = { valid: true, errors: [] };
            mockPost.mockResolvedValue(validationResult);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.validateConfig('stages:\n  - stt'); });

            expect(mockPost).toHaveBeenCalledWith(PIPELINE_ENDPOINTS.VALIDATE, { configYaml: 'stages:\n  - stt' });
            expect(resp).toEqual(validationResult);
        });

        // TASK-265 W0-9 / GAP-10: lock the actual URL string. The previous SDK
        // value ended in `/validate-yaml`, the API was renamed to `/validate`.
        it('TASK-265: posts to exactly /admin/audio/pipelines/validate (no -yaml)', async () => {
            const mockPost = mockStore.apiClient.post;
            mockPost.mockResolvedValue({ valid: true });
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.validateConfig('stages: []'); });

            const [endpoint] = mockPost.mock.calls[0];
            expect(endpoint).toBe('/admin/audio/pipelines/validate');
            expect(endpoint).not.toContain('-yaml');
        });

        it('should return validation errors for invalid config', async () => {
            const mockPost = mockStore.apiClient.post;
            const validationResult = { valid: false, errors: ['Invalid YAML syntax at line 3'] };
            mockPost.mockResolvedValue(validationResult);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => { resp = await result.current.validateConfig('invalid: {yaml'); });

            expect(resp).toEqual(validationResult);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-006: assignToTenant tests                                       */
    /* ------------------------------------------------------------------ */

    describe('assignToTenant (QA-006)', () => {
        it('should POST to correct endpoint with tenantId', async () => {
            const mockPost = mockStore.apiClient.post;
            const response = { message: 'Pipeline assigned to tenant successfully' };
            mockPost.mockResolvedValue(response);
            const { result } = renderHook(() => usePipelines());

            await act(async () => {
                await result.current.assignToTenant('p-1', 'tenant-abc');
            });

            expect(mockPost).toHaveBeenCalledWith(
                PIPELINE_ENDPOINTS.ASSIGN_TENANT('p-1'),
                { tenantId: 'tenant-abc' },
            );
        });

        it('should return message on success', async () => {
            const mockPost = mockStore.apiClient.post;
            const response = { message: 'Pipeline assigned to tenant successfully' };
            mockPost.mockResolvedValue(response);
            const { result } = renderHook(() => usePipelines());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.assignToTenant('p-1', 'tenant-abc');
            });

            expect(resp).toEqual(response);
            expect((resp as { message: string }).message).toBe('Pipeline assigned to tenant successfully');
        });

        it('should handle errors', async () => {
            const mockPost = mockStore.apiClient.post;
            mockPost.mockRejectedValue(new Error('Tenant not found'));
            const { result } = renderHook(() => usePipelines());

            await act(async () => {
                try { await result.current.assignToTenant('p-1', 'bad-tenant'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Tenant not found');
            expect(result.current.isLoading).toBe(false);
        });

        it('should handle empty tenantId', async () => {
            const mockPost = mockStore.apiClient.post;
            const response = { message: 'assigned' };
            mockPost.mockResolvedValue(response);
            const { result } = renderHook(() => usePipelines());

            await act(async () => {
                await result.current.assignToTenant('p-1', '');
            });

            expect(mockPost).toHaveBeenCalledWith(
                PIPELINE_ENDPOINTS.ASSIGN_TENANT('p-1'),
                { tenantId: '' },
            );
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => usePipelines());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('null logger', () => {
        it('should work when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePipelines());

            await act(async () => { await result.current.list(); });
            expect(result.current.pipelines).toEqual([]);
        });
    });
});
