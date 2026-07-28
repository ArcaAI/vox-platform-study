/**
 * useUsers Hook — global-admin time-boxed impersonation
 * (`impersonate`) and early end (`endImpersonation`). Both are thin wrappers:
 * the ADMIN APP owns the token swap via its auth store, so the SDK never
 * stashes the impersonation token itself on this path.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUsers } from '../useUsers';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { USER_ENDPOINTS, AUTH_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useUsers — impersonate / endImpersonation', () => {
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

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('POSTs to /admin/users/:id/impersonate with the options body and returns the session payload', async () => {
    const payload = {
      user: { id: 'doctor-1', username: 'doctor', tenantId: 'tenant-1' },
      token: 'impersonation.jwt',
      impersonatedBy: 'admin-1',
      expiresAt: '2026-07-02T13:00:00.000Z',
      expiresInSeconds: 1800,
    };
    mockPost.mockResolvedValue(payload);
    const { result } = renderHook(() => useUsers());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.impersonate('doctor-1', { reason: 'support ticket #42' });
    });

    expect(USER_ENDPOINTS.IMPERSONATE('doctor-1')).toBe('/admin/users/doctor-1/impersonate');
    expect(mockPost).toHaveBeenCalledWith('/admin/users/doctor-1/impersonate', { reason: 'support ticket #42' });
    expect(resp).toEqual(payload);
  });

  it('defaults the body to {} and URL-encodes the user id', async () => {
    mockPost.mockResolvedValue({ user: { id: 'u/1' }, token: 't', impersonatedBy: 'a' });
    const { result } = renderHook(() => useUsers());

    await act(async () => {
      await result.current.impersonate('u/1');
    });

    expect(mockPost).toHaveBeenCalledWith('/admin/users/u%2F1/impersonate', {});
  });

  it('endImpersonation POSTs to the existing revoke endpoint', async () => {
    mockPost.mockResolvedValue({ success: true });
    const { result } = renderHook(() => useUsers());

    let resp: unknown;
    await act(async () => {
      resp = await result.current.endImpersonation();
    });

    expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.REVOKE_IMPERSONATION, {});
    expect(resp).toEqual({ success: true });
  });

  it('surfaces backend rejections (e.g. 403 safeguard) to the caller', async () => {
    mockPost.mockRejectedValue(new Error('Only global administrators can impersonate users'));
    const { result } = renderHook(() => useUsers());

    await expect(
      act(async () => {
        await result.current.impersonate('admin-2');
      }),
    ).rejects.toThrow('Only global administrators can impersonate users');
  });
});
