/**
 * ConsultationController — trajectory / loop SSE teardown race (M-01).
 *
 * Both relays subscribe to their Redis channel inside an async IIFE and only
 * assign the resulting subscription AFTER the await. RxJS runs the Observable
 * teardown the instant the subscriber leaves, so a client that aborts during
 * the SUBSCRIBE round-trip (StrictMode double-mount, navigation during load,
 * EventSource reconnect storm) used to leave the refcount incremented by
 * `subscribeToChannel` permanently held — a pinned Subject and a live Redis
 * SUBSCRIBE per aborted request.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { Subject, finalize, type Observable } from 'rxjs';
import { ConsultationController } from '../consultation.controller';

/** Refcounted RedisSubscriberService fake, gated so the test owns the timing. */
function buildGatedSubscriber() {
  const channels = new Map<string, Subject<string>>();
  const refCounts = new Map<string, number>();
  const gates: Array<() => void> = [];

  const fake = {
    subscribeToChannel: vi.fn(async (channel: string): Promise<Observable<string>> => {
      await new Promise<void>((resolve) => gates.push(resolve)); // Redis SUBSCRIBE round-trip
      if (!channels.has(channel)) {
        channels.set(channel, new Subject<string>());
        refCounts.set(channel, 0);
      }
      refCounts.set(channel, (refCounts.get(channel) ?? 0) + 1);
      return channels
        .get(channel)!
        .asObservable()
        .pipe(
          finalize(() => {
            const next = (refCounts.get(channel) ?? 1) - 1;
            if (next <= 0) fake.unsubscribeFromChannel(channel);
            else refCounts.set(channel, next);
          }),
        );
    }),
    unsubscribeFromChannel: vi.fn((channel: string) => {
      channels.get(channel)?.complete();
      channels.delete(channel);
      refCounts.delete(channel);
    }),
    releaseGates() {
      gates.splice(0).forEach((resolve) => resolve());
    },
    refCount(channel: string) {
      return refCounts.get(channel) ?? 0;
    },
    hasChannel(channel: string) {
      return channels.has(channel);
    },
  };
  return fake;
}

function buildController(redisSubscriber: unknown): ConsultationController {
  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  (controller as unknown as { redisSubscriber: unknown }).redisSubscriber = redisSubscriber;
  (controller as unknown as { logger: Logger }).logger = new Logger('test');
  return controller;
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('ConsultationController SSE teardown during subscription setup', () => {
  it('trajectory stream releases the Redis channel when the client aborts before SUBSCRIBE resolves', async () => {
    const redisSubscriber = buildGatedSubscriber();
    const controller = buildController(redisSubscriber);

    const sub = controller.streamTrajectory('c1').subscribe();
    sub.unsubscribe();
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount('consultation:trajectory:c1')).toBe(0);
    expect(redisSubscriber.hasChannel('consultation:trajectory:c1')).toBe(false);
  });

  it('loop stream releases the Redis channel when the client aborts before SUBSCRIBE resolves', async () => {
    const redisSubscriber = buildGatedSubscriber();
    const controller = buildController(redisSubscriber);

    const sub = controller.streamLoop('c1').subscribe();
    sub.unsubscribe();
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount('consultation:loop:c1')).toBe(0);
    expect(redisSubscriber.hasChannel('consultation:loop:c1')).toBe(false);
  });
});
