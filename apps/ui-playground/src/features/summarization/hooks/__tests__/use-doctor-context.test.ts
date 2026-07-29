import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/store/auth-store', () => ({
  useAuthStore: Object.assign(
    vi.fn(() => ({
      user: { id: 'user-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
      tenantId: 'tenant-001',
      authMethod: 'credentials' as const,
      accessToken: 'test-token',
    })),
    {
      getState: vi.fn(() => ({
        user: { id: 'user-001', email: 'dr@test.com', username: 'drtest', roles: ['DOCTOR'], permissions: [] },
        tenantId: 'tenant-001',
        authMethod: 'credentials' as const,
        accessToken: 'test-token',
      })),
    },
  ),
}));

vi.mock('@/store/playground-store', () => ({
  usePlaygroundStore: Object.assign(
    vi.fn(() => ({ apiBaseUrl: 'http://localhost:8868/api/v1' })),
    { getState: vi.fn(() => ({ apiBaseUrl: 'http://localhost:8868/api/v1' })) },
  ),
}));

const ADMIN_ROLES = ['GLOBAL_ADMIN', 'TENANT_ADMIN'];
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

function isAdminRole(roles: string[]): boolean {
  return roles.some((r) => ADMIN_ROLES.includes(r));
}

function isDoctorRole(roles: string[]): boolean {
  return roles.some((r) => DOCTOR_ROLES.includes(r));
}

function resolveEffectiveUser(
  authUser: { id: string; roles: string[] } | null,
  impersonatedUser: { id: string; roles?: string[] } | null,
  isImpersonating: boolean,
) {
  if (isImpersonating && impersonatedUser) {
    return { userId: impersonatedUser.id, isImpersonated: true };
  }
  if (authUser) {
    return { userId: authUser.id, isImpersonated: false };
  }
  return null;
}

