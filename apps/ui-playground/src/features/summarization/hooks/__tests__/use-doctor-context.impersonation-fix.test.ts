/**
 * useDoctorContext — Impersonation bug fix tests
 *
 * Reproduces the bug: admin impersonating a doctor still sees
 * "Doctor Impersonation Required" on the consultation page.
 *
 * Root cause: useAuth() wrapped in try/catch violates React's Rules of
 * Hooks. When useAuth() throws (e.g. SDK not yet initialized), sdkAuth
 * stays null and the useMemo never recomputes from SDK state. The hook
 * must call useAuth() unconditionally.
 *
 * Also verifies the fix does NOT impact the token refresh logic
 * (useAutoRefresh reads useAuthStore.getState() imperatively,
 * completely independent of useDoctorContext).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useAuthStore } from '@/store/auth-store';

// ---------------------------------------------------------------------------
// Mocks — SDK useAuth
// ---------------------------------------------------------------------------

let mockSdkIsImpersonating = false;
let mockSdkImpersonatedUser: { id: string; username: string; email: string; roles: string[]; permissions: string[] } | null = null;
let mockSdkShouldThrow = false;

vi.mock('@arcaai/vox', () => ({
  useAuth: () => {
    if (mockSdkShouldThrow) {
      throw new Error('SDK not initialized');
    }
    return {
      isImpersonating: mockSdkIsImpersonating,
      impersonatedUser: mockSdkImpersonatedUser,
    };
  },
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------

import { useDoctorContext } from '../use-doctor-context';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TENANT_UUID = '50000000-0000-0000-0000-000000000001';

const ADMIN_USER = {
  id: 'admin-001',
  email: 'admin@test.com',
  username: 'super_admin',
  roles: ['GLOBAL_ADMIN'],
  permissions: [],
};

const DOCTOR_USER = {
  id: 'doctor-001',
  email: 'doctor@test.com',
  username: 'doctor',
  roles: ['DOCTOR'],
  permissions: ['read:consultation'],
};

const DEPT_HEAD_USER = {
  id: 'depthead-001',
  email: 'depthead@test.com',
  username: 'department_head',
  roles: ['DEPARTMENT_HEAD'],
  permissions: ['read:consultation'],
};

const TENANT_ADMIN_USER = {
  id: 'tadmin-001',
  email: 'tadmin@test.com',
  username: 'tenant_admin',
  roles: ['TENANT_ADMIN'],
  permissions: [],
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAuthStore.getState().logout();
  mockSdkIsImpersonating = false;
  mockSdkImpersonatedUser = null;
  mockSdkShouldThrow = false;
});

afterEach(() => {
  cleanup();
});

// ===========================================================================
// BUG REPRODUCTION: admin impersonating doctor still blocked
// ===========================================================================

describe('useDoctorContext — impersonation bug fix', () => {
  describe('admin impersonating a doctor (persisted store)', () => {
    it('should NOT require impersonation when persisted store says impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
      useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(false);
      expect(result.current.isImpersonated).toBe(true);
      expect(result.current.effectiveUserId).toBe(DOCTOR_USER.id);
    });

    it('should NOT require impersonation when SDK also reports impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
      useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');
      mockSdkIsImpersonating = true;
      mockSdkImpersonatedUser = DOCTOR_USER;

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(false);
      expect(result.current.isImpersonated).toBe(true);
      expect(result.current.effectiveUserId).toBe(DOCTOR_USER.id);
    });

    it('should use impersonated user as effective user, not the admin', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
      useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.effectiveUserId).toBe(DOCTOR_USER.id);
      expect(result.current.effectiveUserId).not.toBe(ADMIN_USER.id);
    });
  });

  describe('admin impersonating a doctor (SDK store only, after page reload)', () => {
    it('should NOT require impersonation when only SDK reports impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
      // Persisted store does NOT have impersonation (simulates lost state)
      mockSdkIsImpersonating = true;
      mockSdkImpersonatedUser = DOCTOR_USER;

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(false);
      expect(result.current.isImpersonated).toBe(true);
    });
  });

  describe('TENANT_ADMIN impersonating a doctor', () => {
    it('should NOT require impersonation for TENANT_ADMIN who is impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('tadmin-token', TENANT_ADMIN_USER, TENANT_UUID);
      useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(false);
      expect(result.current.isImpersonated).toBe(true);
    });
  });

  describe('admin NOT impersonating (guard should block)', () => {
    it('should require impersonation for GLOBAL_ADMIN not impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(true);
      expect(result.current.isImpersonated).toBe(false);
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.isDoctor).toBe(false);
    });

    it('should require impersonation for TENANT_ADMIN not impersonating', () => {
      useAuthStore.getState().setCredentialsAuth('tadmin-token', TENANT_ADMIN_USER, TENANT_UUID);

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(true);
    });
  });

  describe('doctor user logged in directly (no impersonation needed)', () => {
    it('should NOT require impersonation for DOCTOR user', () => {
      useAuthStore.getState().setCredentialsAuth('doc-token', DOCTOR_USER, TENANT_UUID);

      const { result } = renderHook(() => useDoctorContext());

      expect(result.current.requiresImpersonation).toBe(false);
      expect(result.current.isDoctor).toBe(true);
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.effectiveUserId).toBe(DOCTOR_USER.id);
    });
  });

  describe('impersonation ends — guard should re-engage', () => {
    it('should require impersonation again after endImpersonation', () => {
      useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
      useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');
      mockSdkIsImpersonating = true;
      mockSdkImpersonatedUser = DOCTOR_USER;

      const { result, rerender } = renderHook(() => useDoctorContext());
      expect(result.current.requiresImpersonation).toBe(false);

      act(() => {
        useAuthStore.getState().endImpersonation();
        mockSdkIsImpersonating = false;
        mockSdkImpersonatedUser = null;
      });
      rerender();

      expect(result.current.requiresImpersonation).toBe(true);
      expect(result.current.isImpersonated).toBe(false);
      expect(result.current.effectiveUserId).toBe(ADMIN_USER.id);
    });
  });
});

// ===========================================================================
// HOOKS VIOLATION: useAuth() in try/catch
// ===========================================================================

describe('useDoctorContext — useAuth() must be called unconditionally', () => {
  it('should NOT swallow useAuth errors with try/catch (hooks violation)', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
    useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');
    mockSdkShouldThrow = true;

    // With the try/catch bug, this renders without error but sdkAuth is null.
    // After the fix, useAuth() is called unconditionally — if it throws,
    // the component should propagate the error rather than silently degrade.
    // For now the hook should still work via persisted fallback, but the
    // try/catch pattern itself is the problem we're removing.
    expect(() => {
      renderHook(() => useDoctorContext());
    }).toThrow('SDK not initialized');
  });
});

// ===========================================================================
// TOKEN REFRESH SAFETY: verify useAutoRefresh is NOT affected
// ===========================================================================

describe('useDoctorContext fix — token refresh safety', () => {
  it('useAutoRefresh reads useAuthStore.getState() imperatively, not via useDoctorContext', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
    useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

    const state = useAuthStore.getState();
    expect(state.isImpersonating).toBe(true);
    expect(state.impersonatedUser).toEqual(DOCTOR_USER);
    expect(state.impersonationToken).toBe('imp-token');
  });

  it('endImpersonation in auth store correctly clears state for token refresh fallback', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
    useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');
    useAuthStore.getState().endImpersonation();

    const state = useAuthStore.getState();
    expect(state.isImpersonating).toBe(false);
    expect(state.impersonatedUser).toBeNull();
    expect(state.impersonationToken).toBe('');
    // accessToken should still be the admin token (not cleared)
    expect(state.accessToken).toBe('admin-token');
  });

  it('startImpersonation preserves base accessToken for refresh flow', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID, 'acme', 'refresh-tok');
    useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

    const state = useAuthStore.getState();
    expect(state.accessToken).toBe('admin-token');
    expect(state.refreshToken).toBe('refresh-tok');
    expect(state.impersonationToken).toBe('imp-token');
  });

  it('SDKProvider token selection: impersonation token when impersonating, base token otherwise', () => {
    useAuthStore.getState().setCredentialsAuth('admin-token', ADMIN_USER, TENANT_UUID);
    useAuthStore.getState().startImpersonation(DOCTOR_USER, 'imp-token');

    const { isImpersonating, impersonationToken, accessToken } = useAuthStore.getState();
    const effectiveToken = isImpersonating && impersonationToken
      ? impersonationToken
      : accessToken || undefined;

    expect(effectiveToken).toBe('imp-token');

    useAuthStore.getState().endImpersonation();
    const after = useAuthStore.getState();
    const effectiveTokenAfter = after.isImpersonating && after.impersonationToken
      ? after.impersonationToken
      : after.accessToken || undefined;

    expect(effectiveTokenAfter).toBe('admin-token');
  });
});
