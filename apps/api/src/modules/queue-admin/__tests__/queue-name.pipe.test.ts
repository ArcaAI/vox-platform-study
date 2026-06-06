import { describe, it, expect } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { JobQueue } from '@arcaai/domains';
import { QueueNamePipe } from '../pipes/queue-name.pipe';

// Validates `:queueName` against the registered JobQueue enum so an unknown
// queue returns a clean 404 instead of an opaque provider-not-found 500 when
// the service resolves the BullMQ queue token.
describe('QueueNamePipe', () => {
  const pipe = new QueueNamePipe();

  it('passes through a registered queue name', () => {
    expect(pipe.transform(JobQueue.SendEmail)).toBe(JobQueue.SendEmail);
  });

  it('throws NotFoundException for an unregistered queue name', () => {
    expect(() => pipe.transform('NotAQueue')).toThrow(NotFoundException);
  });
});
