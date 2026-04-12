import type { AuditLogJob } from '@arcaai/domains';
import type { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditLogProcessor } from '../auditLog.processor';

// Mock repository
const mockAuditLogRepository = {
  create: vi.fn(),
};

function createMockJob(data: AuditLogJob): Job<AuditLogJob> {
  return { data, id: 'job-1', name: 'audit-log' } as unknown as Job<AuditLogJob>;
}

describe('AuditLogProcessor', () => {
  let processor: AuditLogProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    processor = new AuditLogProcessor(mockAuditLogRepository as any);
  });

  it('should create an AuditLogEntity from job data and persist it', async () => {
    const jobData: AuditLogJob = {
      action: 'CREATE' as any,
      responsibleUserId: 'user-123',
      responsibleIp: '192.168.1.1',
      resourceId: 'resource-456',
      resourceType: 'Consultation' as any,
      data: { consultationId: 'c-1', type: 'TRANSCRIPT' },
      previousData: null,
      correlationId: 'corr-789',
      tenantId: 'tenant-abc',
    };

    mockAuditLogRepository.create.mockResolvedValue({});

    await processor.process(createMockJob(jobData));

    expect(mockAuditLogRepository.create).toHaveBeenCalledTimes(1);
    const entity = mockAuditLogRepository.create.mock.calls[0][0];
    expect(entity.action).toBe('CREATE');
    expect(entity.responsibleUserId).toBe('user-123');
    expect(entity.responsibleIp).toBe('192.168.1.1');
    expect(entity.resourceId).toBe('resource-456');
    expect(entity.resourceType).toBe('Consultation');
    expect(entity.data).toEqual({ consultationId: 'c-1', type: 'TRANSCRIPT' });
    expect(entity.previousData).toEqual({});
    expect(entity.correlationId).toBe('corr-789');
    expect(entity.tenantId).toBe('tenant-abc');
  });

  it('should handle job data with missing optional fields', async () => {
    const jobData: AuditLogJob = {
      action: 'DELETE' as any,
      responsibleUserId: '',
      resourceType: 'Media' as any,
    };

    mockAuditLogRepository.create.mockResolvedValue({});

    await processor.process(createMockJob(jobData));

    expect(mockAuditLogRepository.create).toHaveBeenCalledTimes(1);
    const entity = mockAuditLogRepository.create.mock.calls[0][0];
    expect(entity.action).toBe('DELETE');
    expect(entity.resourceType).toBe('Media');
  });

  it('should propagate repository errors', async () => {
    const jobData: AuditLogJob = {
      action: 'UPDATE' as any,
      responsibleUserId: 'user-1',
      resourceType: 'ContextItem' as any,
    };

    mockAuditLogRepository.create.mockRejectedValue(new Error('DB connection failed'));

    await expect(processor.process(createMockJob(jobData))).rejects.toThrow('DB connection failed');
  });
});
