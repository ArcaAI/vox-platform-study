/**
 * TenantSttConfig entity/factory behavior (TASK-567).
 *
 * Locks change-tracking through `setProperty` (so `repository.update` persists
 * only `entity.changes`) and factory defaults.
 *
 * The former `TenantSttProviderCredentialEntity` coverage that lived in this
 * file was removed with the entity itself (TASK-576 — BYO credential rows now
 * live in the unified `AiProviderConnection` plane, `service='stt'`).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { TenantSttConfigFactory } from '../../../../factories/generated/core/TenantSttConfigFactory';

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
