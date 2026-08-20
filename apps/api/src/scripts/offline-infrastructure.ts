/**
 * Quiescing the infrastructure clients that an OFFLINE artifact emit brings up
 * but can never use.
 *
 * `emit-openapi.ts` and `emit-route-manifest.ts` build the whole gateway DI
 * graph with `NestFactory.create()` purely to read route metadata. That
 * instantiates every provider, including ~40 BullMQ `Queue`s, and a BullMQ
 * queue dials Redis EAGERLY from its constructor — against the deliberately
 * unreachable `REDIS_HOST=127.0.0.1 REDIS_PORT=1` those scripts pass in
 * (`BullModule.forRootAsync`'s factory throws synchronously if the pair is
 * absent, so "no Redis at all" is not an option).
 *
 * ## Why that prints, and why a listener is the fix rather than a mute
 *
 * BullMQ's `QueueBase#emit` re-throws whatever `EventEmitter#emit` throws, and
 * Node throws on an `'error'` event with NO listener. BullMQ catches that and
 * falls back to `console.error(err)` (`classes/queue-base.js`), which is how a
 * clean, exit-0 emit ended up printing ~200 raw `ECONNREFUSED` stack dumps —
 * on a code path that also bypasses `@arcaai/logger` entirely.
 *
 * Attaching a listener addresses the actual cause: the connection error IS
 * expected here (the script's whole premise is "no infrastructure"), so this
 * process is the one that should own it. Nothing is hidden that could matter —
 * the emit reads compiled metadata only and never touches a queue.
 *
 * Timing is load-bearing: every one of those errors arrives AFTER
 * `NestFactory.create()` resolves (measured: create resolves at ~1.2s, the
 * first `ECONNREFUSED` lands at ~1.34s), so a call site immediately after
 * `create()` catches all of them. Call it there, not later.
 *
 * `ModulesContainer` (not `DiscoveryService`) is the walk root deliberately:
 * it is an internal-core, always-global provider, whereas `DiscoveryService`
 * only exists because some imported module happens to pull in
 * `DiscoveryModule`. `emit-route-manifest.ts` already walks the same container.
 */
import type { INestApplicationContext } from '@nestjs/common';
import { ModulesContainer } from '@nestjs/core/injector/modules-container';
import { Queue } from 'bullmq';

/**
 * Every distinct BullMQ `Queue` instance in the container.
 *
 * De-duplicated: one queue provider is reached through every module that
 * imports its registering module, so the same instance appears many times.
 */
export function collectBullQueues(container: ModulesContainer): Queue[] {
  const queues = new Set<Queue>();

  for (const module of container.values()) {
    for (const wrapper of module.providers.values()) {
      const instance: unknown = wrapper.instance;
      if (instance instanceof Queue) {
        queues.add(instance);
      }
    }
  }

  return Array.from(queues);
}

/**
 * Attach a no-op `'error'` listener to every BullMQ queue in `app`.
 *
 * @returns how many queues were handled — logged by the callers so a future
 *   boot that registers queues some other way shows up as a count change
 *   rather than as silently-returning noise.
 */
export function silenceBullQueueConnectionErrors(app: INestApplicationContext): number {
  const queues = collectBullQueues(app.get(ModulesContainer, { strict: false }));

  for (const queue of queues) {
    // Intentionally empty: see the module header. The alternative is not
    // "no error" — it is BullMQ printing a raw stack to stderr.
    queue.on('error', () => {});
  }

  return queues.length;
}
