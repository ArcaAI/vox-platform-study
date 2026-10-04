/**
 * TASK-1038 (F1) — `POST /media` and `GET /media/:mediaId`, the tenant media upload plane.
 *
 *  - JWT ability `create:Media` (read for the GET), API key `media:write`, service account
 *    `svc:media:write` — both machine classes, no `@ForbidApiKey()`;
 *  - the MIME type picks the allow-list: an attachment (`CONTEXT_ATTACHMENT_MIME_TYPES`) or audio
 *    (the batch-transcription upload's `ALLOWED_AUDIO_MIMES`); anything else is a 400 before the
 *    service is called;
 *  - the multipart interceptor's static ceiling is the descriptor's hard ceiling (a decorator cannot
 *    read a setting; the configured ceiling is enforced in the service);
 *  - `svc:media:write` is a registered service-account scope deriving `create:Media` from `media:write`.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  API_KEY_REQUIRED_SCOPES,
  API_KEY_SCOPE_REGISTRY,
  CONTEXT_ATTACHMENT_MIME_TYPES,
  MEDIA_AUDIO_MIME_TYPES,
  MEDIA_UPLOAD_HARD_CEILING_MB,
  REQUIRED_PERMISSIONS_KEY,
  SERVICE_ACCOUNT_REQUIRED_SCOPES,
  STANDALONE_FEATURE_SVC_SCOPES,
  resolveServiceAccountImpliedPermissions,
} from '@arcaai/applications';
import { ALLOWED_AUDIO_MIMES } from '../../streaming/dto/transcription-job.dto';
import { MEDIA_UPLOAD_MULTIPART_LIMITS, MediaController } from '../media.controller';

const reflector = new Reflector();
const uploads = { upload: vi.fn(), getOwnedReference: vi.fn() };
const controller = () => new MediaController(uploads as never);
const file = (mimetype: string, originalname = 'f.bin') => ({ buffer: Buffer.from('%PDF-1'), mimetype, originalname, size: 6 }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  uploads.upload.mockResolvedValue({ mediaId: 'm-1', mime: 'application/pdf', sizeBytes: 6, sha256: 'x' });
});

describe('route metadata', () => {
  it('POST /media: create:Media, media:write, svc:media:write', () => {
    const handler = MediaController.prototype.upload;
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, MediaController])).toEqual([{ action: 'create', subject: 'Media' }]);
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, handler)).toEqual(['media:write']);
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:media:write']);
  });

  it('GET /media/:mediaId: read:Media under the same scope pair', () => {
    const handler = MediaController.prototype.getReference;
    expect(reflector.getAllAndOverride(REQUIRED_PERMISSIONS_KEY, [handler, MediaController])).toEqual([{ action: 'read', subject: 'Media' }]);
    expect(reflector.get(API_KEY_REQUIRED_SCOPES, handler)).toEqual(['media:write']);
    expect(reflector.get(SERVICE_ACCOUNT_REQUIRED_SCOPES, handler)).toEqual(['svc:media:write']);
  });

  it('the scope pair is registered: media:write implies create+read:Media, and svc:media:write derives both (a service account can read back)', () => {
    const both = [
      { action: 'create', subject: 'Media' },
      { action: 'read', subject: 'Media' },
    ];
    expect(API_KEY_SCOPE_REGISTRY['media:write']?.implies).toEqual(both);
    expect(STANDALONE_FEATURE_SVC_SCOPES).toContain('svc:media:write');
    expect(resolveServiceAccountImpliedPermissions('svc:media:write')).toEqual(both);
  });

  it('the multipart interceptor is bounded by the descriptor hard ceiling, one file per request', () => {
    expect(MEDIA_UPLOAD_MULTIPART_LIMITS).toEqual({ fileSize: MEDIA_UPLOAD_HARD_CEILING_MB * 1024 * 1024, files: 1 });
    expect(Reflect.getMetadata('__interceptors__', MediaController.prototype.upload)).toHaveLength(1);
  });
});

describe('POST /media', () => {
  it('classifies an attachment type and hands the file to the service', async () => {
    const answer = await controller().upload(file('application/pdf', 'labs.pdf'));
    expect(answer).toEqual({ mediaId: 'm-1', mime: 'application/pdf', sizeBytes: 6, sha256: 'x' });
    expect(uploads.upload).toHaveBeenCalledWith({ category: 'attachment', buffer: expect.any(Buffer), mimeType: 'application/pdf', originalName: 'labs.pdf' });
  });

  it('every attachment type is an attachment (image/jpg included), every batch audio type is audio', async () => {
    for (const mime of [...CONTEXT_ATTACHMENT_MIME_TYPES, 'image/jpg', 'IMAGE/PNG']) {
      await controller().upload(file(mime));
      expect(uploads.upload.mock.calls.at(-1)![0].category, mime).toBe('attachment');
    }
    for (const mime of ALLOWED_AUDIO_MIMES) {
      await controller().upload(file(mime));
      expect(uploads.upload.mock.calls.at(-1)![0].category, mime).toBe('audio');
    }
  });

  it('the controller and the service share ONE audio allow-list (TASK-1038 E2 fix 15)', () => {
    expect([...MEDIA_AUDIO_MIME_TYPES].sort()).toEqual([...ALLOWED_AUDIO_MIMES].sort());
  });

  it('400 for a type on neither list, and for no file — before the service is called', async () => {
    // `audio/x-ms-wma` starts with `audio/` but is on no list (TASK-1038 E2 fix 15).
    for (const mime of ['application/zip', 'video/mp4', 'text/html', 'audio/x-ms-wma', '']) {
      const error = await controller()
        .upload(file(mime))
        .catch((e: unknown) => e);
      expect(error, mime).toBeInstanceOf(BadRequestException);
      expect(((error as BadRequestException).getResponse() as { code: string }).code).toBe('MEDIA_TYPE_UNSUPPORTED');
    }
    await expect(controller().upload(undefined as never)).rejects.toBeInstanceOf(BadRequestException);
    expect(uploads.upload).not.toHaveBeenCalled();
  });
});

describe('GET /media/:mediaId', () => {
  it('answers the reference, and passes the service’s 404 through', async () => {
    uploads.getOwnedReference.mockResolvedValueOnce({ mediaId: 'm-1', mime: 'image/png', sizeBytes: 1, sha256: 'y' });
    expect(await controller().getReference('m-1')).toEqual({ mediaId: 'm-1', mime: 'image/png', sizeBytes: 1, sha256: 'y' });
    uploads.getOwnedReference.mockRejectedValueOnce(new NotFoundException());
    await expect(controller().getReference('foreign')).rejects.toBeInstanceOf(NotFoundException);
  });
});
