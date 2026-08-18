/**
 * ServiceAccountEntity + ServiceAccountFactory unit tests (TASK-762 §5.1).
 *
 * The invariants that earn their own suite are the two that make this a
 * SEPARATE credential class rather than a second API key:
 *
 *  1. Every scope must live in the `svc:*` namespace. The `admin:*` vocabulary
 *     TASK-757 puts in reserve belongs to TENANT API KEYS; if a service account
 *     could carry it, the two classes would share a scope space and the
 *     TASK-708 §6 non-mixing ruling would be satisfied only by convention.
 *  2. No secret material may ever reach the entity. `credentialsRef` is a VAULT
 *     PATH and `secretVerifier` is a one-way HMAC — a plaintext secret on this
 *     row would be exactly the "credential in a DB column" that
 *     `09-infrastructure-devops.md` §Configuration Tiers forbids.
 */
import { describe, it, expect } from 'vitest';
import { BusinessException } from '@arcaai/exceptions';
import { ServiceAccountFactory } from '../../../../factories/generated/core/ServiceAccountFactory';
import { ResourceStatusType } from '../../../../enums';

const baseProps = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  clientId: 'hope_svc_abc123',
  displayName: 'Nightly reconciliation bot',
  scopes: ['svc:admin:tenant:manage'],
  credentialsRef: 'service-accounts/hope_svc_abc123/current',
  secretVerifier: 'a'.repeat(64),
};

describe('ServiceAccountFactory', () => {
  it('generates a UUIDv7 id and defaults resourceStatus to ENABLED', () => {
    const account = ServiceAccountFactory.CreateServiceAccount(baseProps);

    expect(account.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(account.resourceStatus).toBe(ResourceStatusType.ENABLED);
    expect(account.clientId).toBe('hope_svc_abc123');
    expect(account.scopes).toEqual(['svc:admin:tenant:manage']);
  });

  it('defaults superAdmin to false — a machine principal is never elevated by omission', () => {
    const account = ServiceAccountFactory.CreateServiceAccount(baseProps);
    expect(account.superAdmin).toBe(false);
  });

  it('defaults tokenTtlSeconds to the 15-minute short-lived default', () => {
    const account = ServiceAccountFactory.CreateServiceAccount(baseProps);
    expect(account.tokenTtlSeconds).toBe(900);
  });
});

describe('ServiceAccountEntity.validate', () => {
  it('rejects an empty scope set — a credential that can do nothing is a configuration error', () => {
    const account = ServiceAccountFactory.CreateServiceAccount({ ...baseProps, scopes: [] });
    expect(() => account.validate()).toThrow(BusinessException);
  });

  it('rejects any scope outside the svc:* namespace', () => {
    for (const bad of ['admin:tenant:manage', 'admin:*', '*', 'stt:transcription:read', 'svcadmin:x']) {
      const account = ServiceAccountFactory.CreateServiceAccount({ ...baseProps, scopes: [bad] });
      expect(() => account.validate(), `scope '${bad}' must be rejected`).toThrow(BusinessException);
    }
  });

  it('accepts svc:* scopes, including the svc namespace wildcard', () => {
    for (const good of ['svc:admin:tenant:manage', 'svc:*', 'svc:admin:*']) {
      const account = ServiceAccountFactory.CreateServiceAccount({ ...baseProps, scopes: [good] });
      expect(() => account.validate(), `scope '${good}' must be accepted`).not.toThrow();
    }
  });

  it('requires a clientId and a credentialsRef', () => {
    expect(() => ServiceAccountFactory.CreateServiceAccount({ ...baseProps, clientId: '  ' }).validate()).toThrow(BusinessException);
    expect(() => ServiceAccountFactory.CreateServiceAccount({ ...baseProps, credentialsRef: '' }).validate()).toThrow(BusinessException);
  });

  it('rejects a rotation overlap that has a previous verifier but no expiry (an unbounded second credential)', () => {
    const account = ServiceAccountFactory.CreateServiceAccount({
      ...baseProps,
      previousSecretVerifier: 'b'.repeat(64),
      previousCredentialsRef: 'service-accounts/hope_svc_abc123/previous',
    });
    expect(() => account.validate()).toThrow(BusinessException);
  });

  it('accepts a rotation overlap that carries its expiry', () => {
    const account = ServiceAccountFactory.CreateServiceAccount({
      ...baseProps,
      previousSecretVerifier: 'b'.repeat(64),
      previousCredentialsRef: 'service-accounts/hope_svc_abc123/previous',
      previousCredentialExpiresAt: new Date(Date.now() + 60_000),
    });
    expect(() => account.validate()).not.toThrow();
  });

  it('exposes allowedTenantIds only as a platform-account concept — a tenant-bound account may not carry one', () => {
    const account = ServiceAccountFactory.CreateServiceAccount({
      ...baseProps,
      tenantId: '11111111-1111-1111-1111-111111111111',
      allowedTenantIds: ['22222222-2222-2222-2222-222222222222'],
    });
    expect(() => account.validate()).toThrow(BusinessException);
  });

  it('lets a SYSTEM-tenant (platform) account carry an allowedTenantIds list', () => {
    const account = ServiceAccountFactory.CreateServiceAccount({
      ...baseProps,
      tenantId: '00000000-0000-0000-0000-000000000000',
      allowedTenantIds: ['22222222-2222-2222-2222-222222222222'],
    });
    expect(() => account.validate()).not.toThrow();
  });

  it('never carries plaintext secret material — the entity surface has no secret field', () => {
    const account = ServiceAccountFactory.CreateServiceAccount(baseProps);
    // `credentialsRef` is a Vault PATH; `secretVerifier` is a one-way HMAC.
    expect(account.credentialsRef).toBe('service-accounts/hope_svc_abc123/current');
    expect(Object.keys(account)).not.toContain('_clientSecret');
    expect((account as unknown as Record<string, unknown>).clientSecret).toBeUndefined();
  });
});
