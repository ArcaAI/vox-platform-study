import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ResourceStatusType } from '@arcaai/domains';
import { WebhookDeliveryProcessor, WebhookDeliveryDispatchProcessor } from '../webhook-delivery.processor';
import { WebhookService } from '../webhook.service';

const cls = { run: vi.fn((cb: () => unknown) => cb()), get: vi.fn(), set: vi.fn() };
const repo = { findAll: vi.fn(), findById: vi.fn() };
const history = { findAll: vi.fn(), create: vi.fn() };
const queue = { add: vi.fn() };
const http = { axiosRef: { post: vi.fn() } };

const webhook = {
  id: 'webhook-1',
  tenantId: 'tenant-1',
  url: 'https://receiver.example.com/hook',
  hashedSecret: WebhookService.encryptSecret('raw'),
  resourceTypeName: 'Consultation',
  resourceId: null,
  resourceStatus: ResourceStatusType.ENABLED,
};

const sysEvent = (data: Record<string, unknown>) => ({
  id: 'event-1',
  type: 'SysEvent.ResourceUpdated',
  resourceId: 'c-1',
  resourceType: 'Consultation',
  tenantId: 'tenant-1',
  createdAt: new Date('2026-08-16T10:00:00Z'),
  data,
});

describe('webhook lifecycle filtering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cls.run.mockImplementation((cb: () => unknown) => cb());
    history.findAll.mockResolvedValue([]);
    repo.findAll.mockResolvedValue([webhook]);
    repo.findById.mockResolvedValue(webhook);
    http.axiosRef.post.mockResolvedValue({ status: 200, data: {} });
  });

  it('fan-out carries action + event from a lifecycle sys-event and nothing else from data', async () => {
    const p = new WebhookDeliveryProcessor(repo as any, cls as any, queue as any);
    await p.process({
      data: { data: sysEvent({ action: 'lifecycle', event: 'approved', status: 'APPROVED', note: 'PHI text' }) },
    } as never);
    const payload = queue.add.mock.calls[0][1];
    expect(payload.action).toBe('lifecycle');
    expect(payload.event).toBe('approved');
    expect(JSON.stringify(payload)).not.toContain('PHI text');
  });

  it('non-lifecycle events carry no action/event', async () => {
    const p = new WebhookDeliveryProcessor(repo as any, cls as any, queue as any);
    await p.process({ data: { data: sysEvent({ action: 'rename', event: 'x' }) } } as never);
    const payload = queue.add.mock.calls[0][1];
    expect(payload.action).toBeUndefined();
    expect(payload.event).toBeUndefined();
  });

  it('outbound body exposes data.action and data.event', async () => {
    const d = new WebhookDeliveryDispatchProcessor(repo as any, history as any, http as any, cls as any, undefined);
    await d.process({
      data: {
        webhookId: 'webhook-1',
        tenantId: 'tenant-1',
        sourceEnvelopeId: 'event-1',
        eventType: 'SysEvent.ResourceUpdated',
        resourceType: 'Consultation',
        resourceId: 'c-1',
        occurredAt: '2026-08-16T10:00:00.000Z',
        action: 'lifecycle',
        event: 'closed',
      },
      opts: { attempts: 5 },
      attemptsMade: 0,
    } as never);
    const body = JSON.parse(http.axiosRef.post.mock.calls[0][1]);
    expect(body.data).toEqual({ action: 'lifecycle', event: 'closed' });
  });
});
