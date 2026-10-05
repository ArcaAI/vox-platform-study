/**
 * TASK-1042 (C5) — `GET internal/stt/sessions/:sessionId/transcript?runId=`, the harness's read of
 * its run's bound live STT session.
 *
 * Service-to-service only: `@Public()` + `HarnessServiceTokenGuard` (`X-Service-Token`, NO
 * `?service=` selector — the harness sends none) and `X-Tenant-Id` MANDATORY. CLS is bound to the
 * header tenant before the service runs. No strict query DTO: an unknown query param is ignored.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { SttSessionTranscriptInternalController } from '../stt-session-transcript-internal.controller';
import { HarnessServiceTokenGuard } from '../../consultation/harness-service-token.guard';
import { InternalServiceTokenGuard } from '../internal-service-token.guard';

const TRANSCRIPT = {
  state: 'ended',
  language: 'en',
  transcript: 'hello there',
  finals: [{ text: 'hello there', utteranceIndex: 0, start: 0, end: 1.2, speaker: null, language: 'en' }],
};

function makeController() {
  const service = { read: vi.fn().mockResolvedValue(TRANSCRIPT) };
  const store = new Map<string, unknown>();
  const cls = {
    run: vi.fn((fn: () => unknown) => fn()),
    set: vi.fn((k: string, v: unknown) => store.set(k, v)),
    get: vi.fn((k: string) => store.get(k)),
  };
  return { controller: new SttSessionTranscriptInternalController(service as never, cls as never), service, cls };
}

describe('SttSessionTranscriptInternalController (C5)', () => {
  it('is GET internal/stt/sessions/:sessionId/transcript behind the harness token guard (not the ?service= guard)', () => {
    expect(Reflect.getMetadata(PATH_METADATA, SttSessionTranscriptInternalController)).toBe('internal/stt/sessions');
    expect(Reflect.getMetadata(PATH_METADATA, SttSessionTranscriptInternalController.prototype.transcript)).toBe(':sessionId/transcript');
    expect(Reflect.getMetadata(METHOD_METADATA, SttSessionTranscriptInternalController.prototype.transcript)).toBe(RequestMethod.GET);
    const guards = Reflect.getMetadata(GUARDS_METADATA, SttSessionTranscriptInternalController) as unknown[];
    expect(guards).toContain(HarnessServiceTokenGuard);
    expect(guards).not.toContain(InternalServiceTokenGuard);
  });

  it('reads under the X-Tenant-Id tenant and returns the C5 body verbatim', async () => {
    const { controller, service, cls } = makeController();
    const result = await controller.transcript('stt-1', 'run-1', 't-1');
    expect(cls.set).toHaveBeenCalledWith('tenantId', 't-1');
    expect(service.read).toHaveBeenCalledWith({ tenantId: 't-1', sttSessionId: 'stt-1', runId: 'run-1' });
    expect(result).toEqual(TRANSCRIPT);
  });

  it('400 without X-Tenant-Id or without runId; the service is never asked', async () => {
    const { controller, service } = makeController();
    await expect(controller.transcript('stt-1', 'run-1', undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.transcript('stt-1', undefined, 't-1')).rejects.toBeInstanceOf(BadRequestException);
    expect(service.read).not.toHaveBeenCalled();
  });

  it('a runId / tenant mismatch is the service`s 404, propagated unchanged', async () => {
    const { controller, service } = makeController();
    service.read.mockRejectedValue(new NotFoundException('not bound'));
    await expect(controller.transcript('stt-1', 'run-other', 't-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
