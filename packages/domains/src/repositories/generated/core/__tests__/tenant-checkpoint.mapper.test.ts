import { describe, expect, it } from 'vitest';
import { TenantCheckpointFactory } from '../../../../factories';
import { TenantCheckpointEntityMapper } from '../../../../mappers';

describe('TenantCheckpoint mapper', () => {
  it('never writes _version and maps sizeBytes number ↔ bigint', () => {
    const entity = TenantCheckpointFactory.CreateTenantCheckpoint({ tenantId: 't-1', label: 'before upgrade' });
    entity.sizeBytes = 1234;
    const row = TenantCheckpointEntityMapper.getInstance().toPersistence(entity) as Record<string, unknown>;
    expect(row).not.toHaveProperty('version');
    expect(row.sizeBytes).toBe(1234n);
    const back = TenantCheckpointEntityMapper.getInstance().toDomainEntity({ ...row, version: 3 } as never);
    expect(back.sizeBytes).toBe(1234);
    expect(back.status).toBe('PENDING');
    expect(back.kind).toBe('MANUAL');
  });
});
