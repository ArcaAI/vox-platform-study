/**
 * TenantIdentityProviderFactory Unit Tests
 *
 * Tests for the TenantIdentityProviderFactory that creates a tenant's
 * configured external IdP row, plus the TenantIdentityProviderEntity.validate()
 * structural invariants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TenantIdentityProviderFactory } from '../TenantIdentityProviderFactory';
import { IdpProtocol, IdpStatus, ResourceStatusType } from '../../../../enums';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

function validProps(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TEST_TENANT_ID,
    protocol: IdpProtocol.OIDC,
    displayName: 'Acme Okta',
    config: { issuer: 'https://acme.okta.com', clientId: 'abc123' },
    ...overrides,
  };
}

describe('TenantIdentityProviderFactory.CreateTenantIdentityProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set required fields', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.tenantId).toBe(TEST_TENANT_ID);
    expect(entity.protocol).toBe(IdpProtocol.OIDC);
    expect(entity.displayName).toBe('Acme Okta');
    expect(entity.config).toEqual({ issuer: 'https://acme.okta.com', clientId: 'abc123' });
  });

  it('should default providerStatus to DRAFT (never auto-ENABLED)', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.providerStatus).toBe(IdpStatus.DRAFT);
  });

  it('should default resourceStatus to ENABLED', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });

  it('should default the Vault ciphertext refs to null', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.encryptedSecretRef).toBeNull();
    expect(entity.directoryCredentialsRef).toBeNull();
  });

  it('should not overwrite provided optional fields', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(
      validProps({
        providerStatus: IdpStatus.ENABLED,
        encryptedSecretRef: 'vault:v1:abcd',
        directoryCredentialsRef: 'vault:v1:efgh',
      }),
    );
    expect(entity.providerStatus).toBe(IdpStatus.ENABLED);
    expect(entity.encryptedSecretRef).toBe('vault:v1:abcd');
    expect(entity.directoryCredentialsRef).toBe('vault:v1:efgh');
  });

  it('should set timestamps', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(entity.createdAt).toBeInstanceOf(Date);
    expect(entity.updatedAt).toBeInstanceOf(Date);
  });

  it('should create an entity that passes validation', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps());
    expect(() => entity.validate()).not.toThrow();
  });
});

describe('TenantIdentityProviderEntity.validate()', () => {
  it('should throw when displayName is blank', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps({ displayName: '   ' }));
    expect(() => entity.validate()).toThrow('displayName is required');
  });

  it('should throw when protocol is missing', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps({ protocol: undefined as never }));
    expect(() => entity.validate()).toThrow('protocol is required');
  });

  it('should throw when config is missing', () => {
    const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps({ config: undefined as never }));
    expect(() => entity.validate()).toThrow('config is required');
  });

  it('should accept both OIDC and SAML protocol values (protocol-neutral data model)', () => {
    for (const protocol of Object.values(IdpProtocol)) {
      const entity = TenantIdentityProviderFactory.CreateTenantIdentityProvider(validProps({ protocol }));
      expect(() => entity.validate()).not.toThrow();
    }
  });
});
