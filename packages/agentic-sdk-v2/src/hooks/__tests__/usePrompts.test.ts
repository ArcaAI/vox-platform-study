/**
 * usePrompts Hook Tests (SDK-207 WS-5)
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePrompts } from '../usePrompts';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { PROMPT_TEMPLATE_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('usePrompts', () => {
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

    describe('initial state', () => {
        it('should return empty prompts and null currentPrompt', () => {
            const { result } = renderHook(() => usePrompts());
            expect(result.current.prompts).toEqual([]);
            expect(result.current.currentPrompt).toBeNull();
            expect(result.current.isLoading).toBe(false);
            expect(result.current.error).toBeNull();
        });
    });

    describe('create', () => {
        it('should POST to PROMPT_TEMPLATE_ENDPOINTS.CREATE and add to state', async () => {
            const template = { id: 'pt-1', name: 'Test', category: 'CUSTOM', content: 'Hello', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockPost.mockResolvedValue(template);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.create({ name: 'Test', category: 'CUSTOM', content: 'Hello' });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.CREATE, { name: 'Test', category: 'CUSTOM', content: 'Hello' });
            expect(result.current.prompts).toContainEqual(template);
            expect(resp).toEqual(template);
        });

        it('should set error on failure', async () => {
            mockPost.mockRejectedValue(new Error('Create failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.create({ name: 'Test', category: 'CUSTOM', content: 'Hello' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Create failed');
        });
    });

    describe('list', () => {
        it('should GET from PROMPT_TEMPLATE_ENDPOINTS.LIST', async () => {
            const templates = [{ id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'c', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' }];
            mockGet.mockResolvedValue(templates);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });

            expect(mockGet).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.LIST);
            expect(result.current.prompts).toEqual(templates);
        });

        it('should append query params for filters', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ category: 'SYSTEM' }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('category=SYSTEM'));
        });

        it('should extract array from paginated wrapper response', async () => {
            const templates = [{ id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'c', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' }];
            mockGet.mockResolvedValue({ data: templates, count: 1, page: 1, limit: 10 });
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });

            expect(result.current.prompts).toEqual(templates);
            expect(Array.isArray(result.current.prompts)).toBe(true);
        });

        it('should return empty array for unexpected list response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });

            expect(result.current.prompts).toEqual([]);
        });
    });

    describe('get', () => {
        it('should GET from PROMPT_TEMPLATE_ENDPOINTS.GET(id)', async () => {
            const template = { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'c', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValue(template);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.get('pt-1'); });

            expect(mockGet).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.GET('pt-1'));
            expect(result.current.currentPrompt).toEqual(template);
            expect(resp).toEqual(template);
        });
    });

    describe('update', () => {
        it('should PATCH to PROMPT_TEMPLATE_ENDPOINTS.UPDATE(id)', async () => {
            const updated = { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'updated', tags: [], currentVersionNumber: 2, createdAt: '', updatedAt: '' };
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.update('pt-1', { content: 'updated', changeReason: 'Fix typo' }); });

            expect(mockPatch).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.UPDATE('pt-1'), { content: 'updated', changeReason: 'Fix typo' });
        });
    });

    describe('remove', () => {
        it('should DELETE to PROMPT_TEMPLATE_ENDPOINTS.DELETE(id)', async () => {
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.remove('pt-1'); });

            expect(mockDelete).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.DELETE('pt-1'));
        });
    });

    describe('getVersions', () => {
        it('should GET from PROMPT_TEMPLATE_ENDPOINTS.VERSIONS(id)', async () => {
            const versions = [
                { id: 'pv-1', promptTemplateId: 'pt-1', versionNumber: 1, content: 'v1', createdAt: '' },
            ];
            mockGet.mockResolvedValue(versions);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.getVersions('pt-1'); });

            expect(mockGet).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.VERSIONS('pt-1'));
            expect(resp).toEqual(versions);
        });

        it('should extract array from paginated wrapper response', async () => {
            const versions = [
                { id: 'pv-1', promptTemplateId: 'pt-1', versionNumber: 1, content: 'v1', createdAt: '' },
            ];
            mockGet.mockResolvedValue({ data: versions, count: 1 });
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.getVersions('pt-1'); });

            expect(resp).toEqual(versions);
            expect(Array.isArray(resp)).toBe(true);
        });

        it('should return empty array for unexpected response shape', async () => {
            mockGet.mockResolvedValue({ message: 'none' });
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.getVersions('pt-1'); });

            expect(resp).toEqual([]);
        });
    });

    describe('assignToDepartment', () => {
        it('should POST to PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.assignToDepartment({ departmentId: 'dept-1', promptTemplateId: 'pt-1', field: 'newPatientPromptId' });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, { departmentId: 'dept-1', promptTemplateId: 'pt-1', field: 'newPatientPromptId' });
        });
    });

    describe('compareVersions', () => {
        it('should fetch two versions and return diff result', async () => {
            mockGet
                .mockResolvedValueOnce({ content: 'old prompt content' })
                .mockResolvedValueOnce({ content: 'new prompt content' });
            const { result } = renderHook(() => usePrompts());

            let diff: unknown;
            await act(async () => {
                diff = await result.current.compareVersions('pt-1', 1, 2);
            });

            expect(mockGet).toHaveBeenCalledTimes(2);
            expect((diff as any).changes).toBeDefined();
            expect((diff as any).stats).toBeDefined();
        });
    });

    describe('list edge cases', () => {
        it('should append departmentId query param', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ departmentId: 'dept-1' }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('departmentId=dept-1'));
        });

        it('should append tags query param', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ tags: ['tag1', 'tag2'] }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('tags=tag1%2Ctag2'));
        });

        it('should append all filter params when multiple filters provided', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.list({ category: 'SYSTEM', departmentId: 'dept-1', tags: ['a', 'b'] });
            });

            const url = mockGet.mock.calls[0][0];
            expect(url).toContain('category=SYSTEM');
            expect(url).toContain('departmentId=dept-1');
            expect(url).toContain('tags=');
        });

        it('should call base URL without query params when filters is empty object', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({}); });

            expect(mockGet).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.LIST);
        });

        it('should set error and reset isLoading on failure', async () => {
            mockGet.mockRejectedValue(new Error('List failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('List failed');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('get edge cases', () => {
        it('should set error and reset isLoading on failure', async () => {
            mockGet.mockRejectedValue(new Error('Get failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.get('pt-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Get failed');
            expect(result.current.isLoading).toBe(false);
        });
    });

    describe('update edge cases', () => {
        it('should set error and reset isLoading on failure', async () => {
            mockPatch.mockRejectedValue(new Error('Update failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.update('pt-1', { content: 'x', changeReason: 'r' }); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Update failed');
            expect(result.current.isLoading).toBe(false);
        });

        it('should replace matching prompt in array after list()', async () => {
            const templates = [
                { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'old', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' },
                { id: 'pt-2', name: 'T2', category: 'CUSTOM', content: 'c2', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' },
            ];
            const updated = { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'updated', tags: [], currentVersionNumber: 2, createdAt: '', updatedAt: '' };
            mockGet.mockResolvedValue(templates);
            mockPatch.mockResolvedValue(updated);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });
            expect(result.current.prompts).toHaveLength(2);

            await act(async () => { await result.current.update('pt-1', { content: 'updated', changeReason: 'Edit' }); });

            expect(result.current.prompts).toHaveLength(2);
            expect(result.current.prompts.find(p => p.id === 'pt-1')).toEqual(updated);
            expect(result.current.prompts.find(p => p.id === 'pt-2')).toEqual(templates[1]);
        });
    });

    describe('remove edge cases', () => {
        it('should set error and reset isLoading on failure', async () => {
            mockDelete.mockRejectedValue(new Error('Remove failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.remove('pt-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Remove failed');
            expect(result.current.isLoading).toBe(false);
        });

        it('should filter out removed prompt from array after list()', async () => {
            const templates = [
                { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'c1', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' },
                { id: 'pt-2', name: 'T2', category: 'CUSTOM', content: 'c2', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' },
            ];
            mockGet.mockResolvedValue(templates);
            mockDelete.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });
            expect(result.current.prompts).toHaveLength(2);

            await act(async () => { await result.current.remove('pt-1'); });

            expect(result.current.prompts).toHaveLength(1);
            expect(result.current.prompts[0].id).toBe('pt-2');
        });
    });

    describe('getVersions edge cases', () => {
        it('should propagate error and set error state on failure', async () => {
            mockGet.mockRejectedValue(new Error('Versions failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.getVersions('pt-1'); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Versions failed');
        });
    });

    describe('assignToDepartment edge cases', () => {
        it('should set error on failure', async () => {
            mockPost.mockRejectedValue(new Error('Assign failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try {
                    await result.current.assignToDepartment({ departmentId: 'dept-1', promptTemplateId: 'pt-1', field: 'newPatientPromptId' });
                } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Assign failed');
        });
    });

    describe('compareVersions edge cases', () => {
        it('should throw on failure (no setError)', async () => {
            mockGet.mockRejectedValue(new Error('Compare failed'));
            const { result } = renderHook(() => usePrompts());

            await expect(
                act(async () => { await result.current.compareVersions('pt-1', 1, 2); })
            ).rejects.toThrow('Compare failed');
        });
    });

    describe('SDK not initialized', () => {
        beforeEach(() => {
            mockStore = { ...mockStore, apiClient: null };
            (useAgenticStore as any).mockReturnValue(mockStore);
        });

        it('list should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.list(); })).rejects.toThrow('SDK not initialized');
        });

        it('get should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.get('pt-1'); })).rejects.toThrow('SDK not initialized');
        });

        it('update should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.update('pt-1', { content: 'x', changeReason: 'r' }); })).rejects.toThrow('SDK not initialized');
        });

        it('remove should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.remove('pt-1'); })).rejects.toThrow('SDK not initialized');
        });

        it('getVersions should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.getVersions('pt-1'); })).rejects.toThrow('SDK not initialized');
        });

        it('assignToDepartment should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => {
                await result.current.assignToDepartment({ departmentId: 'dept-1', promptTemplateId: 'pt-1', field: 'newPatientPromptId' });
            })).rejects.toThrow('SDK not initialized');
        });

        it('compareVersions should throw', async () => {
            const { result } = renderHook(() => usePrompts());
            await expect(act(async () => { await result.current.compareVersions('pt-1', 1, 2); })).rejects.toThrow('SDK not initialized');
        });
    });

    describe('error clearing', () => {
        it('should clear previous error on successful call', async () => {
            mockGet.mockRejectedValueOnce(new Error('List failed')).mockResolvedValueOnce([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.list(); } catch { /* expected */ }
            });
            expect(result.current.error?.message).toBe('List failed');

            await act(async () => { await result.current.list(); });
            expect(result.current.error).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ */
    /*  TASK-218 Priority 8: getUsageStats                                 */
    /* ------------------------------------------------------------------ */

    describe('getUsageStats (TASK-218)', () => {
        it('should GET from PROMPT_TEMPLATE_ENDPOINTS.USAGE(id)', async () => {
            const stats = { totalUsages: 42, lastUsedAt: '2026-02-24T10:00:00Z' };
            mockGet.mockResolvedValue(stats);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUsageStats('pt-1'); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('pt-1/usage'));
            expect(resp).toEqual(stats);
        });

        it('should return zero usage for unused template', async () => {
            const stats = { totalUsages: 0, lastUsedAt: null };
            mockGet.mockResolvedValue(stats);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.getUsageStats('pt-unused'); });

            expect(resp).toEqual(stats);
        });
    });

    describe('null logger', () => {
        beforeEach(() => {
            mockStore = { ...mockStore, logger: null };
            (useAgenticStore as any).mockReturnValue(mockStore);
        });

        it('should work correctly when store.logger is null', async () => {
            const templates = [{ id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'c', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' }];
            mockGet.mockResolvedValue(templates);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });

            expect(result.current.prompts).toEqual(templates);
            expect(result.current.error).toBeNull();
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-004 Gap 4: name/search filter in list()                         */
    /* ------------------------------------------------------------------ */

    describe('list — name/search filter (QA-004)', () => {
        it('should append search query param when provided', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ search: 'summary' }); });

            expect(mockGet).toHaveBeenCalledWith(expect.stringContaining('search=summary'));
        });

        it('should append both search and category params', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.list({ search: 'neuro', category: 'SYSTEM' });
            });

            const url = mockGet.mock.calls[0][0];
            expect(url).toContain('search=neuro');
            expect(url).toContain('category=SYSTEM');
        });

        it('should not append search param when search is undefined', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ category: 'CUSTOM' }); });

            const url = mockGet.mock.calls[0][0];
            expect(url).not.toContain('search=');
            expect(url).toContain('category=CUSTOM');
        });

        it('should not append search param when search is empty string', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list({ search: '' }); });

            expect(mockGet).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.LIST);
        });

        it('should append search, category, departmentId, and tags together', async () => {
            mockGet.mockResolvedValue([]);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.list({
                    search: 'patient',
                    category: 'SUMMARY',
                    departmentId: 'dept-1',
                    tags: ['urgent'],
                });
            });

            const url = mockGet.mock.calls[0][0];
            expect(url).toContain('search=patient');
            expect(url).toContain('category=SUMMARY');
            expect(url).toContain('departmentId=dept-1');
            expect(url).toContain('tags=urgent');
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-004 Gap 3: AssignDepartmentPromptInput.field union type          */
    /* ------------------------------------------------------------------ */

    describe('assignToDepartment — field type coverage (QA-004)', () => {
        it('should accept summaryPromptId as a valid field', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.assignToDepartment({
                    departmentId: 'dept-1',
                    promptTemplateId: 'pt-1',
                    field: 'summaryPromptId',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, {
                departmentId: 'dept-1', promptTemplateId: 'pt-1', field: 'summaryPromptId',
            });
        });

        it('should accept preSummaryPromptId as a valid field', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.assignToDepartment({
                    departmentId: 'dept-2',
                    promptTemplateId: 'pt-2',
                    field: 'preSummaryPromptId',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, {
                departmentId: 'dept-2', promptTemplateId: 'pt-2', field: 'preSummaryPromptId',
            });
        });

        it('should accept revisitPromptId as a valid field', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.assignToDepartment({
                    departmentId: 'dept-3',
                    promptTemplateId: 'pt-3',
                    field: 'revisitPromptId',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, {
                departmentId: 'dept-3', promptTemplateId: 'pt-3', field: 'revisitPromptId',
            });
        });

        it('should accept newPatientPromptId as a valid field', async () => {
            mockPost.mockResolvedValue(undefined);
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                await result.current.assignToDepartment({
                    departmentId: 'dept-4',
                    promptTemplateId: 'pt-4',
                    field: 'newPatientPromptId',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ASSIGN_DEPARTMENT, {
                departmentId: 'dept-4', promptTemplateId: 'pt-4', field: 'newPatientPromptId',
            });
        });
    });

    /* ------------------------------------------------------------------ */
    /*  QA-004: activateVersion edge cases                                 */
    /* ------------------------------------------------------------------ */

    describe('activateVersion (QA-004)', () => {
        it('should POST to ACTIVATE_VERSION endpoint and update state', async () => {
            const activated = { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'v1-content', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' };
            mockPost.mockResolvedValue(activated);
            const { result } = renderHook(() => usePrompts());

            let resp: unknown;
            await act(async () => { resp = await result.current.activateVersion('pt-1', 1); });

            expect(mockPost).toHaveBeenCalledWith(PROMPT_TEMPLATE_ENDPOINTS.ACTIVATE_VERSION('pt-1', 1), {});
            expect(resp).toEqual(activated);
            expect(result.current.currentPrompt).toEqual(activated);
        });

        it('should replace matching prompt in array after activation', async () => {
            const templates = [
                { id: 'pt-1', name: 'T1', category: 'SYSTEM', content: 'v2', tags: [], currentVersionNumber: 2, createdAt: '', updatedAt: '' },
                { id: 'pt-2', name: 'T2', category: 'CUSTOM', content: 'c2', tags: [], currentVersionNumber: 1, createdAt: '', updatedAt: '' },
            ];
            const rolledBack = { ...templates[0], content: 'v1', currentVersionNumber: 1 };
            mockGet.mockResolvedValue(templates);
            mockPost.mockResolvedValue(rolledBack);
            const { result } = renderHook(() => usePrompts());

            await act(async () => { await result.current.list(); });
            await act(async () => { await result.current.activateVersion('pt-1', 1); });

            expect(result.current.prompts.find(p => p.id === 'pt-1')?.content).toBe('v1');
            expect(result.current.prompts.find(p => p.id === 'pt-2')).toEqual(templates[1]);
        });

        it('should set error on activation failure', async () => {
            mockPost.mockRejectedValue(new Error('Activate failed'));
            const { result } = renderHook(() => usePrompts());

            await act(async () => {
                try { await result.current.activateVersion('pt-1', 1); } catch { /* expected */ }
            });

            expect(result.current.error?.message).toBe('Activate failed');
            expect(result.current.isLoading).toBe(false);
        });

        it('should throw when SDK not initialized', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => usePrompts());

            await expect(
                act(async () => { await result.current.activateVersion('pt-1', 1); })
            ).rejects.toThrow('SDK not initialized');
        });
    });
});
