/**
 * useDepartments Extended Methods Tests (TASK-032 WS-G Task G-4)
 *
 * Tests for new create, remove, getRoots, getChildren, getByCode, updatePromptConfig methods.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDepartments } from '../useDepartments';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { DEPARTMENT_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useDepartments - extended methods', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('create', () => {
        it('should POST to DEPARTMENT_ENDPOINTS.CREATE', async () => {
            const input = { name: 'New Department', code: 'NEW' };
            const created = { id: 'd-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created department to departments array', async () => {
            const existing = [{ id: 'd-1', name: 'Existing', code: 'EX' }];
            const created = { id: 'd-new', name: 'New', code: 'NEW' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ name: 'New', code: 'NEW' }); });

            expect(result.current.departments).toEqual([...existing, created]);
        });

        it('should set error on failure', async () => {
            mockPost.mockRejectedValue(new Error('Create failed'));
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.create({ name: 'New' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Create failed');
        });
    });

    describe('remove', () => {
        it('should DELETE from DEPARTMENT_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.remove('d-1'); });

            expect(mockDelete).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.DELETE('d-1'));
        });

        it('should remove department from departments array', async () => {
            const initial = [
                { id: 'd-1', name: 'Dept 1', code: 'D1' },
                { id: 'd-2', name: 'Dept 2', code: 'D2' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('d-1'); });

            expect(result.current.departments).toEqual([initial[1]]);
        });
    });

    describe('getRoots', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.ROOTS', async () => {
            const roots = [{ id: 'd-1', name: 'Root Dept', code: 'ROOT' }];
            mockGet.mockResolvedValue(roots);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getRoots(); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.ROOTS);
            expect(resp).toEqual(roots);
        });
    });

    describe('getChildren', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.CHILDREN(id)', async () => {
            const children = [
                { id: 'd-2', name: 'Child 1', code: 'C1' },
                { id: 'd-3', name: 'Child 2', code: 'C2' },
            ];
            mockGet.mockResolvedValue(children);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getChildren('d-1'); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.CHILDREN('d-1'));
            expect(resp).toEqual(children);
        });
    });

    describe('getByCode', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.BY_CODE(code)', async () => {
            const dept = { id: 'd-1', name: 'General Practice', code: 'GEN' };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByCode('GEN'); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.BY_CODE('GEN'));
            expect(resp).toEqual(dept);
        });
    });

    describe('updatePromptConfig', () => {
        it('should PATCH to DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id)', async () => {
            const config = { newPatientPromptId: 'pt-1', revisitPromptId: 'pt-2' };
            const updated = { id: 'd-1', name: 'Dept', ...config };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.updatePromptConfig('d-1', config); });

            expect(mockPatch).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.PROMPT_CONFIG('d-1'), config);
            expect(resp).toEqual(updated);
        });
    });

    describe('SDK not initialized for new methods', () => {
        it('should throw when create is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDepartments());

            await expect(
                act(async () => { await result.current.create({ name: 'New' }); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when remove is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDepartments());

            await expect(
                act(async () => { await result.current.remove('d-1'); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
