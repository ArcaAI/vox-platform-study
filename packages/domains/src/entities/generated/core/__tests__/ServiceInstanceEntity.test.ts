/**
 * ServiceInstanceEntity + ServiceInstanceFactory unit tests.
 */
import { describe, it, expect } from 'vitest';
import { ServiceInstanceFactory } from '../../../../factories/generated/core/ServiceInstanceFactory';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const baseProps = {
  tenantId: SYSTEM_TENANT_ID,
  releaseId: 'release-1',
  serviceName: 'smr',
  environment: 'dev',
  instanceId: 'smr-7f9c8d-abcde',
  startedAt: new Date('2026-08-09T11:22:33.000Z'),
};

describe('ServiceInstanceFactory', () => {
  it('generates a UUIDv7 id and defaults lastSeenAt to now', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance(baseProps);
    expect(instance.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(instance.lastSeenAt).toBeInstanceOf(Date);
    expect(instance.tenantId).toBe(SYSTEM_TENANT_ID);
  });

  it('has no resourceStatus column — the DB table carries none (MODELS_WITHOUT_SOFT_DELETE)', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance(baseProps);
    // The in-memory BaseEntity always carries a resourceStatus (defaults to
    // ENABLED); the Prisma model simply never persists it (see
    // ServiceInstanceEntityMapper — no strip needed because
    // AutoEntityMapper only copies fields the target model class declares).
    expect(instance.resourceStatus).toBeDefined();
  });
});

describe('ServiceInstanceEntity.validate', () => {
  it('passes for a well-formed instance', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance(baseProps);
    expect(() => instance.validate()).not.toThrow();
  });

  it('rejects a missing releaseId', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance({ ...baseProps, releaseId: '' });
    expect(() => instance.validate()).toThrow(/release id/i);
  });

  it('rejects a missing environment', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance({ ...baseProps, environment: '' });
    expect(() => instance.validate()).toThrow(/environment/i);
  });

  it('rejects a missing instanceId', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance({ ...baseProps, instanceId: '' });
    expect(() => instance.validate()).toThrow(/instance id/i);
  });

  it('a heartbeat updates only lastSeenAt through setProperty', () => {
    const instance = ServiceInstanceFactory.CreateServiceInstance(baseProps);
    const heartbeatAt = new Date('2026-08-09T11:27:33.000Z');
    instance.lastSeenAt = heartbeatAt;
    expect(instance.hasChanges).toBe(true);
    expect(instance.changes).toEqual({ lastSeenAt: heartbeatAt });
  });
});
