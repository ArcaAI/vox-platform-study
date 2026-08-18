/**
 * TASK-762 §5.6 — `BaseService.broadcastSysEvent` must be able to attribute a
 * mutation to a MACHINE actor.
 *
 * Before this ticket the method stamped `responsibleEntityId: this.requestUser?.id`
 * unconditionally, so an admin action performed by a machine credential landed
 * on `AuditLog.responsibleUserId` — the human the credential was bound to. This
 * suite pins the corrected behaviour in both directions, because the human path
 * must be provably unchanged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BaseService } from '../base.service';
import { SysEventType } from '@arcaai/domains';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

class TestService extends BaseService {
  constructor() {
    super(mockEventEmitter as unknown as EventEmitter2, mockClsService as any, 'TestResource' as any);
  }
  public broadcast(type: SysEventType, data: any) {
    return this.broadcastSysEvent(type, data);
  }
}

function clsWith(values: Record<string, unknown>) {
  mockClsService.get.mockImplementation((key: string) => values[key]);
}

describe('BaseService.broadcastSysEvent — machine actor attribution', () => {
  let service: TestService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new TestService();
  });

  it('stamps responsibleServiceAccountId and leaves responsibleEntityId undefined for a machine principal', () => {
    clsWith({
      serviceAccount: { id: 'sa-1', clientId: 'hope_svc_x', tenantId: 'tenant-a' },
      tenantId: 'tenant-a',
      requestIp: '10.0.0.1',
    });

    service.broadcast(SysEventType.ResourceUpdated, { resourceId: 'dept-1' });

    const [, payload] = mockEventEmitter.emit.mock.calls[0];
    expect(payload.responsibleServiceAccountId).toBe('sa-1');
    expect(payload.responsibleEntityId).toBeUndefined();
  });

  it('leaves the human path completely unchanged — no regression to existing attribution', () => {
    clsWith({ user: { id: 'user-1' }, tenantId: 'tenant-a', requestIp: '10.0.0.1' });

    service.broadcast(SysEventType.ResourceUpdated, { resourceId: 'dept-1' });

    const [, payload] = mockEventEmitter.emit.mock.calls[0];
    expect(payload.responsibleEntityId).toBe('user-1');
    expect(payload.responsibleServiceAccountId).toBeUndefined();
  });

  it('never emits both actors, even if CLS somehow carries a user AND a service account', () => {
    // Defence in depth: the guard sets only one of the two, but a future CLS
    // leak must not produce an unattributable audit row (the entity would
    // refuse it, and refusing at write time is a 500 the caller cannot fix).
    clsWith({
      user: { id: 'user-1' },
      serviceAccount: { id: 'sa-1', clientId: 'hope_svc_x', tenantId: 'tenant-a' },
      tenantId: 'tenant-a',
    });

    service.broadcast(SysEventType.ResourceUpdated, { resourceId: 'dept-1' });

    const [, payload] = mockEventEmitter.emit.mock.calls[0];
    expect(payload.responsibleServiceAccountId).toBe('sa-1');
    expect(payload.responsibleEntityId).toBeUndefined();
  });

  it('still lets an explicit caller-supplied actor override CLS (background jobs keep working)', () => {
    clsWith({ serviceAccount: { id: 'sa-1' }, tenantId: 'tenant-a' });

    service.broadcast(SysEventType.ResourceUpdated, { resourceId: 'dept-1', responsibleEntityId: 'user-explicit' });

    const [, payload] = mockEventEmitter.emit.mock.calls[0];
    expect(payload.responsibleEntityId).toBe('user-explicit');
  });
});
