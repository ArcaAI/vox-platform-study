/**
 * canImpersonate derived permission
 *
 * Tests that useAuth exposes `canImpersonate: boolean` derived from user roles.
 * Only GLOBAL_ADMIN and TENANT_ADMIN return true.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAuth } from '../useAuth';
import { useAgenticStore } from '../../store/agenticStore';
import { createMockLogger } from '../../__tests__/setup';

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

describe('useAuth canImpersonate', () => {
  let mockStore: any;

  function buildStore(authUser: any) {
    return {
      apiClient: {
        get: vi.fn(),
        post: vi.fn(),
        patch: vi.fn(),
        delete: vi.fn(),
        updateAccessToken: vi.fn(),
        clearAccessToken: vi.fn(),
        getAccessToken: vi.fn(),
        updateApiKey: vi.fn(),
        clearApiKey: vi.fn(),
        getApiKey: vi.fn(),
        getBaseUrl: vi.fn().mockReturnValue('https://api.test'),
        postFormData: vi.fn(),
        startImpersonation: vi.fn(),
        stopImpersonation: vi.fn(),
        isImpersonating: vi.fn().mockReturnValue(false),
      },
      logger: createMockLogger(),
      authUser,
      authIsAuthenticated: authUser !== null,
      authImpersonatedUser: null,
      // NOTE: `authOriginalToken` removed from store.
      authOriginalUser: null,
      setAuthUser: vi.fn(),
      setIsAuthenticated: vi.fn(),
      setImpersonatedUser: vi.fn(),
      setOriginalUser: vi.fn(),
    };
  }

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return canImpersonate: true for user with GLOBAL_ADMIN role', () => {
    mockStore = buildStore({
      id: 'u-1',
      username: 'super',
      email: 's@a.com',
      roles: ['GLOBAL_ADMIN'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(true);
  });

  it('should return canImpersonate: true for user with TENANT_ADMIN role', () => {
    mockStore = buildStore({
      id: 'u-2',
      username: 'tenant_admin',
      email: 'ta@a.com',
      roles: ['TENANT_ADMIN'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(true);
  });

  it('should return canImpersonate: true when user has GLOBAL_ADMIN among other roles', () => {
    mockStore = buildStore({
      id: 'u-3',
      username: 'multi_role',
      email: 'm@a.com',
      roles: ['doctor', 'GLOBAL_ADMIN', 'reviewer'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(true);
  });

  it('should return canImpersonate: false for user with admin role (lowercase)', () => {
    mockStore = buildStore({
      id: 'u-4',
      username: 'admin_user',
      email: 'a@a.com',
      roles: ['admin'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(false);
  });

  it('should return canImpersonate: false for user with system-admin role', () => {
    mockStore = buildStore({
      id: 'u-5',
      username: 'sys_admin',
      email: 'sa@a.com',
      roles: ['system-admin'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(false);
  });

  it('should return canImpersonate: false for regular doctor role', () => {
    mockStore = buildStore({
      id: 'u-6',
      username: 'dr_smith',
      email: 'd@a.com',
      roles: ['doctor'],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(false);
  });

  it('should return canImpersonate: false for user with empty roles', () => {
    mockStore = buildStore({
      id: 'u-7',
      username: 'no_roles',
      email: 'n@a.com',
      roles: [],
      permissions: [],
    });
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(false);
  });

  it('should return canImpersonate: false when user is null (unauthenticated)', () => {
    mockStore = buildStore(null);
    (useAgenticStore as any).mockReturnValue(mockStore);

    const { result } = renderHook(() => useAuth());
    expect(result.current.canImpersonate).toBe(false);
  });
});
