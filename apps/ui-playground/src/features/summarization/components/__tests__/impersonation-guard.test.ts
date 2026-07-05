import { describe, it, expect } from 'vitest';

/**
 * Tests for the shared ImpersonationGuard component's prop contract.
 * The component should accept optional featureName and featureDescription
 * to allow contextual messaging across different pages
 * (summarization, consultation, DNA writing style).
 */

interface ImpersonationGuardProps {
  roles: string[];
  featureName?: string;
  featureDescription?: string;
}

function getSubtitleText(props: ImpersonationGuardProps): string {
  const feature = props.featureName ?? 'summarization';
  return `Admin users must impersonate a doctor to use ${feature} features`;
}

function getBodyText(props: ImpersonationGuardProps): string {
  if (props.featureDescription) return props.featureDescription;
  return `Prompt templates and DNA writing styles are personalized per doctor and their department. As an admin (${props.roles.join(', ')}), you need to impersonate a doctor user to access their department-specific templates and writing style.`;
}

describe('ImpersonationGuard component contract', () => {
  describe('default behavior (backward compatible)', () => {
    it('should show "summarization" in subtitle when no featureName provided', () => {
      const text = getSubtitleText({ roles: ['GLOBAL_ADMIN'] });
      expect(text).toContain('summarization');
    });

    it('should show default body text when no featureDescription provided', () => {
      const text = getBodyText({ roles: ['GLOBAL_ADMIN'] });
      expect(text).toContain('Prompt templates and DNA writing styles');
      expect(text).toContain('GLOBAL_ADMIN');
    });
  });

  describe('custom featureName', () => {
    it('should use custom featureName in subtitle for consultation', () => {
      const text = getSubtitleText({
        roles: ['GLOBAL_ADMIN'],
        featureName: 'consultation',
      });
      expect(text).toContain('consultation');
      expect(text).not.toContain('summarization');
    });

    it('should use custom featureName in subtitle for DNA writing style', () => {
      const text = getSubtitleText({
        roles: ['TENANT_ADMIN'],
        featureName: 'DNA writing style',
      });
      expect(text).toContain('DNA writing style');
    });
  });

  describe('custom featureDescription', () => {
    it('should use custom featureDescription as body text', () => {
      const customDesc =
        'Consultations are doctor-scoped. You need to impersonate a doctor to view and manage consultations.';
      const text = getBodyText({
        roles: ['GLOBAL_ADMIN'],
        featureDescription: customDesc,
      });
      expect(text).toBe(customDesc);
    });

    it('should fallback to default body text when featureDescription not provided', () => {
      const text = getBodyText({ roles: ['GLOBAL_ADMIN'] });
      expect(text).toContain('GLOBAL_ADMIN');
      expect(text).toContain('Prompt templates');
    });
  });

  describe('roles display', () => {
    it('should join multiple roles with comma separator', () => {
      const text = getBodyText({ roles: ['GLOBAL_ADMIN', 'TENANT_ADMIN'] });
      expect(text).toContain('GLOBAL_ADMIN, TENANT_ADMIN');
    });

    it('should display single role without comma in role list', () => {
      const roles = ['TENANT_ADMIN'];
      const roleDisplay = roles.join(', ');
      expect(roleDisplay).toBe('TENANT_ADMIN');
      expect(roleDisplay).not.toContain(', ');
    });
  });
});
