/**
 * SSE ↔ Redis channel teardown contract (M-01 / M-02).
 *
 * M-01 — subscription setup races teardown: every consultation SSE relay
 * subscribes to its Redis channel inside an async IIFE and only assigns the
 * resulting subscription AFTER the await. RxJS runs the Observable teardown
 * immediately when the subscriber leaves before that assignment, so the
 * refcount incremented by `subscribeToChannel` is never released — a pinned
 * Subject and a live Redis SUBSCRIBE per aborted request. Triggers are
 * routine (StrictMode double-mount, navigation during load, EventSource
 * reconnect storms).
 *
 * M-02 — force-completing the SHARED per-channel Subject:
 * `unsubscribeFromChannel` completes the Subject and drops the refcount entry
 * regardless of how many viewers remain, so the first viewer to disconnect
 * completes everyone else's stream.
 */
import { describe, it, expect, vi } from 'vitest';
import { Subject, finalize, type Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import { HarnessProgressService } from '../harness/harness-progress.service';
import { HarnessAssuranceService } from '../harness/harness-assurance.service';
import { LiveDocumentationService } from '../live-documentation/live-documentation.service';
import { ConsultationJobService } from '../jobs/consultation-job.service';

/**
 * Fake mirroring RedisSubscriberService's refcounting contract, with a gate so
 * a test can hold `subscribeToChannel` unresolved across the teardown window.
 */
function buildRefcountedSubscriber(options: { gated?: boolean } = {}) {
  const channels = new Map<string, Subject<string>>();
  const refCounts = new Map<string, number>();
  const gates: Array<() => void> = [];

  const fake = {
    subscribeToChannel: vi.fn(async (channel: string): Promise<Observable<string>> => {
      // Models the Redis SUBSCRIBE round-trip that precedes the refcount bump.
      if (options.gated) {
        await new Promise<void>((resolve) => gates.push(resolve));
      }
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
    /** Release every gated `subscribeToChannel` call. */
    releaseGates() {
      gates.splice(0).forEach((resolve) => resolve());
    },
    publish(channel: string, message: string) {
      channels.get(channel)?.next(message);
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

/** Let queued microtasks (and the gated promise chain) settle. */
const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function cacheStub(snapshot: string | null = null) {
  return {
    get: vi.fn().mockResolvedValue(snapshot),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
  };
}

describe('M-01 — teardown during async subscription setup releases the Redis channel', () => {
  it('HarnessProgressService.subscribeToProgress', async () => {
    const redisSubscriber = buildRefcountedSubscriber({ gated: true });
    const service = new HarnessProgressService(cacheStub() as never, redisSubscriber as never);
    const channel = 'consultation:harness-progress:c1';

    const sub = service.subscribeToProgress('c1').subscribe();
    sub.unsubscribe(); // client aborted before SUBSCRIBE resolved
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount(channel)).toBe(0);
    expect(redisSubscriber.hasChannel(channel)).toBe(false);
  });

  it('HarnessAssuranceService.subscribeToAssurance', async () => {
    const redisSubscriber = buildRefcountedSubscriber({ gated: true });
    const service = new HarnessAssuranceService(cacheStub() as never, redisSubscriber as never);
    const channel = 'consultation:harness-assurance:c1';

    const sub = service.subscribeToAssurance('c1').subscribe();
    sub.unsubscribe();
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount(channel)).toBe(0);
    expect(redisSubscriber.hasChannel(channel)).toBe(false);
  });

  it('LiveDocumentationService.subscribeToLiveSummary', async () => {
    const redisSubscriber = buildRefcountedSubscriber({ gated: true });
    const configService = { get: vi.fn().mockReturnValue(15000) };
    const service = new LiveDocumentationService(null as never, configService as never, cacheStub() as never, redisSubscriber as never);
    const channel = 'consultation:live-summary:c1';

    const sub = service.subscribeToLiveSummary('c1').subscribe();
    sub.unsubscribe();
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount(channel)).toBe(0);
    expect(redisSubscriber.hasChannel(channel)).toBe(false);
  });

  it('ConsultationJobService.subscribeToJobUpdates', async () => {
    const redisSubscriber = buildRefcountedSubscriber({ gated: true });
    const cache = cacheStub(JSON.stringify({ jobId: 'j1', status: 'PROCESSING', type: 'PRE_SUMMARY', createdAt: new Date().toISOString() }));
    const service = new ConsultationJobService(null as never, null as never, cache as never, redisSubscriber as never);
    const channel = 'consultation_job_updates:j1';

    const sub = service.subscribeToJobUpdates('j1').subscribe();
    sub.unsubscribe();
    redisSubscriber.releaseGates();
    await settle();

    expect(redisSubscriber.refCount(channel)).toBe(0);
    expect(redisSubscriber.hasChannel(channel)).toBe(false);
  });
});

describe('M-02 — one viewer leaving must not complete a concurrent viewer’s stream', () => {
  it('ConsultationJobService.subscribeToJobUpdates keeps the survivor receiving published updates', async () => {
    const redisSubscriber = buildRefcountedSubscriber();
    const cache = cacheStub(JSON.stringify({ jobId: 'j1', status: 'PROCESSING', type: 'PRE_SUMMARY', createdAt: new Date().toISOString() }));
    const service = new ConsultationJobService(null as never, null as never, cache as never, redisSubscriber as never);
    const channel = 'consultation_job_updates:j1';

    const survivorEvents: MessageEvent[] = [];
    let survivorCompleted = false;

    const first = service.subscribeToJobUpdates('j1').subscribe();
    const survivor = service.subscribeToJobUpdates('j1').subscribe({
      next: (event) => survivorEvents.push(event),
      complete: () => {
        survivorCompleted = true;
      },
    });
    await settle();
    expect(redisSubscriber.refCount(channel)).toBe(2);

    first.unsubscribe();
    await settle();

    redisSubscriber.publish(channel, JSON.stringify({ jobId: 'j1', status: 'PROCESSING', progress: 42 }));
    await settle();

    expect(survivorCompleted).toBe(false);
    // Initial status event + the update published after the other viewer left.
    expect(survivorEvents.map((event) => JSON.parse(event.data as string).progress)).toContain(42);
    expect(redisSubscriber.refCount(channel)).toBe(1);

    survivor.unsubscribe();
    await settle();
    expect(redisSubscriber.hasChannel(channel)).toBe(false);
  });
});
