/**
 * ConsultationController — loop-event SSE route (TASK-660).
 *
 * Verifies the `GET :id/loop/stream` SSE relay subscribes to the Redis
 * channel `consultation:loop:{id}` and carries the same auth metadata as the
 * live-summary / harness-progress / trajectory streams (@TenantOwnedResource
 * pre-stream guard + @StreamScope single-use ticket) so cross-tenant probes
 * 404 pre-stream. Mirrors `consultation.controller.trajectory.test.ts`
 * precisely — same append-only, no-snapshot, merged-heartbeat shape.
 */
import { describe, it, expect, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { Subject, firstValueFrom } from 'rxjs';
import { ConsultationController } from '../consultation.controller';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from '../../../common/tenant-owned-resource.decorator';
import { STREAM_SCOPE_METADATA, type StreamScopeConfig } from '../../auth/decorators/stream-scope.decorator';

function buildController(redisSubscriber: unknown): ConsultationController {
  // The route only touches redisSubscriber — bypass the wide constructor
  // instead of threading the unused mocks.
  const controller: ConsultationController = Object.create(ConsultationController.prototype);
  (controller as unknown as { redisSubscriber: unknown }).redisSubscriber = redisSubscriber;
  return controller;
}

describe('ConsultationController loop stream', () => {
  it('subscribes to consultation:loop:{id} and relays each published event as an SSE event', async () => {
    const channel$ = new Subject<string>();
    const redisSubscriber = { subscribeToChannel: vi.fn().mockResolvedValue(channel$.asObservable()) };
    const controller = buildController(redisSubscriber);

    const observable = controller.streamLoop('consult-1');
    const firstEvent = firstValueFrom(observable);

    // Let the async subscribe-to-channel settle before publishing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redisSubscriber.subscribeToChannel).toHaveBeenCalledWith('consultation:loop:consult-1');

    channel$.next('{"kind":"action.started","consultationId":"consult-1"}');
    await expect(firstEvent).resolves.toEqual({ data: '{"kind":"action.started","consultationId":"consult-1"}' });
  });

  it('emits a heartbeat event on the shared 15s cadence when no loop event has published yet', async () => {
    vi.useFakeTimers();
    try {
      const channel$ = new Subject<string>();
      const redisSubscriber = { subscribeToChannel: vi.fn().mockResolvedValue(channel$.asObservable()) };
      const controller = buildController(redisSubscriber);

      const events: unknown[] = [];
      const sub = controller.streamLoop('consult-1').subscribe((event) => events.push(event));

      // Let the async subscribe-to-channel microtask settle before advancing timers.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(15000);

      expect(events).toHaveLength(1);
      expect(JSON.parse((events[0] as { data: string }).data)).toMatchObject({ type: 'heartbeat' });

      sub.unsubscribe();
    } finally {
      vi.useRealTimers();
    }
  });

  it('handler is bound to HTTP GET on path ":id/loop/stream" and marked @Sse()', () => {
    const handler = ConsultationController.prototype.streamLoop;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/loop/stream');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
  });

  it('carries @TenantOwnedResource(Consultation/id) so cross-tenant probes 404 pre-stream', () => {
    const meta = Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, ConsultationController.prototype.streamLoop as object) as
      TenantOwnedResourceOptions | undefined;
    expect(meta).toEqual({ modelName: 'Consultation', paramName: 'id' });
  });

  it('carries @StreamScope(consultation_loop/id) so EventSource can connect with a one-shot ticket', () => {
    const meta = Reflect.getMetadata(STREAM_SCOPE_METADATA, ConsultationController.prototype.streamLoop as object) as
      StreamScopeConfig | undefined;
    expect(meta).toEqual({ namespace: 'consultation_loop', param: 'id' });
  });
});
