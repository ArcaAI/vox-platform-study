/**
 * ConsultationController — trajectory SSE route.
 *
 * Verifies the `GET :id/trajectory/stream` SSE relay subscribes to the Redis
 * channel `consultation:trajectory:{id}` and carries the same auth metadata as
 * the live-summary / harness-progress streams (@TenantOwnedResource pre-stream
 * guard + @StreamScope single-use ticket) so cross-tenant probes 404 pre-stream.
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

describe('ConsultationController trajectory stream', () => {
  it('subscribes to consultation:trajectory:{id} and relays each published step as an SSE event', async () => {
    const channel$ = new Subject<string>();
    const redisSubscriber = { subscribeToChannel: vi.fn().mockResolvedValue(channel$.asObservable()) };
    const controller = buildController(redisSubscriber);

    const observable = controller.streamTrajectory('consult-1');
    const firstEvent = firstValueFrom(observable);

    // Let the async subscribe-to-channel settle before publishing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(redisSubscriber.subscribeToChannel).toHaveBeenCalledWith('consultation:trajectory:consult-1');

    channel$.next('{"seq":0,"stepType":"LLM_CALL"}');
    await expect(firstEvent).resolves.toEqual({ data: '{"seq":0,"stepType":"LLM_CALL"}' });
  });

  it('handler is bound to HTTP GET on path ":id/trajectory/stream" and marked @Sse()', () => {
    const handler = ConsultationController.prototype.streamTrajectory;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/trajectory/stream');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
  });

  it('carries @TenantOwnedResource(Consultation/id) so cross-tenant probes 404 pre-stream', () => {
    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      ConsultationController.prototype.streamTrajectory as object,
    ) as TenantOwnedResourceOptions | undefined;
    expect(meta).toEqual({ modelName: 'Consultation', paramName: 'id' });
  });

  it('carries @StreamScope(consultation_trajectory/id) so EventSource can connect with a one-shot ticket', () => {
    const meta = Reflect.getMetadata(
      STREAM_SCOPE_METADATA,
      ConsultationController.prototype.streamTrajectory as object,
    ) as StreamScopeConfig | undefined;
    expect(meta).toEqual({ namespace: 'consultation_trajectory', param: 'id' });
  });
});
