/**
 * useAuth — impersonation guards
 *
 * F-3: `impersonate(targetUserId, targetTenantId?)` must forward the selected
 *      tenant to `POST /auth/impersonate` so a super admin's chosen tenant is
 *      honoured (the backend otherwise picks the target's oldest assignment).
 *      `targetTenantId` is included ONLY when provided.
 * F-9: the impersonate response `user.departmentId` must survive into the SDK
 *      store (`setImpersonatedUser`) so the provider's department cascade can
 *      resolve the impersonated doctor's department tier.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAuth } from '../useAuth';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';
import { AUTH_ENDPOINTS } from '../../core/constants';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAuth — doc-05 impersonate(targetTenantId) + departmentId', () => {
  let mockStore: any;
  const mockPost = vi.fn();

  beforeEach(() => {
    mockPost.mockReset();
    mockStore = {
      apiClient: {
        post: mockPost,
        getAccessToken: vi.fn().mockReturnValue('admin-jwt'),
        updateAccessToken: vi.fn(),
        startImpersonation: vi.fn(),
        stopImpersonation: vi.fn(),
        isImpersonating: vi.fn().mockReturnValue(false),
      },
      logger: createMockLogger(),
      authUser: { id: 'admin-1' },
      authIsAuthenticated: true,
      authImpersonatedUser: null as unknown,
      authOriginalUser: null as unknown,
      personalizationManager: { setImpersonationReadOnly: vi.fn() },
      setAuthUser: vi.fn(),
      setIsAuthenticated: vi.fn(),
      setImpersonatedUser: vi.fn(),
      setOriginalUser: vi.fn(),
    };
    (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => mockStore);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('F-3: forwards targetTenantId in the POST body when provided', async () => {
    mockPost.mockResolvedValue({
      user: { id: 'u-target', username: 't', email: 't@e.com', roles: ['DOCTOR'], permissions: [], tenantId: 'tenant-x' },
      token: 'imp-jwt',
      impersonatedBy: 'admin-1',
    });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.impersonate('u-target', 'tenant-x');
    });

    expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.IMPERSONATE, {
      targetUserId: 'u-target',
      targetTenantId: 'tenant-x',
    });
  });

  it('F-3: omits targetTenantId when not provided', async () => {
    mockPost.mockResolvedValue({
      user: { id: 'u-target', username: 't', email: 't@e.com', roles: ['DOCTOR'], permissions: [] },
      token: 'imp-jwt',
      impersonatedBy: 'admin-1',
    });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.impersonate('u-target');
    });

    expect(mockPost).toHaveBeenCalledWith(AUTH_ENDPOINTS.IMPERSONATE, { targetUserId: 'u-target' });
    const [, body] = mockPost.mock.calls[0];
    expect('targetTenantId' in body).toBe(false);
  });

  it('F-9: departmentId from the impersonate response survives into the store', async () => {
    mockPost.mockResolvedValue({
      user: {
        id: 'u-target',
        username: 't',
        email: 't@e.com',
        roles: ['DOCTOR'],
        permissions: [],
        tenantId: 'tenant-x',
        departmentId: 'dept-77',
      },
      token: 'imp-jwt',
      impersonatedBy: 'admin-1',
    });

    const { result } = renderHook(() => useAuth());
    await act(async () => {
      await result.current.impersonate('u-target', 'tenant-x');
    });

    expect(mockStore.setImpersonatedUser).toHaveBeenCalledWith(expect.objectContaining({ departmentId: 'dept-77' }));
  });
});
