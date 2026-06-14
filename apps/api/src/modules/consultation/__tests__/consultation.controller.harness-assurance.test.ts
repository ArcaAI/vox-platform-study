/**
 * ConsultationController — harness-assurance SSE route (TASK-355 Phase D Slice 5d).
 *
 * Verifies the `GET :id/harness-assurance/stream` SSE relay delegates to
 * HarnessAssuranceService and carries the same auth metadata as the other live
 * streams (@TenantOwnedResource pre-stream guard + @StreamScope single-use ticket)
 * — its own scope namespace so a progress ticket can't read assurance verdicts.
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

describe('ConsultationController harness-assurance stream (TASK-355 Phase D Slice 5d)', () => {
  it('returns the observable produced by HarnessAssuranceService.subscribeToAssurance', () => {
    const stream = of({ data: '{"claims":[]}' });
    const harnessAssuranceService = { subscribeToAssurance: vi.fn().mockReturnValueOnce(stream) };

    // The route only touches harnessAssuranceService — bypass the constructor
    // instead of threading every unused mock.
    const controller: ConsultationController = Object.create(ConsultationController.prototype);
    (controller as unknown as { harnessAssuranceService: unknown }).harnessAssuranceService = harnessAssuranceService;

    const result = controller.streamHarnessAssurance('consult-1');

    expect(harnessAssuranceService.subscribeToAssurance).toHaveBeenCalledWith('consult-1');
    expect(result).toBe(stream);
  });

  it('handler is bound to HTTP GET on path ":id/harness-assurance/stream" and marked @Sse()', () => {
    const handler = ConsultationController.prototype.streamHarnessAssurance;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/harness-assurance/stream');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
  });

  it('carries @TenantOwnedResource(Consultation/id) so cross-tenant probes 404 pre-stream', () => {
    const meta = Reflect.getMetadata(
      TENANT_OWNED_RESOURCE_KEY,
      ConsultationController.prototype.streamHarnessAssurance as object,
    ) as TenantOwnedResourceOptions | undefined;
    expect(meta).toEqual({ modelName: 'Consultation', paramName: 'id' });
  });

  it('carries its OWN @StreamScope(consultation_harness_assurance/id) one-shot-ticket namespace', () => {
    const meta = Reflect.getMetadata(
      STREAM_SCOPE_METADATA,
      ConsultationController.prototype.streamHarnessAssurance as object,
    ) as StreamScopeConfig | undefined;
    expect(meta).toEqual({ namespace: 'consultation_harness_assurance', param: 'id' });
  });
});
