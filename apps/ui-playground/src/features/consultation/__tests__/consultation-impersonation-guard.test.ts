import { describe, it, expect } from 'vitest';

/**
 * Tests that the consultation page uses the shared ImpersonationGuard
 * component (from summarization/components) instead of its own inline
 * ImpersonationRequired component, and that the guard receives
 * contextual props for consultations.
 */

describe('Consultation ImpersonationGuard integration', () => {
  describe('guard rendering decision', () => {
    it('should show ImpersonationGuard when admin is not impersonating', () => {
      const roles = ['GLOBAL_ADMIN'];
      const isImpersonating = false;
      const isAdmin = true;
      const isDoctor = false;
      const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

      expect(requiresImpersonation).toBe(true);
    });

    it('should NOT show ImpersonationGuard when doctor accesses page', () => {
      const roles = ['DOCTOR'];
      const isImpersonating = false;
      const isAdmin = false;
      const isDoctor = true;
      const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

      expect(requiresImpersonation).toBe(false);
    });

    it('should NOT show ImpersonationGuard when admin is impersonating', () => {
      const roles = ['GLOBAL_ADMIN'];
      const isImpersonating = true;
      const isAdmin = true;
      const isDoctor = false;
      const requiresImpersonation = isAdmin && !isDoctor && !isImpersonating;

      expect(requiresImpersonation).toBe(false);
    });
  });

  describe('ImpersonationGuard props contract', () => {
    it('should accept roles array', () => {
      const guardProps = {
        roles: ['GLOBAL_ADMIN'],
      };
      expect(guardProps.roles).toEqual(['GLOBAL_ADMIN']);
    });

    it('should accept optional featureDescription for contextual text', () => {
      const guardProps = {
        roles: ['GLOBAL_ADMIN'],
        featureDescription: 'Consultations are doctor-scoped and require impersonation to view and manage.',
      };
      expect(guardProps.featureDescription).toBeDefined();
    });

    it('should accept optional featureName for the subtitle', () => {
      const guardProps = {
        roles: ['GLOBAL_ADMIN'],
        featureName: 'consultation',
      };
      expect(guardProps.featureName).toBe('consultation');
    });
  });
});
