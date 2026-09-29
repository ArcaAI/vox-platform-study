import { describe, expect, it } from 'vitest';
import { AuditLogFactory } from '../factories';
import { AuditLogEntityMapper } from '../mappers';

describe('AuditLog traceId', () => {
  const base = { resourceType: 'User', data: {}, previousData: {}, tenantId: 't1', action: 'CREATE' };
  const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

  it('is carried by the factory, entity and mapper', () => {
    const entity = AuditLogFactory.CreateAuditLog({ ...base, traceId: TRACE_ID } as never);
    expect(entity.traceId).toBe(TRACE_ID);
    expect(AuditLogEntityMapper.getInstance().toPersistence(entity).traceId).toBe(TRACE_ID);
  });

  it('defaults to null', () => {
    expect(AuditLogFactory.CreateAuditLog(base as never).traceId).toBeNull();
  });
});
