/**
 * FederatedIdentityFactory Unit Tests (TASK-498)
 *
 * Tests for the FederatedIdentityFactory that links a HOPE user to a subject
 * at a specific tenant IdP, plus the FederatedIdentityEntity.validate()
 * structural invariants.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FederatedIdentityFactory } from '../FederatedIdentityFactory';
import { ResourceStatusType } from '../../../../enums';

const TEST_TENANT_ID = '00000000-0000-0000-0000-000000000001';
const TEST_USER_ID = '11111111-1111-1111-1111-111111111111';
const TEST_PROVIDER_ID = '22222222-2222-2222-2222-222222222222';

vi.mock('../../../../utils', () => ({
  generateId: vi.fn(() => 'generated-uuid-7'),
}));

function validProps(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TEST_TENANT_ID,
    userId: TEST_USER_ID,
    providerId: TEST_PROVIDER_ID,
    subject: 'auth0|abc123',
    ...overrides,
  };
}

describe('FederatedIdentityFactory.CreateFederatedIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should create entity with generated UUID7 id', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps());
    expect(entity.id).toBe('generated-uuid-7');
  });

  it('should set required link fields', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps());
    expect(entity.tenantId).toBe(TEST_TENANT_ID);
    expect(entity.userId).toBe(TEST_USER_ID);
    expect(entity.providerId).toBe(TEST_PROVIDER_ID);
    expect(entity.subject).toBe('auth0|abc123');
  });

  it('should default lastLoginAt to null', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps());
    expect(entity.lastLoginAt).toBeNull();
  });

  it('should not overwrite a provided lastLoginAt', () => {
    const loginAt = new Date('2026-07-12T09:00:00Z');
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps({ lastLoginAt: loginAt }));
    expect(entity.lastLoginAt).toBe(loginAt);
  });

  it('should default resourceStatus to ENABLED', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps());
    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });

  it('should create an entity that passes validation', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps());
    expect(() => entity.validate()).not.toThrow();
  });
});

describe('FederatedIdentityEntity.validate()', () => {
  it('should throw when userId is blank', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps({ userId: '' }));
    expect(() => entity.validate()).toThrow('userId is required');
  });

  it('should throw when providerId is blank', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps({ providerId: '' }));
    expect(() => entity.validate()).toThrow('providerId is required');
  });

  it('should throw when subject is blank', () => {
    const entity = FederatedIdentityFactory.CreateFederatedIdentity(validProps({ subject: '   ' }));
    expect(() => entity.validate()).toThrow('subject is required');
  });
});