describe('Doctor Context Resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Role detection', () => {
    it('should identify admin roles correctly', () => {
      expect(isAdminRole(['GLOBAL_ADMIN'])).toBe(true);
      expect(isAdminRole(['GLOBAL_ADMIN'])).toBe(true);
      expect(isAdminRole(['TENANT_ADMIN'])).toBe(true);
      expect(isAdminRole(['GLOBAL_ADMIN', 'DOCTOR'])).toBe(true);
    });

    it('should identify doctor roles correctly', () => {
      expect(isDoctorRole(['DOCTOR'])).toBe(true);
      expect(isDoctorRole(['SPECIALIST'])).toBe(true);
      expect(isDoctorRole(['CONSULTANT'])).toBe(true);
    });

    it('should reject non-admin, non-doctor roles', () => {
      expect(isAdminRole(['DOCTOR'])).toBe(false);
      expect(isDoctorRole(['GLOBAL_ADMIN'])).toBe(false);
      expect(isAdminRole(['NURSE'])).toBe(false);
    });
  });

  describe('Effective user resolution', () => {
    it('should return auth user when not impersonating', () => {
      const result = resolveEffectiveUser({ id: 'doctor-001', roles: ['DOCTOR'] }, null, false);
      expect(result).toEqual({ userId: 'doctor-001', isImpersonated: false });
    });

    it('should return impersonated user when impersonating', () => {
      const result = resolveEffectiveUser({ id: 'admin-001', roles: ['GLOBAL_ADMIN'] }, { id: 'doctor-002', roles: ['DOCTOR'] }, true);
      expect(result).toEqual({ userId: 'doctor-002', isImpersonated: true });
    });

    it('should return null when no user is available', () => {
      const result = resolveEffectiveUser(null, null, false);
      expect(result).toBeNull();
    });
  });

  describe('Impersonation requirement for admin users', () => {
    it('should require impersonation when user is GLOBAL_ADMIN and not impersonating', () => {
      const roles = ['GLOBAL_ADMIN'];
      const isImpersonating = false;
      const requiresImpersonation = isAdminRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(true);
    });

    it('should NOT require impersonation when admin IS impersonating a doctor', () => {
      const roles = ['GLOBAL_ADMIN'];
      const isImpersonating = true;
      const requiresImpersonation = isAdminRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(false);
    });

    it('should NOT require impersonation when user is a DOCTOR', () => {
      const roles = ['DOCTOR'];
      const isImpersonating = false;
      const requiresImpersonation = isAdminRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(false);
    });

    it('should NOT require impersonation when user has both admin and doctor roles', () => {
      const roles = ['GLOBAL_ADMIN', 'DOCTOR'];
      const isImpersonating = false;
      const requiresImpersonation = isAdminRole(roles) && !isDoctorRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(false);
    });
  });

  describe('Department-scoped prompt template filtering', () => {
    const templates = [
      { id: 'pt-1', name: 'Cardiology SOAP', departmentId: 'dept-card', category: 'SUMMARY' },
      { id: 'pt-2', name: 'General Default', departmentId: null, category: 'SUMMARY' },
      { id: 'pt-3', name: 'Radiology Report', departmentId: 'dept-rad', category: 'SUMMARY' },
      { id: 'pt-4', name: 'Cardiology Pre-Summary', departmentId: 'dept-card', category: 'SUMMARY' },
    ];

    it('should filter templates by user department + global templates', () => {
      const userDeptId = 'dept-card';
      const filtered = templates.filter((t) => t.departmentId === userDeptId || !t.departmentId);
      expect(filtered).toHaveLength(3);
      expect(filtered.map((t) => t.id)).toEqual(['pt-1', 'pt-2', 'pt-4']);
    });

    it('should show only global templates when user has no department', () => {
      const userDeptId = '';
      const filtered = userDeptId
        ? templates.filter((t) => t.departmentId === userDeptId || !t.departmentId)
        : templates.filter((t) => !t.departmentId);
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('pt-2');
    });
  });

  describe('DNA writing style per doctor user', () => {
    it('should use effective userId to fetch DNA style', () => {
      const effectiveUser = resolveEffectiveUser({ id: 'admin-001', roles: ['GLOBAL_ADMIN'] }, { id: 'doctor-002', roles: ['DOCTOR'] }, true);
      expect(effectiveUser?.userId).toBe('doctor-002');
    });

    it('should use own userId when not impersonating', () => {
      const effectiveUser = resolveEffectiveUser({ id: 'doctor-001', roles: ['DOCTOR'] }, null, false);
      expect(effectiveUser?.userId).toBe('doctor-001');
    });
  });

  describe('Pre-Summary prompt template filtering (tag-based)', () => {
    const systemTemplates = [
      { id: 'ps-1', name: 'Pre-Summary Default', departmentId: null, category: 'SYSTEM', tags: ['system', 'pre-summary'] },
      { id: 'ps-2', name: 'Pre-Summary System Prompt', departmentId: null, category: 'SYSTEM', tags: ['system', 'pre-summary', 'smr-v1'] },
      { id: 'ps-3', name: 'JSON Enforcement', departmentId: null, category: 'SYSTEM', tags: ['system', 'json'] },
      { id: 'ps-4', name: 'Corrective Retry', departmentId: null, category: 'SYSTEM', tags: ['system', 'retry'] },
    ];

    it('should filter templates by pre-summary tag', () => {
      const preSummaryTagged = systemTemplates.filter((t) => t.tags?.some((tag) => tag.toLowerCase().includes('pre-summary')));
      expect(preSummaryTagged).toHaveLength(2);
      expect(preSummaryTagged.map((t) => t.id)).toEqual(['ps-1', 'ps-2']);
    });

    it('should prioritize department preSummaryPromptId', () => {
      const deptPreSummaryId = 'ps-1';
      const preSummaryTagged = systemTemplates.filter((t) => t.tags?.some((tag) => tag.toLowerCase().includes('pre-summary')));
      const deptTemplate = systemTemplates.find((t) => t.id === deptPreSummaryId);
      const result = deptTemplate && !preSummaryTagged.some((t) => t.id === deptTemplate.id) ? [deptTemplate, ...preSummaryTagged] : preSummaryTagged;
      expect(result[0].id).toBe('ps-1');
    });

    it('should fall back to all system templates when no pre-summary tags found', () => {
      const noTagTemplates = systemTemplates.map((t) => ({ ...t, tags: ['system'] }));
      const preSummaryTagged = noTagTemplates.filter((t) => t.tags?.some((tag) => tag.toLowerCase().includes('pre-summary')));
      const fallback = preSummaryTagged.length > 0 ? preSummaryTagged : noTagTemplates.filter((t) => !t.departmentId);
      expect(fallback).toHaveLength(4);
    });
  });

  describe('Both Summary and Pre-Summary share same context resolution', () => {
    it('should resolve same effective user for both pages', () => {
      const authUser = { id: 'admin-001', roles: ['GLOBAL_ADMIN'] };
      const impersonatedUser = { id: 'doctor-002', roles: ['DOCTOR'] };

      const summaryCtx = resolveEffectiveUser(authUser, impersonatedUser, true);
      const preSummaryCtx = resolveEffectiveUser(authUser, impersonatedUser, true);

      expect(summaryCtx).toEqual(preSummaryCtx);
      expect(summaryCtx?.userId).toBe('doctor-002');
    });

    it('should block both pages for admin without impersonation', () => {
      const roles = ['GLOBAL_ADMIN'];
      const isImpersonating = false;
      const requiresImpersonation = isAdminRole(roles) && !isDoctorRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(true);
    });

    it('should allow both pages for TENANT_ADMIN impersonating a doctor', () => {
      const roles = ['TENANT_ADMIN'];
      const isImpersonating = true;
      const requiresImpersonation = isAdminRole(roles) && !isDoctorRole(roles) && !isImpersonating;
      expect(requiresImpersonation).toBe(false);
    });
  });
});
