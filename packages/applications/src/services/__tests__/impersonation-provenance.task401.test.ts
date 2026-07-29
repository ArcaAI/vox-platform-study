/**
 * Impersonation provenance threading contract.
 *
 * A write performed under an impersonated session must land an audit row that
 * records BOTH the subject (responsibleUserId = the impersonated user) and the
 * true actor. The chain under test:
 *
 *   BaseService.broadcastSysEvent            → event.metaData.impersonatedBy
 *   SysEventService.buildAuditLogData        → AuditLogJob.metadata
 *   AuditLogProcessor.process                → AuditLog row `metadata` column
 *
 * No schema change: the AuditLog `metadata` JSONB column already existed and
 * was simply never populated on this path.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditAction, JobQueue, ResourceType, SysEventType } from '@arcaai/domains';
import { BaseService } from '../../common/base.service';
import { SysEventService } from '../sysEvent/sysEvent.service';
import { AuditLogProcessor } from '../auditLog/auditLog.processor';

// ─── BaseService.broadcastSysEvent ──────────────────────────────────────────

class ProbeService extends BaseService {
  constructor(eventEmitter: any, cls: any) {
    super(eventEmitter, cls, ResourceType.UserSettings);
  }
}

function buildCls(user: Record<string, unknown> | null) {
  return {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return 'tenant-1';
      if (key === 'correlationId') return 'corr-1';
      if (key === 'requestIp') return '10.0.0.1';
      return null;
    }),
    set: vi.fn(),
  };
}

describe('BaseService.broadcastSysEvent — impersonation provenance', () => {
  beforeEach(() => vi.clearAllMocks());

  it('threads metaData.impersonatedBy when the CLS user is impersonated', () => {
    const emitter = { emit: vi.fn() };
    const service = new ProbeService(emitter, buildCls({ id: 'doctor-1', impersonatedBy: 'admin-1' }));

    service.broadcastSysEvent(SysEventType.ResourceUpdated, { resourceId: 'pref-1', data: { theme: 'dark' } });

    const [, payload] = emitter.emit.mock.calls[0];
    expect(payload.responsibleEntityId).toBe('doctor-1');
    expect(payload.tenantId).toBe('tenant-1');
    expect(payload.metaData).toEqual({ impersonatedBy: 'admin-1' });
  });

  it('preserves caller-supplied metaData keys while adding impersonatedBy', () => {
    const emitter = { emit: vi.fn() };
    const service = new ProbeService(emitter, buildCls({ id: 'doctor-1', impersonatedBy: 'admin-1' }));

    service.broadcastSysEvent(SysEventType.ResourceUpdated, { metaData: { source: 'bulk' } });

    const [, payload] = emitter.emit.mock.calls[0];
    expect(payload.metaData).toEqual({ source: 'bulk', impersonatedBy: 'admin-1' });
  });

  it('does NOT inject metaData for a non-impersonated session', () => {
    const emitter = { emit: vi.fn() };
    const service = new ProbeService(emitter, buildCls({ id: 'doctor-1' }));

    service.broadcastSysEvent(SysEventType.ResourceUpdated, { resourceId: 'pref-1' });

    const [, payload] = emitter.emit.mock.calls[0];
    expect(payload.metaData).toBeUndefined();
  });

  it('cannot be spoofed: payload impersonatedBy is overwritten by the CLS claim', () => {
    const emitter = { emit: vi.fn() };
    const service = new ProbeService(emitter, buildCls({ id: 'doctor-1', impersonatedBy: 'admin-1' }));

    service.broadcastSysEvent(SysEventType.ResourceUpdated, { metaData: { impersonatedBy: 'forged-actor' } });

    const [, payload] = emitter.emit.mock.calls[0];
    expect(payload.metaData).toEqual({ impersonatedBy: 'admin-1' });
  });
});

// ─── SysEventService → AuditLogJob.metadata ─────────────────────────────────

describe('SysEventService — AuditLogJob carries event.metaData', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps metaData into the queued audit-log job for UPDATE events', async () => {
    const addJob = vi.fn().mockResolvedValue(undefined);
    const service = new SysEventService({ addJob } as never, {} as never);

    await service.handleResourceUpdatedEvent({
      id: 'evt-1',
      type: SysEventType.ResourceUpdated,
      resourceId: 'pref-1',
      resourceType: ResourceType.UserSettings,
      responsibleEntityId: 'doctor-1',
      responsibleEntityType: ResourceType.User,
      metaData: { impersonatedBy: 'admin-1' },
      data: { theme: 'dark' },
      tenantId: 'tenant-1',
      disableAuditLog: false,
      forceAuditLog: false,
      correlationId: 'corr-1',
      createdAt: new Date(),
    } as never);

    const auditJob = addJob.mock.calls.find(([args]) => args.queueName === JobQueue.AuditLog)?.[0];
    expect(auditJob).toBeTruthy();
    expect(auditJob.data).toEqual(
      expect.objectContaining({
        action: AuditAction.UPDATE,
        responsibleUserId: 'doctor-1',
        metadata: { impersonatedBy: 'admin-1' },
        tenantId: 'tenant-1',
      }),
    );
  });
});

// ─── AuditLogProcessor → persisted row metadata ─────────────────────────────

describe('AuditLogProcessor — persists job.metadata on the row', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes metadata through the factory to the created entity', async () => {
    const created: unknown[] = [];
    const auditLogRepository = { create: vi.fn(async (entity: unknown) => created.push(entity)) };
    const cls = {
      run: vi.fn(async (cb: () => Promise<void>) => cb()),
      set: vi.fn(),
    };
    const processor = new AuditLogProcessor(auditLogRepository as never, cls as never);

    await processor.process({
      data: {
        action: AuditAction.UPDATE,
        responsibleUserId: 'doctor-1',
        responsibleIp: '10.0.0.1',
        resourceId: 'pref-1',
        resourceType: ResourceType.UserSettings,
        data: { theme: 'dark' },
        previousData: {},
        metadata: { impersonatedBy: 'admin-1' },
        correlationId: 'corr-1',
        tenantId: 'tenant-1',
      },
    } as never);

    expect(created).toHaveLength(1);
    const entity = created[0] as { metadata: unknown; responsibleUserId: string; tenantId: string };
    expect(entity.metadata).toEqual({ impersonatedBy: 'admin-1' });
    expect(entity.responsibleUserId).toBe('doctor-1');
    expect(entity.tenantId).toBe('tenant-1');
  });

  it('defaults metadata to null when the job carries none (legacy queue entries)', async () => {
    const created: unknown[] = [];
    const auditLogRepository = { create: vi.fn(async (entity: unknown) => created.push(entity)) };
    const cls = { run: vi.fn(async (cb: () => Promise<void>) => cb()), set: vi.fn() };
    const processor = new AuditLogProcessor(auditLogRepository as never, cls as never);

    await processor.process({
      data: {
        action: AuditAction.CREATE,
        responsibleUserId: 'doctor-1',
        resourceType: ResourceType.UserSettings,
        data: {},
        previousData: {},
        tenantId: 'tenant-1',
      },
    } as never);

    expect((created[0] as { metadata: unknown }).metadata).toBeNull();
  });
});
