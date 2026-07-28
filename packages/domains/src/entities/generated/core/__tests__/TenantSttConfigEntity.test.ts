/**
 * TenantSttConfig + TenantSttProviderCredential entity/factory behavior (TASK-567).
 *
 * Locks change-tracking through `setProperty` (so `repository.update` persists
 * only `entity.changes`), factory defaults, and the credential `validate()`
 * invariant.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { BusinessException } from '@arcaai/exceptions';
import { TenantSttConfigFactory } from '../../../../factories/generated/core/TenantSttConfigFactory';
import { TenantSttProviderCredentialFactory } from '../../../../factories/generated/core/TenantSttProviderCredentialFactory';

describe('TenantSttConfigEntity', () => {
  it('factory defaults: autoSwitchEnabled ON, no fallback, generated id, no changes', () => {
    const entity = TenantSttConfigFactory.CreateTenantSttConfig({ tenantId: 't-1' });
    expect(entity.id).toBeTruthy();
    expect(entity.tenantId).toBe('t-1');
    expect(entity.autoSwitchEnabled).toBe(true);
    expect(entity.fallbackPipelineId).toBeNull();
    expect(entity.configJson).toBeNull();
    expect(entity.hasChanges).toBe(false);
  });

  it('setters route through setProperty (change-tracked)', () => {
    const entity = TenantSttConfigFactory.CreateTenantSttConfig({ tenantId: 't-1' });
    entity.fallbackPipelineId = 'pipe-1';
    entity.autoSwitchEnabled = false;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({ fallbackPipelineId: 'pipe-1', autoSwitchEnabled: false });
  });
});

describe('TenantSttProviderCredentialEntity', () => {
  it('factory defaults: enabled OFF, nullable secret fields, generated id', () => {
    const entity = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: 't-1',
      provider: 'sarvam',
    });
    expect(entity.id).toBeTruthy();
    expect(entity.provider).toBe('sarvam');
    expect(entity.enabled).toBe(false);
    expect(entity.encryptedApiKey).toBeNull();
    expect(entity.keyVersion).toBeNull();
    expect(entity.region).toBeNull();
    expect(entity.hasChanges).toBe(false);
  });

  it('setters route through setProperty (change-tracked)', () => {
    const entity = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: 't-1',
      provider: 'openai',
    });
    entity.encryptedApiKey = new Uint8Array([9, 9]);
    entity.keyVersion = 1;
    entity.enabled = true;
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toMatchObject({ keyVersion: 1, enabled: true });
  });

  it('validate() rejects a missing provider', () => {
    const entity = TenantSttProviderCredentialFactory.CreateTenantSttProviderCredential({
      tenantId: 't-1',
      provider: '',
    });
    expect(() => entity.validate()).toThrow(BusinessException);
  });
});
