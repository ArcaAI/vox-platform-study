/**
 * TASK-1045 lane CG-API — attachment routes (`consultations/:id/attachments*`).
 * The controller is a thin shell: access check, then the service. 202 vs 200 follows the
 * service's `PROCESSING` answer; the Idempotency-Key goes straight through.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { SERVICE_ACCOUNT_REQUIRED_SCOPES } from '@arcaai/applications';
import { ConsultationAttachmentController } from '../consultation-attachment.controller';

function makeController() {
  const access = {
    assertRead: vi.fn().mockResolvedValue(undefined),
    assertWrite: vi.fn().mockResolvedValue(undefined),
  };
  const service = {
    createIntent: vi.fn().mockResolvedValue({ attachmentId: 'a-1', status: 'INTENT' }),
    complete: vi.fn().mockResolvedValue({ attachmentId: 'a-1', status: 'READY' }),
    uploadContent: vi.fn().mockResolvedValue({ attachmentId: 'a-1', status: 'READY' }),
    list: vi.fn().mockResolvedValue([{ attachmentId: 'a-1' }]),
    get: vi.fn().mockResolvedValue({ attachmentId: 'a-1' }),
  };
  const res = { status: vi.fn() };
  return { controller: new ConsultationAttachmentController(access as never, service as never), access, service, res };
}

const intent = { kind: 'document', mime: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) } as never;

describe('ConsultationAttachmentController', () => {
  it('maps the five routes under consultations/:id/attachments', () => {
    const proto = ConsultationAttachmentController.prototype;
    expect(Reflect.getMetadata(PATH_METADATA, ConsultationAttachmentController)).toBe('consultations');
    expect(Reflect.getMetadata(PATH_METADATA, proto.createIntent)).toBe(':id/attachments');
    expect(Reflect.getMetadata(PATH_METADATA, proto.complete)).toBe(':id/attachments/:attachmentId/complete');
    expect(Reflect.getMetadata(PATH_METADATA, proto.uploadContent)).toBe(':id/attachments/:attachmentId/content');
    expect(Reflect.getMetadata(PATH_METADATA, proto.list)).toBe(':id/attachments');
    expect(Reflect.getMetadata(PATH_METADATA, proto.get)).toBe(':id/attachments/:attachmentId');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.list)).toBe(0);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, proto.createIntent)).toBe(201);
  });

  it('createIntent checks write access, passes the Idempotency-Key through and returns the intent', async () => {
    const { controller, access, service } = makeController();
    const out = await controller.createIntent('c-1', intent, 'key-1');
    expect(access.assertWrite).toHaveBeenCalledWith('c-1');
    expect(service.createIntent).toHaveBeenCalledWith('c-1', intent, 'key-1');
    expect(out).toMatchObject({ attachmentId: 'a-1' });
  });

  it('a cross-tenant consultation is a 404 and the service is never reached', async () => {
    const { controller, access, service } = makeController();
    access.assertWrite.mockRejectedValue(new NotFoundException('Consultation c-x not found'));
    await expect(controller.createIntent('c-x', intent, undefined)).rejects.toBeInstanceOf(NotFoundException);
    expect(service.createIntent).not.toHaveBeenCalled();
  });

  it('complete answers 200 for READY and 202 for PROCESSING', async () => {
    const { controller, service, res } = makeController();
    await controller.complete('c-1', 'a-1', res as never);
    expect(res.status).toHaveBeenLastCalledWith(200);
    service.complete.mockResolvedValue({ attachmentId: 'a-1', status: 'PROCESSING', transcriptionJobId: 'j-1' });
    const out = await controller.complete('c-1', 'a-1', res as never);
    expect(res.status).toHaveBeenLastCalledWith(202);
    expect(out).toMatchObject({ status: 'PROCESSING' });
  });

  it('uploadContent hands the multipart buffer to the service and shares the 202 rule', async () => {
    const { controller, access, service, res } = makeController();
    service.uploadContent.mockResolvedValue({ attachmentId: 'a-1', status: 'PROCESSING' });
    const file = { buffer: Buffer.from('x'), mimetype: 'application/pdf' } as never;
    await controller.uploadContent('c-1', 'a-1', file, res as never);
    expect(access.assertWrite).toHaveBeenCalledWith('c-1');
    expect(service.uploadContent).toHaveBeenCalledWith('c-1', 'a-1', { buffer: file['buffer'], mimeType: 'application/pdf' });
    expect(res.status).toHaveBeenLastCalledWith(202);
  });

  it('uploadContent without a file is a 400', async () => {
    const { controller, res } = makeController();
    await expect(controller.uploadContent('c-1', 'a-1', undefined as never, res as never)).rejects.toMatchObject({ status: 400 });
  });

  it('reads check read access', async () => {
    const { controller, access, service } = makeController();
    await controller.list('c-1');
    await controller.get('c-1', 'a-1');
    expect(access.assertRead).toHaveBeenCalledTimes(2);
    expect(service.list).toHaveBeenCalledWith('c-1');
    expect(service.get).toHaveBeenCalledWith('c-1', 'a-1');
  });

  it('declares the session write/read scopes on the right routes', () => {
    const proto = ConsultationAttachmentController.prototype;
    const scope = (k: string, fn: unknown) => Reflect.getMetadata(k, fn as never) ?? Reflect.getMetadata(k, ConsultationAttachmentController);
    expect(scope(SERVICE_ACCOUNT_REQUIRED_SCOPES, proto.createIntent)).toEqual(['svc:consultation:session:write']);
    expect(scope(SERVICE_ACCOUNT_REQUIRED_SCOPES, proto.list)).toEqual(['svc:consultation:session:read']);
  });
});

describe('CreateAttachmentIntentRequest validation (reused DTO)', () => {
  it('rejects an unknown kind', async () => {
    const { CreateAttachmentIntentRequest } = await import('@arcaai/applications');
    const dto = plainToInstance(CreateAttachmentIntentRequest, { kind: 'video', mime: 'x', sizeBytes: 1, sha256: 'a'.repeat(64) });
    expect((await validate(dto)).length).toBeGreaterThan(0);
  });
});
