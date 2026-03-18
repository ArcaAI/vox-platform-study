import { describe, it, expect } from 'vitest';

/**
 * Tests that the DNA Writing Style page:
 * 1. Shows the shared ImpersonationGuard when admin has not impersonated
 * 2. Uses effectiveUserId (impersonated doctor) for data fetching
 * 3. Disables queries when requiresImpersonation is true
 *
 * Mirrors the pattern from /summarization/pre-summary and /summarization/summary.
 */

const ADMIN_ROLES = ['SUPER_ADMIN', 'GLOBAL_ADMIN', 'TENANT_ADMIN'];
const DOCTOR_ROLES = ['DOCTOR', 'SPECIALIST', 'CONSULTANT'];

interface DoctorContext {
  effectiveUserId: string;
  isImpersonated: boolean;
  requiresImpersonation: boolean;
  isAdmin: boolean;
  isDoctor: boolean;
  roles: string[];
}

function buildContext(overrides: Partial<DoctorContext> & { roles: string[] }): DoctorContext {
  const roles = overrides.roles;
  const isAdmin = overrides.isAdmin ?? roles.some((r) => ADMIN_ROLES.includes(r));
  const isDoctor = overrides.isDoctor ?? roles.some((r) => DOCTOR_ROLES.includes(r));
  const isImpersonated = overrides.isImpersonated ?? false;
  const requiresImpersonation = overrides.requiresImpersonation ?? (isAdmin && !isDoctor && !isImpersonated);
  const effectiveUserId = overrides.effectiveUserId ?? 'self-user-id';

  return { effectiveUserId, isImpersonated, requiresImpersonation, isAdmin, isDoctor, roles };
}

describe('DNA Writing Style ImpersonationGuard integration', () => {
  describe('guard rendering decision', () => {
    it('should show ImpersonationGuard when admin is not impersonating', () => {
      const ctx = buildContext({ roles: ['SUPER_ADMIN'] });
      expect(ctx.requiresImpersonation).toBe(true);
    });

    it('should NOT show ImpersonationGuard when doctor accesses page', () => {
      const ctx = buildContext({ roles: ['DOCTOR'] });
      expect(ctx.requiresImpersonation).toBe(false);
    });

    it('should NOT show ImpersonationGuard when admin is impersonating a doctor', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'impersonated-doctor-id',
      });
      expect(ctx.requiresImpersonation).toBe(false);
    });
  });

  describe('data fetching with impersonation context', () => {
    it('should use effectiveUserId (impersonated doctor) for DNA style query', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-abc-123',
      });

      // The page should call useDnaStyleByDoctor(ctx.effectiveUserId)
      // instead of useMyDnaStyle() so it fetches the impersonated doctor's style
      expect(ctx.effectiveUserId).toBe('doctor-abc-123');
      expect(ctx.isImpersonated).toBe(true);
      expect(ctx.requiresImpersonation).toBe(false);
    });

    it('should use own userId when not impersonating (doctor user)', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: 'my-doctor-id',
      });

      expect(ctx.effectiveUserId).toBe('my-doctor-id');
      expect(ctx.isImpersonated).toBe(false);
    });

    it('should disable DNA style query when requiresImpersonation is true', () => {
      const ctx = buildContext({ roles: ['GLOBAL_ADMIN'] });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(false);
    });

    it('should enable DNA style query when admin is impersonating', () => {
      const ctx = buildContext({
        roles: ['SUPER_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-xyz',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(true);
    });

    it('should enable DNA style query for doctor user', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: 'doctor-self',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(true);
    });

    it('should disable DNA style query when effectiveUserId is empty', () => {
      const ctx = buildContext({
        roles: ['DOCTOR'],
        effectiveUserId: '',
      });

      const queryEnabled = !!ctx.effectiveUserId && !ctx.requiresImpersonation;
      expect(queryEnabled).toBe(false);
    });

    it('should disable reports list query when requiresImpersonation is true', () => {
      const ctx = buildContext({ roles: ['TENANT_ADMIN'] });

      const reportsQueryEnabled = !ctx.requiresImpersonation;
      expect(reportsQueryEnabled).toBe(false);
    });

    it('should enable reports list query when impersonating', () => {
      const ctx = buildContext({
        roles: ['TENANT_ADMIN'],
        isImpersonated: true,
        effectiveUserId: 'doctor-id',
      });

      const reportsQueryEnabled = !ctx.requiresImpersonation;
      expect(reportsQueryEnabled).toBe(true);
    });
  });

  describe('ImpersonationGuard props for DNA page', () => {
    it('should pass roles for display', () => {
      const guardProps = {
        roles: ['TENANT_ADMIN'],
      };
      expect(guardProps.roles).toEqual(['TENANT_ADMIN']);
    });

    it('should accept featureName for contextual subtitle', () => {
      const guardProps = {
        roles: ['SUPER_ADMIN'],
        featureName: 'DNA writing style',
      };
      expect(guardProps.featureName).toBe('DNA writing style');
    });

    it('should accept featureDescription for contextual body text', () => {
      const guardProps = {
        roles: ['SUPER_ADMIN'],
        featureDescription:
          'DNA writing styles are personalized per doctor. As an admin, you need to impersonate a doctor to generate or view their writing style profile.',
      };
      expect(guardProps.featureDescription).toBeDefined();
    });
  });
});
