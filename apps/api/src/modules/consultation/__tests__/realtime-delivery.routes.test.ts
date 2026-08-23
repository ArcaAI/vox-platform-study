/**
 * TASK-795 RC-1 / RC-2 — the gateway routes that let interpreter output reach a clinician.
 *
 * TASK-796 enumerated all 18 `/internal/harness/*` routes and found NONE accepting
 * clinical summary text; the only text-accepting write is `.../draft`, which creates
 * the FINAL `RAW_SUMMARY` ContextItem. These two routes are the missing plane, and
 * the harness client is already built against these exact paths
 * (`test_live_delivery_client.py` on `feat/task-796-realtime-summary-text`), so a
 * path or verb change here is a silent blank panel there.
 *
 * The SSE half is asserted the way its four siblings are: `@TenantOwnedResource`
 * (cross-tenant probes 404 BEFORE the stream opens) plus `@StreamScope` (EventSource
 * cannot send an Authorization header, so it connects with a one-shot ticket). Both
 * are load-bearing on a plane DECLARED PHI-carrying — a correction proposal quotes
 * the clinician's own text verbatim.
 */
import { describe, it, expect, vi } from 'vitest';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA, SSE_METADATA } from '@nestjs/common/constants';
import { ConsultationController } from '../consultation.controller';
import { HarnessInternalController } from '../harness-internal.controller';
import { TENANT_OWNED_RESOURCE_KEY, type TenantOwnedResourceOptions } from '../../../common/tenant-owned-resource.decorator';
import { STREAM_SCOPE_METADATA, type StreamScopeConfig } from '../../auth/decorators/stream-scope.decorator';

describe('RC-1 — POST /internal/harness/consultations/:id/live-summary', () => {
  const handler = HarnessInternalController.prototype.publishLiveSummary;

  it('is mounted at the exact path the harness client posts to', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('consultations/:id/live-summary');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('answers 200, not the default POST 201 — the ack is best-effort and can be { ok: false }', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('delegates to the live-documentation plane, so the existing SSE route and console panel light up unchanged', async () => {
    const publishInterpreterSummary = vi.fn().mockResolvedValue({ ok: true });
    const controller: HarnessInternalController = Object.create(HarnessInternalController.prototype);
    (controller as unknown as { liveDocumentationService: unknown }).liveDocumentationService = { publishInterpreterSummary };

    const body = { tenantId: 't', runningSummary: 'x', sections: [], source: 'interpreter' };
    await expect(controller.publishLiveSummary('c-1', body as never)).resolves.toEqual({ ok: true });
    expect(publishInterpreterSummary).toHaveBeenCalledWith('c-1', body);
  });
});

describe('RC-2 — POST /internal/harness/consultations/:id/live-assist', () => {
  const handler = HarnessInternalController.prototype.publishLiveAssist;

  it('is mounted at the exact path the harness client posts to', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('consultations/:id/live-assist');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
  });

  it('answers 200, not the default POST 201', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
  });

  it('delegates to the live-assist feed', async () => {
    const publishAssist = vi.fn().mockResolvedValue({ ok: true });
    const controller: HarnessInternalController = Object.create(HarnessInternalController.prototype);
    (controller as unknown as { harnessLiveAssistService: unknown }).harnessLiveAssistService = { publishAssist };

    const body = { tenantId: 't', kind: 'suggestions', suggestions: [] };
    await expect(controller.publishLiveAssist('c-1', body as never)).resolves.toEqual({ ok: true });
    expect(publishAssist).toHaveBeenCalledWith('c-1', body);
  });
});

describe('RC-2 — GET /consultations/:id/live-assist/stream', () => {
  const handler = ConsultationController.prototype.streamLiveAssist;

  it('is a GET SSE route on the sibling path of live-summary/stream', () => {
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(':id/live-assist/stream');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(SSE_METADATA, handler)).toBe(true);
  });

  it('carries @TenantOwnedResource(Consultation/id) so a cross-tenant probe 404s BEFORE any PHI streams', () => {
    const meta = Reflect.getMetadata(TENANT_OWNED_RESOURCE_KEY, handler as object) as TenantOwnedResourceOptions | undefined;
    expect(meta).toEqual({ modelName: 'Consultation', paramName: 'id' });
  });

  it('carries its OWN @StreamScope namespace — a live-summary ticket must not read correction proposals', () => {
    const meta = Reflect.getMetadata(STREAM_SCOPE_METADATA, handler as object) as StreamScopeConfig | undefined;
    expect(meta).toEqual({ namespace: 'consultation_live_assist', param: 'id' });
  });

  it('relays the live-assist feed, never the loop plane', () => {
    const subscribeToAssist = vi.fn().mockReturnValue('observable');
    const controller: ConsultationController = Object.create(ConsultationController.prototype);
    (controller as unknown as { harnessLiveAssistService: unknown }).harnessLiveAssistService = { subscribeToAssist };

    expect(controller.streamLiveAssist('c-1')).toBe('observable');
    expect(subscribeToAssist).toHaveBeenCalledWith('c-1');
  });
});
