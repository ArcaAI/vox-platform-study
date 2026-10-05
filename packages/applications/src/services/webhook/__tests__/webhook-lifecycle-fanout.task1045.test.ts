import { describe, it, expect, vi } from 'vitest';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JobQueue, ResourceStatusType, SysEventType } from '@arcaai/domains';
import { ConsultationLifecycleEventPublisher } from '../../consultation/lifecycle/lifecycle-event.publisher';
import { SysEventService } from '../../sysEvent/sysEvent.service';
import { WebhookDeliveryProcessor } from '../webhook-delivery.processor';

const TENANT = 'tenant-1';
const subject = {
  id: 'c-1',
  tenantId: TENANT,
  status: 'RECORDING',
  processing: 'IDLE',
  currentEncounterSeq: 1,
  version: 2,
};

function wire() {
  const emitter = new EventEmitter2();
  const cls = { get: vi.fn((k: string) => (k === 'tenantId' ? TENANT : undefined)), set: vi.fn(), getId: vi.fn(), run: vi.fn((cb: () => unknown) => cb()) };
  const sysJobs: Array<{ jobType: string; data: { id: string; data: unknown } }> = [];
  const redis = {
    addJob: vi.fn(async (job: { queueName: string; jobType: string; data: { id: string; data: unknown } }) => {
      if (job.queueName === JobQueue.SysEvent) sysJobs.push(job);
    }),
  };
  const sys = new SysEventService(redis as never, { addSubscription: vi.fn() } as never);
  emitter.on(SysEventType.ResourceUpdated, (e) => sys.handleResourceUpdatedEvent(e));
  const publisher = new ConsultationLifecycleEventPublisher(emitter, cls as never);

  const webhook = { id: 'wh-1', resourceStatus: ResourceStatusType.ENABLED };
  const repo = { findAll: vi.fn().mockResolvedValue([webhook]) };
  const deliveryQueue = { add: vi.fn() };
  const matcher = new WebhookDeliveryProcessor(repo as never, cls as never, deliveryQueue as never);
  return { publisher, sysJobs, matcher, deliveryQueue };
}

describe('lifecycle events reach the webhook fan-out', () => {
  it.each(['opened', 'started', 'paused', 'stopped', 'transcript_final', 'processing_changed', 'approved', 'closed', 'reopened', 'encounter_appended'] as const)(
    '%s produces exactly one delivery job carrying action + event',
    async (type) => {
      const { publisher, sysJobs, matcher, deliveryQueue } = wire();
      await publisher.publish(subject, type);
      expect(sysJobs).toHaveLength(1);

      // The queue serialises the envelope; replay that round trip.
      const job = JSON.parse(JSON.stringify(sysJobs[0]));
      await matcher.process({ data: job.data } as never);

      expect(deliveryQueue.add).toHaveBeenCalledTimes(1);
      const payload = deliveryQueue.add.mock.calls[0][1];
      expect(payload).toMatchObject({ webhookId: 'wh-1', resourceType: 'Consultation', resourceId: 'c-1', action: 'lifecycle', event: type });
      expect(Number.isNaN(Date.parse(payload.occurredAt))).toBe(false);
    },
  );
});
