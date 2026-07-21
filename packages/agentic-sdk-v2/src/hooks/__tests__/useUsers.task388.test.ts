/**
 * useUsers Hook — additions: reset-password #8, bulk actions #9,
 * server-side export #10.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUsers — TASK-388', () => {
    let mockLogger: ReturnType<typeof createMockLogger>;
    let mockStore: any;
    const mockGet = vi.fn();
    const mockPost = vi.fn();
    const mockPatch = vi.fn();
    const mockDelete = vi.fn();
    const mockGetBlob = vi.fn();

    beforeEach(() => {
        mockLogger = createMockLogger();
        mockGet.mockReset();
        mockPost.mockReset();
        mockPatch.mockReset();
        mockDelete.mockReset();
        mockGetBlob.mockReset();

        mockStore = {
            apiClient: { get: mockGet, post: mockPost, patch: mockPatch, delete: mockDelete, getBlob: mockGetBlob },
            logger: mockLogger,
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    // #8 -------------------------------------------------------------------
    describe('resetPassword (#8)', () => {
        it('POSTs the temporary-password flow and returns the plaintext', async () => {
            const payload = { mode: 'temporary', temporaryPassword: 'Temp1234' };
            mockPost.mockResolvedValue(payload);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.resetPassword('u-1', { mode: 'temporary' }); });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.RESET_PASSWORD('u-1'), { mode: 'temporary' });
            expect(resp).toEqual(payload);
        });

        it('defaults to the link flow when no input is given', async () => {
            mockPost.mockResolvedValue({ mode: 'link', token: 'tok', resetPath: '/reset-password?token=tok', emailSent: false });
            const { result } = renderHook(() => useUsers());

            await act(async () => { await result.current.resetPassword('u-1'); });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.RESET_PASSWORD('u-1'), {});
        });

        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(act(async () => { await result.current.resetPassword('u-1'); })).rejects.toThrow('SDK not initialized');
        });
    });

    describe('completePasswordReset (#8)', () => {
        it('POSTs the token + new password to the public completion endpoint', async () => {
            mockPost.mockResolvedValue({ success: true });
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.completePasswordReset({ token: 'tok', newPassword: 'BrandNewPass1' });
            });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.PASSWORD_RESET_COMPLETE, {
                token: 'tok',
                newPassword: 'BrandNewPass1',
            });
            expect(resp).toEqual({ success: true });
        });
    });

    // #9 -------------------------------------------------------------------
    describe('bulkAction (#9)', () => {
        it('POSTs a disable action with ids and returns per-item results', async () => {
            const response = {
                action: 'disable',
                total: 2,
                succeeded: 2,
                failed: 0,
                results: [
                    { id: 'u-1', success: true },
                    { id: 'u-2', success: true },
                ],
            };
            mockPost.mockResolvedValue(response);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => {
                resp = await result.current.bulkAction({ action: 'disable', ids: ['u-1', 'u-2'] });
            });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.BULK_ACTIONS, { action: 'disable', ids: ['u-1', 'u-2'] });
            expect(resp).toEqual(response);
        });

        it('forwards assign-departments payload fields', async () => {
            mockPost.mockResolvedValue({ action: 'assign-departments', total: 1, succeeded: 1, failed: 0, results: [{ id: 'u-1', success: true }] });
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                await result.current.bulkAction({
                    action: 'assign-departments',
                    ids: ['u-1'],
                    departmentIds: ['d-1', 'd-2'],
                    primaryDepartmentId: 'd-1',
                });
            });

            expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.BULK_ACTIONS, {
                action: 'assign-departments',
                ids: ['u-1'],
                departmentIds: ['d-1', 'd-2'],
                primaryDepartmentId: 'd-1',
            });
        });

        it('throws when apiClient is null', async () => {
            mockStore.apiClient = null;
            (useAgenticStore as any).mockReturnValue(mockStore);
            const { result } = renderHook(() => useUsers());

            await expect(
                act(async () => { await result.current.bulkAction({ action: 'disable', ids: ['u-1'] }); }),
            ).rejects.toThrow('SDK not initialized');
        });
    });

    // #10 ------------------------------------------------------------------
    describe('exportUsers (#10)', () => {
        it('GETs the export endpoint with format=xlsx and returns a Blob', async () => {
            const blob = new Blob(['x'], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            mockGetBlob.mockResolvedValue(blob);
            const { result } = renderHook(() => useUsers());

            let resp: unknown;
            await act(async () => { resp = await result.current.exportUsers({ format: 'xlsx' }); });

            expect(mockGetBlob).toHaveBeenCalledWith(`${USER_ENDPOINTS.EXPORT}?format=xlsx`);
            expect(resp).toBe(blob);
        });

        it('passes through paginated-query filters (search/filters/sort) and format=pdf', async () => {
            const blob = new Blob(['%PDF'], { type: 'application/pdf' });
            mockGetBlob.mockResolvedValue(blob);
            const { result } = renderHook(() => useUsers());

            await act(async () => {
                await result.current.exportUsers({ format: 'pdf', search: 'jo', filters: 'resourceStatus:ENABLED', sort: 'username:asc' });
            });

            const calledUrl = mockGetBlob.mock.calls[0][0] as string;
            expect(calledUrl.startsWith(USER_ENDPOINTS.EXPORT)).toBe(true);
            expect(calledUrl).toContain('format=pdf');
            expect(calledUrl).toContain('search=jo');
            expect(calledUrl).toContain('filters=resourceStatus%3AENABLED');
            expect(calledUrl).toContain('sort=username%3Aasc');
        });
    });
});
