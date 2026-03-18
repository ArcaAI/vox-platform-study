import { describe, it, expect } from 'vitest';

const ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'];
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

function isAdminRole(roles: string[]): boolean {
  return roles.some((r) => ADMIN_ROLES.includes(r));
}

function isDoctorRole(roles: string[]): boolean {
  return roles.some((r) => DOCTOR_ROLES.includes(r));
}

function requiresImpersonation(
  roles: string[],
  isImpersonating: boolean,
): boolean {
  return isAdminRole(roles) && !isDoctorRole(roles) && !isImpersonating;
}

function canAccessConsultations(
  hasTenant: boolean,
  roles: string[],
  isImpersonating: boolean,
): boolean {
  return hasTenant && !requiresImpersonation(roles, isImpersonating);
}

describe('Consultation Access Control', () => {
  describe('requiresImpersonation', () => {
    it('should require impersonation for SUPER_ADMIN not impersonating', () => {
      expect(requiresImpersonation(['SUPER_ADMIN'], false)).toBe(true);
    });

    it('should require impersonation for GLOBAL_ADMIN not impersonating', () => {
      expect(requiresImpersonation(['GLOBAL_ADMIN'], false)).toBe(true);
    });

    it('should require impersonation for TENANT_ADMIN not impersonating', () => {
      expect(requiresImpersonation(['TENANT_ADMIN'], false)).toBe(true);
    });

    it('should NOT require impersonation for SUPER_ADMIN who IS impersonating', () => {
      expect(requiresImpersonation(['SUPER_ADMIN'], true)).toBe(false);
    });

    it('should NOT require impersonation for DOCTOR', () => {
      expect(requiresImpersonation(['DOCTOR'], false)).toBe(false);
    });

    it('should NOT require impersonation for SPECIALIST', () => {
      expect(requiresImpersonation(['SPECIALIST'], false)).toBe(false);
    });

    it('should NOT require impersonation for user with both admin and doctor roles', () => {
      expect(requiresImpersonation(['SUPER_ADMIN', 'DOCTOR'], false)).toBe(false);
    });

    it('should NOT require impersonation for NURSE', () => {
      expect(requiresImpersonation(['NURSE'], false)).toBe(false);
    });

    it('should NOT require impersonation for DEPARTMENT_HEAD', () => {
      expect(requiresImpersonation(['DEPARTMENT_HEAD'], false)).toBe(false);
    });

    it('should NOT require impersonation for empty roles', () => {
      expect(requiresImpersonation([], false)).toBe(false);
    });
  });

  describe('canAccessConsultations', () => {
    it('should allow access for DOCTOR with tenant', () => {
      expect(canAccessConsultations(true, ['DOCTOR'], false)).toBe(true);
    });

    it('should deny access when no tenant selected', () => {
      expect(canAccessConsultations(false, ['DOCTOR'], false)).toBe(false);
    });

    it('should deny access for SUPER_ADMIN without impersonation', () => {
      expect(canAccessConsultations(true, ['SUPER_ADMIN'], false)).toBe(false);
    });

    it('should allow access for SUPER_ADMIN who is impersonating', () => {
      expect(canAccessConsultations(true, ['SUPER_ADMIN'], true)).toBe(true);
    });

    it('should allow access for TENANT_ADMIN who is impersonating', () => {
      expect(canAccessConsultations(true, ['TENANT_ADMIN'], true)).toBe(true);
    });

    it('should deny access for admin without tenant even when impersonating', () => {
      expect(canAccessConsultations(false, ['SUPER_ADMIN'], true)).toBe(false);
    });
  });
});
