/**
 * AuditLogProcessor.
 *
 * BullMQ WorkerHost processors run OUTSIDE the API edge ClsModule middleware
 * that the `tenantScope` Prisma extension reads from. Without these
 * guards the extension hits its "no CLS = super-admin pass-through" branch
 * and the write silently bypasses tenant scoping.
 *
 * This processor only writes (`auditLogRepository.create`) — it never loads
 * an entity by id — so we deliberately skip `assertEqualTenants`. The
 * factory's required `tenantId` parameter + the fail-closed guard below
 * are sufficient invariants.
 */

import type { AuditLogJob } from '@arcaai/domains';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogProcessor } from '../auditLog.processor';

// Mock ClsService — mirrors W3.3's pattern: `run` invokes the callback
// synchronously and `set` records into an in-memory map so we can assert
// on the key/value pairs the processor wrote into CLS.
const createMockClsService = () => {
  const store = new Map<string, unknown>();
  return {
    run: vi.fn((...args: unknown[]) => {
      const callback = (args.length === 1 ? args[0] : args[1]) as () => unknown;
      return callback();
    }),
    set: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
    }),
    get: vi.fn((key?: string) => (key === undefined ? Object.fromEntries(store) : store.get(key))),
  };
};

const createMockAuditLogRepository = () => ({
  create: vi.fn(),
});

function createMockJob(data: AuditLogJob): Job<AuditLogJob> {
  return { data, id: 'job-1', name: 'audit-log' } as unknown as Job<AuditLogJob>;
}

const makeJobData = (overrides: Partial<AuditLogJob> = {}): AuditLogJob =>
  ({
    action: 'CREATE',
    responsibleUserId: 'user-123',
    responsibleIp: '192.168.1.1',
    resourceId: 'resource-456',
    resourceType: 'Consultation',
    data: { consultationId: 'c-1' },
    previousData: {},
    correlationId: 'corr-789',
    tenantId: 'tenant-A',
    ...overrides,
  }) as AuditLogJob;

describe('AuditLogProcessor — CLS rebind + fail-closed (TASK-305 D.9 follow-up)', () => {
  let processor: AuditLogProcessor;
  let mockAuditLogRepository: ReturnType<typeof createMockAuditLogRepository>;
  let mockClsService: ReturnType<typeof createMockClsService>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLogRepository = createMockAuditLogRepository();
    mockClsService = createMockClsService();
    processor = new AuditLogProcessor(mockAuditLogRepository as any, mockClsService as any);
  });

  it('wraps process() in cls.run with tenantId + user set before factory call', async () => {
    const setCallsBeforeCreate: Array<[string, unknown]> = [];
    mockAuditLogRepository.create.mockImplementation(async () => {
      // snapshot what was set into CLS BEFORE the repository write happened
      setCallsBeforeCreate.push(...mockClsService.set.mock.calls.map((c) => [c[0], c[1]] as [string, unknown]));
      return {};
    });

    await processor.process(createMockJob(makeJobData({ tenantId: 'tenant-A', responsibleUserId: 'user-A' })));

    expect(mockClsService.run).toHaveBeenCalledTimes(1);

    const keys = setCallsBeforeCreate.map(([k]) => k);
    expect(keys).toContain('tenantId');
    expect(keys).toContain('user');

    const tenantEntry = setCallsBeforeCreate.find(([k]) => k === 'tenantId');
    expect(tenantEntry?.[1]).toBe('tenant-A');

    const userEntry = setCallsBeforeCreate.find(([k]) => k === 'user');
    expect(userEntry?.[1]).toMatchObject({
      id: 'user-A',
      tenantId: 'tenant-A',
      roles: [],
      permissions: [],
    });

    expect(mockAuditLogRepository.create).toHaveBeenCalledTimes(1);
  });

  it('throws fail-closed when job.data.tenantId is missing', async () => {
    const payload = makeJobData({ tenantId: undefined as unknown as string });

    await expect(processor.process(createMockJob(payload))).rejects.toThrow(/tenantId/i);
  });

  it('does not call repository.create when tenantId is missing', async () => {
    const payload = makeJobData({ tenantId: undefined as unknown as string });

    await expect(processor.process(createMockJob(payload))).rejects.toThrow();

    expect(mockAuditLogRepository.create).not.toHaveBeenCalled();
  });
});
