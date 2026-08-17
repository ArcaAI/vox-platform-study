/**
 * webhook-delivery.processor.ts unit tests.
 *
 * Two processor classes, one per queue (see the file's header for the
 * two-stage rationale):
 *  - `WebhookDeliveryProcessor` (`@Processor(JobQueue.SysEvent)`) — matches a
 *    fired SysEvent against subscribed, ENABLED `Webhook` rows and fans out
 *    one `JobQueue.WebhookDelivery` job per match.
 *  - `WebhookDeliveryDispatchProcessor` (`@Processor(JobQueue.WebhookDelivery)`)
 *    — signs + POSTs to exactly one webhook and records the attempt.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHmac } from 'crypto';
import { ResourceStatusType, WebhookRunStatus } from '@arcaai/domains';
import { WebhookDeliveryProcessor, WebhookDeliveryDispatchProcessor, WEBHOOK_DELIVERY_JOB_OPTIONS } from '../webhook-delivery.processor';
import { WebhookService } from '../webhook.service';

const mockClsService = {
  run: vi.fn((cb: () => unknown) => cb()),
  get: vi.fn(),
  set: vi.fn(),
};

const mockWebhookRepository = {
  findAll: vi.fn(),
  findById: vi.fn(),
};

const mockWebhookRunHistoryRepository = {
  findAll: vi.fn(),
  create: vi.fn(),
};

const mockDeliveryQueue = {
  add: vi.fn(),
};

const mockHttpService = {
  axiosRef: {
    post: vi.fn(),
  },
};

const baseSysEvent = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  type: 'SysEvent.ResourceUpdated',
  resourceId: 'consultation-123',
  resourceType: 'Consultation',
  responsibleEntityId: 'user-1',
  tenantId: 'tenant-1',
  createdAt: new Date('2026-08-16T10:00:00Z'),
  data: { secret: 'should-never-leave-the-platform' },
  ...overrides,
});

const mockWebhookEntity = (overrides: Record<string, unknown> = {}) => ({
  id: 'webhook-1',
  tenantId: 'tenant-1',
  url: 'https://receiver.example.com/hook',
  hashedSecret: WebhookService.encryptSecret('raw-secret-value'),
  resourceTypeName: 'Consultation',
  resourceId: null,
  resourceStatus: ResourceStatusType.ENABLED,
  ...overrides,
});

describe('WebhookDeliveryProcessor (matcher — @Processor(JobQueue.SysEvent))', () => {
  let processor: WebhookDeliveryProcessor;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.run.mockImplementation((cb: () => unknown) => cb());
    processor = new WebhookDeliveryProcessor(mockWebhookRepository as any, mockClsService as any, mockDeliveryQueue as any);
  });

  it('fans out one WebhookDelivery job per matching ENABLED webhook', async () => {
    const webhook = mockWebhookEntity({ id: 'webhook-1' });
    mockWebhookRepository.findAll.mockResolvedValue([webhook]);

    await processor.process({ data: { id: 'job-1', data: baseSysEvent() } } as never);

    expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-1',
          resourceTypeName: 'Consultation',
          resourceStatus: ResourceStatusType.ENABLED,
        }),
      }),
    );
    expect(mockDeliveryQueue.add).toHaveBeenCalledTimes(1);
    const [jobName, payload, opts] = mockDeliveryQueue.add.mock.calls[0];
    expect(jobName).toBe('WebhookDelivery');
    expect(payload).toMatchObject({
      webhookId: 'webhook-1',
      tenantId: 'tenant-1',
      sourceEnvelopeId: 'event-1',
      eventType: 'SysEvent.ResourceUpdated',
      resourceType: 'Consultation',
      resourceId: 'consultation-123',
    });
    expect(opts).toMatchObject({ ...WEBHOOK_DELIVERY_JOB_OPTIONS, jobId: 'hook:webhook-1:event-1' });
  });

  // Every other case in this describe hands the processor a real `Date`, which
  // is what `SysEvent.createdAt`'s TYPE promises but NOT what production
  // delivers: the event arrives through BullMQ, so JSON has already turned it
  // into an ISO string. Calling `.toISOString()` on that threw
  // "event.createdAt.toISOString is not a function", failing EVERY sys-event job
  // and silently disabling webhook delivery platform-wide.
  it('accepts the ISO-STRING createdAt that BullMQ actually delivers (not just a Date)', async () => {
    mockWebhookRepository.findAll.mockResolvedValue([mockWebhookEntity()]);

    await processor.process({
      data: { id: 'job-1', data: baseSysEvent({ createdAt: '2026-08-16T10:00:00.000Z' }) },
    } as never);

    expect(mockDeliveryQueue.add).toHaveBeenCalledTimes(1);
    expect(mockDeliveryQueue.add.mock.calls[0][1]).toMatchObject({ occurredAt: '2026-08-16T10:00:00.000Z' });
  });

  it('normalises a Date createdAt to the same ISO string (in-process callers keep working)', async () => {
    mockWebhookRepository.findAll.mockResolvedValue([mockWebhookEntity()]);

    await processor.process({ data: { id: 'job-1', data: baseSysEvent() } } as never);

    expect(mockDeliveryQueue.add.mock.calls[0][1]).toMatchObject({ occurredAt: '2026-08-16T10:00:00.000Z' });
  });

  it('is a no-op when no Webhook row matches the event (no HTTP call, no enqueue)', async () => {
    mockWebhookRepository.findAll.mockResolvedValue([]);

    await processor.process({ data: { id: 'job-2', data: baseSysEvent() } } as never);

    expect(mockDeliveryQueue.add).not.toHaveBeenCalled();
  });

  it('never matches a DISABLED webhook (filters resourceStatus: ENABLED explicitly)', async () => {
    // The repository mock simulates the DB-level filter by returning empty —
    // what we're really pinning is that the query WHERE clause explicitly
    // asks for ENABLED, not that this test hand-filters.
    mockWebhookRepository.findAll.mockResolvedValue([]);

    await processor.process({ data: { id: 'job-3', data: baseSysEvent() } } as never);

    expect(mockWebhookRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ resourceStatus: ResourceStatusType.ENABLED }) }),
    );
    expect(mockDeliveryQueue.add).not.toHaveBeenCalled();
  });

  it('matches a wildcard (resourceId null or empty string) subscription regardless of the event resourceId', async () => {
    mockWebhookRepository.findAll.mockResolvedValue([mockWebhookEntity({ id: 'wildcard-webhook', resourceId: null })]);

    await processor.process({ data: { id: 'job-4', data: baseSysEvent({ resourceId: 'some-other-id' }) } } as never);

    const [, payload] = mockDeliveryQueue.add.mock.calls[0];
    expect(payload).toMatchObject({ webhookId: 'wildcard-webhook' });
  });

  it('is a no-op for a tenant-less event (no Webhook.tenantId is ever null)', async () => {
    await processor.process({ data: { id: 'job-5', data: baseSysEvent({ tenantId: undefined }) } } as never);

    expect(mockWebhookRepository.findAll).not.toHaveBeenCalled();
    expect(mockDeliveryQueue.add).not.toHaveBeenCalled();
  });
});

describe('WebhookDeliveryDispatchProcessor (sender — @Processor(JobQueue.WebhookDelivery))', () => {
  let processor: WebhookDeliveryDispatchProcessor;

  const jobPayload = (overrides: Record<string, unknown> = {}) => ({
    webhookId: 'webhook-1',
    tenantId: 'tenant-1',
    sourceEnvelopeId: 'event-1',
    eventType: 'SysEvent.ResourceUpdated',
    resourceType: 'Consultation',
    resourceId: 'consultation-123',
    occurredAt: '2026-08-16T10:00:00.000Z',
    ...overrides,
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.run.mockImplementation((cb: () => unknown) => cb());
    mockWebhookRunHistoryRepository.findAll.mockResolvedValue([]); // no prior delivery, by default
    processor = new WebhookDeliveryDispatchProcessor(
      mockWebhookRepository as any,
      mockWebhookRunHistoryRepository as any,
      mockHttpService as any,
      mockClsService as any,
      undefined,
    );
  });

  it('(a) signs the payload, POSTs, and records a SUCCESS row on a 2xx response', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockHttpService.axiosRef.post.mockResolvedValue({ status: 200, data: { ok: true } });

    await processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never);

    expect(mockHttpService.axiosRef.post).toHaveBeenCalledTimes(1);
    const [url, body, config] = mockHttpService.axiosRef.post.mock.calls[0];
    expect(url).toBe('https://receiver.example.com/hook');

    const parsedBody = JSON.parse(body);
    // Reference-not-content contract (§3): never SysEvent.data / resource content.
    expect(parsedBody).toEqual({
      eventType: 'SysEvent.ResourceUpdated',
      resourceType: 'Consultation',
      resourceId: 'consultation-123',
      tenantId: 'tenant-1',
      occurredAt: '2026-08-16T10:00:00.000Z',
      fetchUrl: expect.stringContaining('/api/v1/admin/consultations/consultation-123'),
    });
    expect(JSON.stringify(parsedBody)).not.toContain('should-never-leave-the-platform');

    expect(config.headers['X-Hope-Webhook-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/);
    const expectedSignature = createHmac('sha256', 'raw-secret-value').update(body).digest('hex');
    expect(config.headers['X-Hope-Webhook-Signature']).toBe(`sha256=${expectedSignature}`);

    expect(mockWebhookRunHistoryRepository.create).toHaveBeenCalledTimes(1);
    const createdEntity = mockWebhookRunHistoryRepository.create.mock.calls[0][0];
    expect(createdEntity.status).toBe(WebhookRunStatus.SUCCESS);
    expect(createdEntity.responeStatusCode).toBe(200);
    expect(createdEntity.webhookId).toBe('webhook-1');
  });

  it('(b) records FAILED and THROWS on a non-2xx response (mid-retry — BullMQ governs redelivery)', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockHttpService.axiosRef.post.mockResolvedValue({ status: 500, data: { error: 'boom' } });

    await expect(processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never)).rejects.toThrow();

    const createdEntity = mockWebhookRunHistoryRepository.create.mock.calls[0][0];
    expect(createdEntity.status).toBe(WebhookRunStatus.FAILED);
    expect(createdEntity.responeStatusCode).toBe(500);
  });

  it('(b) records FAILED and THROWS on a network-level error (no response reached)', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockHttpService.axiosRef.post.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never)).rejects.toThrow(
      'ECONNREFUSED',
    );

    const createdEntity = mockWebhookRunHistoryRepository.create.mock.calls[0][0];
    expect(createdEntity.status).toBe(WebhookRunStatus.FAILED);
  });

  it('(c) is a no-op when no Webhook row matches (deleted between fan-out and dispatch)', async () => {
    mockWebhookRepository.findById.mockRejectedValue(new Error('not found'));

    await processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never);

    expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
    expect(mockWebhookRunHistoryRepository.create).not.toHaveBeenCalled();
  });

  it('(d) never sends to a DISABLED webhook (disabled between fan-out and dispatch)', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity({ resourceStatus: ResourceStatusType.DISABLED }));

    await processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never);

    expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
    expect(mockWebhookRunHistoryRepository.create).not.toHaveBeenCalled();
  });

  it('(e) records DEAD_LETTERED (not FAILED) on the final configured attempt, and still throws', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockHttpService.axiosRef.post.mockResolvedValue({ status: 503, data: 'unavailable' });

    // attempts: 5 total; attemptsMade: 4 means this IS the 5th (final) try.
    await expect(processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 4 } as never)).rejects.toThrow();

    const createdEntity = mockWebhookRunHistoryRepository.create.mock.calls[0][0];
    expect(createdEntity.status).toBe(WebhookRunStatus.DEAD_LETTERED);
  });

  it('skips sending (idempotent no-op) when this exact event already SUCCEEDED for this webhook', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockWebhookRunHistoryRepository.findAll.mockResolvedValue([{ id: 'prior-run', status: WebhookRunStatus.SUCCESS }]);

    await processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never);

    expect(mockHttpService.axiosRef.post).not.toHaveBeenCalled();
    expect(mockWebhookRunHistoryRepository.create).not.toHaveBeenCalled();
    expect(mockWebhookRunHistoryRepository.findAll).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ webhookId: 'webhook-1', status: WebhookRunStatus.SUCCESS }),
      }),
    );
  });

  it('caps a huge response body before persisting it', async () => {
    mockWebhookRepository.findById.mockResolvedValue(mockWebhookEntity());
    mockHttpService.axiosRef.post.mockResolvedValue({ status: 200, data: 'x'.repeat(10_000) });

    await processor.process({ data: jobPayload(), opts: { attempts: 5 }, attemptsMade: 0 } as never);

    const createdEntity = mockWebhookRunHistoryRepository.create.mock.calls[0][0];
    const stored = JSON.stringify(createdEntity.response);
    expect(stored.length).toBeLessThan(6_000);
  });
});
