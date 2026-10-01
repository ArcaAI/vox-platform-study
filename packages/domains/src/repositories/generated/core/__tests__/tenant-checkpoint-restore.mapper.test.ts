import { describe, expect, it } from 'vitest';
import { TenantCheckpointRestoreFactory } from '../../../../factories';
import { TenantCheckpointRestoreEntityMapper } from '../../../../mappers';

describe('TenantCheckpointRestore mapper', () => {
  it('round-trips categories as a string array and strips version', () => {
    const entity = TenantCheckpointRestoreFactory.CreateTenantCheckpointRestore({
      tenantId: 't-1',
      checkpointId: 'c-1',
      reason: 'rolling back a bad import',
      requestedBy: 'u-1',
      categories: ['AGENTS', 'SETTINGS'] as never,
    });
    const row = TenantCheckpointRestoreEntityMapper.getInstance().toPersistence(entity) as unknown as Record<string, unknown>;
    expect(row).not.toHaveProperty('version');
    expect(row.categories).toEqual(['AGENTS', 'SETTINGS']);
    const back = TenantCheckpointRestoreEntityMapper.getInstance().toDomainEntity({ ...row, version: 2 } as never);
    expect(back.categories).toEqual(['AGENTS', 'SETTINGS']);
    expect(back.status).toBe('PENDING');
  });
});
