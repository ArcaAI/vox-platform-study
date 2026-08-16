/**
 * ConsultationConsentService.assertConsent/checkConsent unit tests
 * (TASK-712, consent-abac) — the ABAC evaluation choke point.
 *
 * Covers: absent / expired / revoked / scope-insufficient grants deny;
 * an active, sufficiently-scoped grant resolves; the cache key is
 * tenant-leading; and an invalidate event evicts the cache
 * (.claude/rules/09-infrastructure-devops.md §Config caches).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConsultationConsentService } from '../consultation-consent.service';
import { CONSENT_INVALIDATE_EVENT } from '../consent.constants';
import { ConsentDeniedException, ConsentUnavailableException } from '@arcaai/exceptions';
import { ConsentPurpose, ConsentGrantMethod, ResourceStatusType } from '@arcaai/domains';

const mockConsentGrantRepository = {
  findByTenantPatientPurpose: vi.fn(),
};

const createMockGrant = (
  overrides: Partial<{
    id: string;
    tenantId: string;
    externalPatientId: string;
    purpose: ConsentPurpose;
    scope: Record<string, unknown> | null;
    expiresAt: Date | null;
    revokedAt: Date | null;
  }> = {},
) => {
  const revokedAt = overrides.revokedAt ?? null;
  const expiresAt = overrides.expiresAt ?? null;
  return {
    id: overrides.id ?? 'grant-1',
    tenantId: overrides.tenantId ?? 'tenant-1',
    externalPatientId: overrides.externalPatientId ?? 'EHR-A:12345',
    purpose: overrides.purpose ?? ConsentPurpose.HISTORY_RETRIEVAL,
    scope: overrides.scope === undefined ? null : overrides.scope,
    grantedAt: new Date('2026-08-01T00:00:00Z'),
    grantedBy: 'clinician-1',
    grantMethod: ConsentGrantMethod.VERBAL_ATTESTED,
    evidenceRef: null,
    expiresAt,
    revokedAt,
    revokedBy: null,
    revocationReason: null,
    resourceStatus: ResourceStatusType.ENABLED,
    isActive(now: Date = new Date()) {
      if (revokedAt != null && revokedAt.getTime() <= now.getTime()) return false;
      if (expiresAt != null && expiresAt.getTime() <= now.getTime()) return false;
      return true;
    },
    coversScope(requested?: Record<string, unknown> | null) {
      if (requested == null || Object.keys(requested).length === 0) return true;
      const granted = overrides.scope ?? {};
      for (const [key, value] of Object.entries(requested)) {
        if (key === 'dateRangeDays') {
          const grantedValue = (granted as Record<string, unknown>).dateRangeDays;
          if (typeof grantedValue !== 'number' || typeof value !== 'number' || grantedValue < value) return false;
          continue;
        }
        if ((granted as Record<string, unknown>)[key] !== value) return false;
      }
      return true;
    },
  };
};

const baseInput = {
  tenantId: 'tenant-1',
  externalPatientId: 'EHR-A:12345',
  purpose: ConsentPurpose.HISTORY_RETRIEVAL,
  actor: { userId: 'clinician-1', kind: 'user' as const },
};

describe('ConsultationConsentService — assertConsent / checkConsent (ABAC choke point)', () => {
  let service: ConsultationConsentService;

  beforeEach(() => {
    vi.clearAllMocks();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service = new ConsultationConsentService(mockConsentGrantRepository as any);
  });

  it('denies (no_grant) when no grant exists for the (tenant, patient, purpose)', async () => {
    mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(null);

    const decision = await service.checkConsent(baseInput);
    expect(decision).toEqual({ allowed: false, reason: 'no_grant', grantId: undefined });

    await expect(service.assertConsent(baseInput)).rejects.toBeInstanceOf(ConsentDeniedException);
  });

  it('denies (expired) when expiresAt is in the past', async () => {
    const grant = createMockGrant({ expiresAt: new Date('2020-01-01T00:00:00Z') });
    mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

    const decision = await service.checkConsent(baseInput);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('expired');
  });

  it('denies (revoked) when revokedAt is in the past', async () => {
    const grant = createMockGrant({ revokedAt: new Date('2020-01-01T00:00:00Z') });
    mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

    const decision = await service.checkConsent(baseInput);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('revoked');
  });

  it('denies (scope_insufficient) when the grant scope is narrower than requested', async () => {
    const grant = createMockGrant({ scope: { dateRangeDays: 30 } });
    mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

    const decision = await service.checkConsent({ ...baseInput, scope: { dateRangeDays: 365 } });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('scope_insufficient');
  });

  it('resolves without throwing for an active grant whose scope covers the request', async () => {
    const grant = createMockGrant({ scope: { dateRangeDays: 365 } });
    mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

    const decision = await service.checkConsent({ ...baseInput, scope: { dateRangeDays: 90 } });
    expect(decision).toEqual({ allowed: true, grantId: grant.id, expiresAt: grant.expiresAt });

    await expect(service.assertConsent({ ...baseInput, scope: { dateRangeDays: 90 } })).resolves.toBeUndefined();
  });

  it('is fail-closed on a repository error — denies, but as UNAVAILABLE, never conflated with a genuine no_grant denial (R4)', async () => {
    mockConsentGrantRepository.findByTenantPatientPurpose.mockRejectedValue(new Error('tenant-scope mismatch'));

    const decision = await service.checkConsent(baseInput);
    expect(decision.allowed).toBe(false);
    expect(decision.unavailable).toBe(true);
    expect(decision.reason).toBeUndefined();

    await expect(service.assertConsent(baseInput)).rejects.toBeInstanceOf(ConsentUnavailableException);
    await expect(service.assertConsent(baseInput)).rejects.not.toBeInstanceOf(ConsentDeniedException);
  });

  describe('caching', () => {
    it('keys the cache tenant-first and does not re-query the repository within the TTL', async () => {
      const grant = createMockGrant();
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

      await service.checkConsent(baseInput);
      await service.checkConsent(baseInput);

      expect(mockConsentGrantRepository.findByTenantPatientPurpose).toHaveBeenCalledTimes(1);
    });

    it('evicts the cache on the consent.invalidate event, so the next check re-queries the repository', async () => {
      const grant = createMockGrant();
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

      await service.checkConsent(baseInput);
      expect(mockConsentGrantRepository.findByTenantPatientPurpose).toHaveBeenCalledTimes(1);

      service.handleInvalidate({ tenantId: baseInput.tenantId, externalPatientId: baseInput.externalPatientId, purpose: baseInput.purpose });

      await service.checkConsent(baseInput);
      expect(mockConsentGrantRepository.findByTenantPatientPurpose).toHaveBeenCalledTimes(2);
    });

    it('normalizes externalPatientId before keying the cache, so a whitespace variant hits the same entry', async () => {
      const grant = createMockGrant();
      mockConsentGrantRepository.findByTenantPatientPurpose.mockResolvedValue(grant);

      await service.checkConsent(baseInput);
      await service.checkConsent({ ...baseInput, externalPatientId: `  ${baseInput.externalPatientId}  ` });

      expect(mockConsentGrantRepository.findByTenantPatientPurpose).toHaveBeenCalledTimes(1);
    });
  });

  it('CONSENT_INVALIDATE_EVENT is the event name ConsentGrantService emits on grant create/revoke', () => {
    expect(CONSENT_INVALIDATE_EVENT).toBe('consent.invalidate');
  });
});
