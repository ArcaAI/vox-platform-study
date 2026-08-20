/**
 * `emit-openapi.ts` / `emit-route-manifest.ts` self-execute on import, so they
 * cannot be imported by a test. `offline-infrastructure.ts` is a plain module
 * for exactly that reason — the same split as `openapi/api-exclude-metadata.ts`.
 *
 * The queues are built with `Object.create(Queue.prototype)` rather than
 * `new Queue(...)`: a real BullMQ queue dials Redis from its constructor,
 * which is the very behaviour under test. The prototype link is what
 * `collectBullQueues`'s `instanceof` check reads, and `EventEmitter#on` is
 * reached through the same chain, so both halves are exercised for real.
 */
import { describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import type { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { collectBullQueues, silenceBullQueueConnectionErrors } from '../offline-infrastructure';

function fakeQueue(): Queue {
  return Object.create(Queue.prototype) as Queue;
}

/** The shape `collectBullQueues` walks: Map<module, { providers: Map<token, { instance }> }>. */
function containerOf(...modules: unknown[][]): ModulesContainer {
  const container = new Map<string, { providers: Map<string, { instance: unknown }> }>();
  modules.forEach((instances, moduleIndex) => {
    const providers = new Map<string, { instance: unknown }>();
    instances.forEach((instance, i) => providers.set(`token-${moduleIndex}-${i}`, { instance }));
    container.set(`module-${moduleIndex}`, { providers });
  });
  return container as unknown as ModulesContainer;
}

describe('collectBullQueues', () => {
  it('collects BullMQ queues and ignores every other provider', () => {
    const queue = fakeQueue();
    const container = containerOf([queue, { notAQueue: true }, 'string-provider', null, undefined]);

    expect(collectBullQueues(container)).toEqual([queue]);
  });

  it('de-duplicates the same queue instance reached through several modules', () => {
    const queue = fakeQueue();
    const container = containerOf([queue], [queue], [queue]);

    expect(collectBullQueues(container)).toEqual([queue]);
  });

  it('returns an empty list for a container with no queues', () => {
    expect(collectBullQueues(containerOf([{ notAQueue: true }]))).toEqual([]);
  });
});

describe('silenceBullQueueConnectionErrors', () => {
  it('gives every queue an error listener, so BullMQ never falls back to console.error', () => {
    const [a, b] = [fakeQueue(), fakeQueue()];
    const app = { get: vi.fn().mockReturnValue(containerOf([a], [b, { notAQueue: true }])) };

    const count = silenceBullQueueConnectionErrors(app as never);

    expect(count).toBe(2);
    expect(a.listenerCount('error')).toBe(1);
    expect(b.listenerCount('error')).toBe(1);
  });

  it('stops the console.error fallback that produced the raw stack dumps', () => {
    const queue = fakeQueue();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Reproduce the defect first: `QueueBase#emit` re-emits on 'error', Node
      // throws because nothing is listening, and BullMQ's last resort is
      // `console.error(err)` — the ~200 raw ECONNREFUSED dumps an offline emit
      // used to print.
      queue.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));
      expect(consoleError).toHaveBeenCalledTimes(1);

      silenceBullQueueConnectionErrors({ get: () => containerOf([queue]) } as never);

      queue.emit('error', new Error('connect ECONNREFUSED 127.0.0.1:1'));
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('resolves the container non-strictly — it is not a provider of the root module', () => {
    const get = vi.fn().mockReturnValue(containerOf([]));

    silenceBullQueueConnectionErrors({ get } as never);

    expect(get).toHaveBeenCalledWith(expect.anything(), { strict: false });
  });
});
