/**
 * useUsers Hook — bulk `assign-role` action.
 *
 * The server arm fans the single-user role assignment out over `ids`; the SDK
 * delta is purely additive — `assign-role` joins the `BulkUserActionType`
 * union and the input carries `roleId`. These tests pin the payload contract
 * (and the type-level union via the typed literal below, enforced by
 * `pnpm type-check`).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers, type BulkUserActionInput } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../../store/agenticStore')>();
    return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUsers — TASK-398 bulk assign-role', () => {
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

    it('POSTs an assign-role action with ids + roleId and returns per-item results', async () => {
        const response = {
            action: 'assign-role',
            total: 2,
            succeeded: 1,
            failed: 1,
            results: [
                { id: 'u-1', success: true },
                { id: 'u-2', success: false, error: 'User not found' },
            ],
        };
        mockPost.mockResolvedValue(response);
        const { result } = renderHook(() => useUsers());

        // Typed literal — proves `assign-role` + `roleId` are part of the union
        // (a type-check failure here is the SDK RED).
        const input: BulkUserActionInput = { action: 'assign-role', ids: ['u-1', 'u-2'], roleId: 'r-9' };

        let resp: unknown;
        await act(async () => {
            resp = await result.current.bulkAction(input);
        });

        expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.BULK_ACTIONS, {
            action: 'assign-role',
            ids: ['u-1', 'u-2'],
            roleId: 'r-9',
        });
        expect(resp).toEqual(response);
    });
});
