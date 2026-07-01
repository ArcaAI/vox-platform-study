/**
 * useDepartments Hook Tests (SDK-207 WS-5)
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

describe('useDepartments', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPatch = vi.fn();
    // TASK-302 Stream D OCC — `updatePromptConfig` replays the read version as `If-Match`.
    const mockPatchWithIfMatch = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPatch.mockReset();
        mockPatchWithIfMatch.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: vi.fn(), patch: mockPatch, delete: vi.fn(), patchWithIfMatch: mockPatchWithIfMatch },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    describe('initial state', () => {
        it('should return empty departments and null currentDepartment', () => {
            const { result } = renderHook(() => useDepartments());
            expect(result.current.departments).toEqual([]);
            expect(result.current.currentDepartment).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('list', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.LIST and update state', async () => {
            const depts = [
                { id: 'd-1', name: 'General Practice', code: 'GEN' },
                { id: 'd-2', name: 'Cardiology', code: 'CARD' },
            ];
            mockGet.mockResolvedValue(depts);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.LIST);
            expect(result.current.departments).toEqual(depts);
            expect(resp).toEqual(depts);
        });

        it('should set error on failure', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Fetch failed');
        });

        it('should extract array from paginated wrapper response', async () => {
            const depts = [{ id: 'd-1', name: 'General Practice', code: 'GEN' }];
            mockGet.mockResolvedValue({ data: depts, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });

            expect(result.current.departments).toEqual(depts);
            expect(Array.isArray(result.current.departments)).toBe(true);
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });

            expect(result.current.departments).toEqual([]);
        });
    });

    describe('get', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.GET(id) and set currentDepartment', async () => {
            const dept = { id: 'd-1', name: 'General Practice', code: 'GEN', newPatientPromptId: 'pt-1' };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('d-1'); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.GET('d-1'));
            expect(result.current.currentDepartment).toEqual(dept);
            expect(resp).toEqual(dept);
        });
    });

    describe('update', () => {
        it('should PATCH to DEPARTMENT_ENDPOINTS.UPDATE(id)', async () => {
            const updated = { id: 'd-1', name: 'General Practice', code: 'GEN', newPatientPromptId: 'pt-2' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.update('d-1', { newPatientPromptId: 'pt-2' });
            });

            expect(mockPatch).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.UPDATE('d-1'), { newPatientPromptId: 'pt-2' });
            expect(result.current.currentDepartment).toEqual(updated);
            expect(resp).toEqual(updated);
        });

        it('should set error on failure', async () => {
            mockPatch.mockRejectedValue(new Error('Update failed'));
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.update('d-1', { name: 'New' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Update failed');
        });
    });

    describe('SDK not initialized', () => {
        it('should throw when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDepartments());

            await expect(
                act(async () => { await result.current.list(); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when get is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDepartments());

            await expect(
                act(async () => { await result.current.get('d-1'); })
            ).rejects.toThrow('SDK not initialized');
        });

        it('should throw when update is called with null apiClient', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useDepartments());

            await expect(
                act(async () => { await result.current.update('d-1', { name: 'New' }); })
            ).rejects.toThrow('SDK not initialized');
        });
    });

    describe('get - error handling', () => {
        it('should set error state on failure and reset isLoading', async () => {
            mockGet.mockRejectedValue(new Error('Get failed'));
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.get('d-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Get failed');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('get - currentDepartment updates', () => {
        it('should update currentDepartment when get is called with different ids', async () => {
            const dept1 = { id: 'd-1', name: 'General Practice', code: 'GEN' };
            const dept2 = { id: 'd-2', name: 'Cardiology', code: 'CARD' };
            mockGet.mockResolvedValueOnce(dept1).mockResolvedValueOnce(dept2);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.get('d-1'); });
            expect(result.current.currentDepartment).toEqual(dept1);

            await act(async () => { await result.current.get('d-2'); });
            expect(result.current.currentDepartment).toEqual(dept2);
        });
    });

    describe('update - state mutation', () => {
        it('should replace matching department in departments array after list then update', async () => {
            const initial = [
                { id: 'd-1', name: 'General Practice', code: 'GEN' },
                { id: 'd-2', name: 'Cardiology', code: 'CARD' },
            ];
            const updated = { id: 'd-1', name: 'General Practice Updated', code: 'GEN' };
            mockGet.mockResolvedValue(initial);
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            expect(result.current.departments).toEqual(initial);

            await act(async () => { await result.current.update('d-1', { name: 'General Practice Updated' }); });
            expect(result.current.departments).toEqual([updated, initial[1]]);
        });
    });

    describe('list - replaces departments', () => {
        it('should replace departments with latest response when called twice', async () => {
            const first = [
                { id: 'd-1', name: 'First', code: 'A' },
            ];
            const second = [
                { id: 'd-2', name: 'Second', code: 'B' },
                { id: 'd-3', name: 'Third', code: 'C' },
            ];
            mockGet.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            expect(result.current.departments).toEqual(first);

            await act(async () => { await result.current.list(); });
            expect(result.current.departments).toEqual(second);
        });
    });

    describe('list - empty array', () => {
        it('should handle empty array response correctly', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.list(); });

            expect(result.current.departments).toEqual([]);
            expect(resp).toEqual([]);
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on success', async () => {
            mockGet.mockRejectedValueOnce(new Error('Fetch failed')).mockResolvedValueOnce([{ id: 'd-1', name: 'Dept' }]);
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('Fetch failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });

    describe('null logger', () => {
        it('should work correctly when store.logger is null', async () => {
            mockStore.logger = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const depts = [{ id: 'd-1', name: 'Dept', code: 'D' }];
            mockGet.mockResolvedValueOnce(depts).mockResolvedValueOnce(depts[0]);
            mockPatch.mockResolvedValue({ ...depts[0], name: 'Updated' });
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            expect(result.current.departments).toEqual(depts);

            await act(async () => { await result.current.get('d-1'); });
            expect(result.current.currentDepartment).toEqual(depts[0]);

            await act(async () => { await result.current.update('d-1', { name: 'Updated' }); });
            expect(result.current.currentDepartment?.name).toBe('Updated');
        });
    });

    describe('isLoading resets on error', () => {
        it('should set isLoading to false after a failed call', async () => {
            mockGet.mockRejectedValue(new Error('Fetch failed'));
            const { result } = renderHook(() => useDepartments());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.isLoading).toBe(false);
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

        it('should extract array from paginated wrapper response', async () => {
            const roots = [{ id: 'd-1', name: 'Root Dept', code: 'ROOT' }];
            mockGet.mockResolvedValue({ data: roots, count: 1, page: 1 });
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getRoots(); });

            expect(resp).toEqual(roots);
            expect(Array.isArray(resp)).toBe(true);
        });

        it('should return empty array for unexpected response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getRoots(); });

            expect(resp).toEqual([]);
        });
    });

    describe('getChildren', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.CHILDREN(id)', async () => {
            const children = [{ id: 'd-2', name: 'Child Dept', code: 'CHILD' }];
            mockGet.mockResolvedValue(children);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getChildren('d-1'); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.CHILDREN('d-1'));
            expect(resp).toEqual(children);
        });

        it('should extract array from paginated wrapper response', async () => {
            const children = [{ id: 'd-2', name: 'Child Dept', code: 'CHILD' }];
            mockGet.mockResolvedValue({ data: children, count: 1 });
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getChildren('d-1'); });

            expect(resp).toEqual(children);
            expect(Array.isArray(resp)).toBe(true);
        });

        it('should return empty array for unexpected response shape', async () => {
            mockGet.mockResolvedValue({ status: 'empty' });
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getChildren('d-1'); });

            expect(resp).toEqual([]);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  TASK-218 Priority 7: create, remove, getByCode, updatePromptConfig */
    /* ------------------------------------------------------------------ */

    describe('create (TASK-218)', () => {
        it('should POST to DEPARTMENT_ENDPOINTS.CREATE with input', async () => {
            const mockPost = mockStore.apiClient.post;
            const input = { name: 'Cardiology', code: 'CARD' };
            const created = { id: 'd-new', ...input };
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.create(input); });

            expect(mockPost).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.CREATE, input);
            expect(resp).toEqual(created);
        });

        it('should add created department to departments array', async () => {
            const mockPost = mockStore.apiClient.post;
            const existing = [{ id: 'd-1', name: 'Radiology', code: 'RAD' }];
            const created = { id: 'd-new', name: 'Cardiology', code: 'CARD' };
            mockGet.mockResolvedValue(existing);
            mockPost.mockResolvedValue(created);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.create({ name: 'Cardiology', code: 'CARD' }); });

            expect(result.current.departments).toEqual([...existing, created]);
        });
    });

    describe('remove (TASK-218)', () => {
        it('should DELETE from DEPARTMENT_ENDPOINTS.DELETE(id)', async () => {
            const mockDelete = mockStore.apiClient.delete;
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.remove('d-1'); });

            expect(mockDelete).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.DELETE('d-1'));
        });

        it('should remove department from array', async () => {
            const mockDelete = mockStore.apiClient.delete;
            const initial = [
                { id: 'd-1', name: 'Radiology', code: 'RAD' },
                { id: 'd-2', name: 'Cardiology', code: 'CARD' },
            ];
            mockGet.mockResolvedValue(initial);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.remove('d-1'); });

            expect(result.current.departments).toEqual([initial[1]]);
        });
    });

    describe('getByCode (TASK-218)', () => {
        it('should GET from DEPARTMENT_ENDPOINTS.BY_CODE(code)', async () => {
            const dept = { id: 'd-1', name: 'Radiology', code: 'RAD' };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => { resp = await result.current.getByCode('RAD'); });

            expect(mockGet).toHaveBeenCalledWith(DEPARTMENT_ENDPOINTS.BY_CODE('RAD'));
            expect(resp).toEqual(dept);
        });
    });

    describe('updatePromptConfig (TASK-218)', () => {
        it('should PATCH to DEPARTMENT_ENDPOINTS.PROMPT_CONFIG(id) with data', async () => {
            const mockPatch = mockStore.apiClient.patch;
            const updated = { id: 'd-1', name: 'Radiology', preSummaryPromptId: 'p-123' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.updatePromptConfig('d-1', { preSummaryPromptId: 'p-123' });
            });

            expect(mockPatch).toHaveBeenCalledWith(
                DEPARTMENT_ENDPOINTS.PROMPT_CONFIG('d-1'),
                { preSummaryPromptId: 'p-123' },
            );
            expect(resp).toEqual(updated);
        });

        // TASK-302 Stream D OCC: `PATCH admin/departments/:id/prompt-config` is
        // `@RequiresIfMatch()`. When the caller supplies the read `expectedVersion`
        // (DNA writing-style slot flow, TASK-387 #7), it is replayed as the strong
        // `If-Match` validator so the server CAS-checks it instead of 428-ing.
        it('should PATCH with If-Match when expectedVersion is supplied', async () => {
            const updated = { id: 'd-1', name: 'Cardiology', dnaWritingStylePromptId: 'p-9', version: 6 };
            mockPatchWithIfMatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.updatePromptConfig('d-1', { dnaWritingStylePromptId: 'p-9', expectedVersion: 5 });
            });

            expect(mockPatchWithIfMatch).toHaveBeenCalledWith(
                DEPARTMENT_ENDPOINTS.PROMPT_CONFIG('d-1'),
                { dnaWritingStylePromptId: 'p-9', expectedVersion: 5 },
                '"5"',
            );
            expect(mockPatch).not.toHaveBeenCalled();
            expect(resp).toEqual(updated);
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-004 Gap 1: summaryPromptId as top-level Department field        */
    /* ------------------------------------------------------------------ */

    describe('Department interface — summaryPromptId (QA-004)', () => {
        it('should accept summaryPromptId as a top-level field when returned by API', async () => {
            const dept = {
                id: 'd-1',
                name: 'Neurology',
                code: 'NEUR',
                summaryPromptId: 'sp-abc',
                newPatientPromptId: 'np-def',
                revisitPromptId: 'rv-ghi',
                defaultDnaStyleId: 'dna-xyz',
            };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: any;
            await act(async () => { resp = await result.current.get('d-1'); });

            expect(resp.summaryPromptId).toBe('sp-abc');
            expect(result.current.currentDepartment?.summaryPromptId).toBe('sp-abc');
        });

        it('should handle department with all prompt fields null', async () => {
            const dept = {
                id: 'd-2',
                name: 'Emergency',
                code: 'EM',
                summaryPromptId: null,
                newPatientPromptId: null,
                revisitPromptId: null,
                defaultDnaStyleId: null,
            };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: any;
            await act(async () => { resp = await result.current.get('d-2'); });

            expect(resp.summaryPromptId).toBeNull();
            expect(resp.newPatientPromptId).toBeNull();
        });

        it('should handle department with only summaryPromptId set', async () => {
            const dept = { id: 'd-3', name: 'Surgery', code: 'SURG', summaryPromptId: 'sp-only' };
            mockGet.mockResolvedValue(dept);
            const { result } = renderHook(() => useDepartments());

            let resp: any;
            await act(async () => { resp = await result.current.get('d-3'); });

            expect(resp.summaryPromptId).toBe('sp-only');
            expect(resp.newPatientPromptId).toBeUndefined();
        });

        it('should preserve summaryPromptId through list() call', async () => {
            const depts = [
                { id: 'd-1', name: 'Neuro', code: 'N', summaryPromptId: 'sp-1' },
                { id: 'd-2', name: 'Cardio', code: 'C', summaryPromptId: null },
            ];
            mockGet.mockResolvedValue(depts);
            const { result } = renderHook(() => useDepartments());

            await act(async () => { await result.current.list(); });

            expect(result.current.departments[0].summaryPromptId).toBe('sp-1');
            expect(result.current.departments[1].summaryPromptId).toBeNull();
        });

        it('should update summaryPromptId via update()', async () => {
            const updated = { id: 'd-1', name: 'Neuro', code: 'N', summaryPromptId: 'sp-new' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => useDepartments());

            let resp: any;
            await act(async () => {
                resp = await result.current.update('d-1', { summaryPromptId: 'sp-new' });
            });

            expect(resp.summaryPromptId).toBe('sp-new');
            expect(mockPatch).toHaveBeenCalledWith(
                DEPARTMENT_ENDPOINTS.UPDATE('d-1'),
                { summaryPromptId: 'sp-new' },
            );
        });
    });
});
