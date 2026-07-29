/**
 * TenantIdentityProviderDomainFactory Unit Tests
 *
 * Tests for the TenantIdentityProviderDomainFactory that creates a verified
 * email-domain → provider allowlist row for home-realm discovery (HRD), plus
 * the TenantIdentityProviderDomainEntity.validate() structural invariants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantIdentityProviderDomainFactory } from '../TenantIdentityProviderDomainFactory';
import { ResourceStatusType } from '../../../../enums';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TEST_PROVIDER_ID = '22222222-2222-2222-2222-222222222222';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

function validProps(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TEST_TENANT_ID,
    providerId: TEST_PROVIDER_ID,
    domain: 'acme.com',
    ...overrides,
  };
}

describe('TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps());
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set required fields', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps());
    expect(entity.tenantId).toBe(TEST_TENANT_ID);
    expect(entity.providerId).toBe(TEST_PROVIDER_ID);
    expect(entity.domain).toBe('acme.com');
  });

  it('should default resourceStatus to ENABLED', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps());
    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });

  it('should create an entity that passes validation', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps());
    expect(() => entity.validate()).not.toThrow();
  });
});

describe('TenantIdentityProviderDomainEntity.validate()', () => {
  it('should throw when domain is blank', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps({ domain: '   ' }));
    expect(() => entity.validate()).toThrow('domain is required');
  });

  it('should throw when providerId is blank', () => {
    const entity = TenantIdentityProviderDomainFactory.CreateTenantIdentityProviderDomain(validProps({ providerId: '' }));
    expect(() => entity.validate()).toThrow('providerId is required');
  });
});
