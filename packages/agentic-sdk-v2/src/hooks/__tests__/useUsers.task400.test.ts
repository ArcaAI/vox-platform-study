/**
 * useUsers Hook — TASK-400 addition: public self-service forgot-password
 * (`requestPasswordReset`). The endpoint always answers 202 with a generic
 * body; the SDK method simply relays it (no token ever crosses this boundary).
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

describe('useUsers — TASK-400 requestPasswordReset', () => {
    let mockStore: any;
    const mockPost = vi.fn();

    beforeEach(() => {
        mockPost.mockReset();
        mockStore = {
            apiClient: { get: vi.fn(), post: mockPost, patch: vi.fn(), delete: vi.fn(), getBlob: vi.fn() },
            logger: createMockLogger(),
        };
        (useAgenticStore as any).mockReturnValue(mockStore);
    });

    afterEach(() => { vi.clearAllMocks(); });

    it('POSTs the email to the public forgot-password endpoint and returns the generic ack', async () => {
        const ack = { success: true, message: 'If an account exists for that email, a password reset link has been sent.' };
        mockPost.mockResolvedValue(ack);
        const { result } = renderHook(() => useUsers());

        let resp: unknown;
        await act(async () => {
            resp = await result.current.requestPasswordReset({ email: 'doc@example.com' });
        });

        expect(USER_ENDPOINTS.FORGOT_PASSWORD).toBe('/auth/forgot-password');
        expect(mockPost).toHaveBeenCalledWith(USER_ENDPOINTS.FORGOT_PASSWORD, { email: 'doc@example.com' });
        expect(resp).toEqual(ack);
    });

    it('throws when apiClient is null (SDK not initialized)', async () => {
        mockStore.apiClient = null;
        (useAgenticStore as any).mockReturnValue(mockStore);
        const { result } = renderHook(() => useUsers());

        await expect(act(async () => { await result.current.requestPasswordReset({ email: 'x@example.com' }); })).rejects.toThrow('SDK not initialized');
    });
});
