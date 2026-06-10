/**
 * ConsultationController — harness-progress SSE route (TASK-345).
 *
 * Verifies the `GET :id/harness-progress/stream` SSE relay delegates to
 * HarnessProgressService and carries the same auth metadata as the
 * live-summary stream (@TenantOwnedResource pre-stream guard + @StreamScope
 * single-use ticket).
 */
import { describe, it, expect, vi } from 'vitest';
import { PATH_METADATA, METHOD_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { of } from 'rxjs';
import { ConsultationController } from '../consultation.controller';
import {
  TENANT_OWNED_RESOURCE_KEY,
  type TenantOwnedResourceOptions,
} from '../../../common/tenant-owned-resource.decorator';
import { STREAM_SCOPE_METADATA, type StreamScopeConfig } from '../../auth/decorators/stream-scope.decorator';

describe('ConsultationController harness-progress stream (TASK-345)', () => {
  it('returns the observable produced by HarnessProgressService.subscribeToProgress', () => {
    const stream = of({ data: '{"stages":[]}' });
    const harnessProgressService = { subscribeToProgress: vi.fn().mockReturnValueOnce(stream) };

    // The route only touches harnessProgressService — bypass the 13-arg
    // constructor instead of threading 12 unused mocks.
    const controller: ConsultationController = Object.create(ConsultationController.prototype);
    (controller as unknown as { harnessProgressService: unknown }).harnessProgressService = harnessProgressService;

    const result = controller.streamHarnessProgress('consult-1');

    expect(harnessProgressService.subscribeToProgress).toHaveBeenCalledWith('consult-1');
    expect(result).toBe(stream);
  });

  it('handler is bound to HTTP GET on path ":id/harness-progress/stream" and marked @Sse()', () => {
    const handler = ConsultationController.prototype.streamHarnessProgress;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/harness-progress/stream');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
  });

  it('carries @TenantOwnedResource(Consultation/id) so cross-tenant probes 404 pre-stream', () => {
    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      ConsultationController.prototype.streamHarnessProgress as object,
    ) as TenantOwnedResourceOptions | undefined;
    expect(meta).toEqual({ modelName: 'Consultation', paramName: 'id' });
  });

  it('carries @StreamScope(consultation_harness_progress/id) so EventSource can connect with a one-shot ticket', () => {
    const meta = Reflect.getMetadata(
      STREAM_SCOPE_METADATA,
      ConsultationController.prototype.streamHarnessProgress as object,
    ) as StreamScopeConfig | undefined;
    expect(meta).toEqual({ namespace: 'consultation_harness_progress', param: 'id' });
  });
});
