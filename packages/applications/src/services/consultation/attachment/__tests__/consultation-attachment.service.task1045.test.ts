/**
 * The consultation attachment state machine: intent → client PUT (or gateway `content`) → complete.
 *
 * Covers the frozen contract: idempotent intent replay (same attachmentId, re-presigned URL while
 * INTENT; 409 IDEMPOTENCY_KEY_REUSED on a different body), 422 kind at intent with the supported
 * list, quota at intent (declared size) and at complete (real size), size / sha256 (store checksum
 * or server re-hash) / magic-byte verification that deletes the object and FAILs the row, 410 on an
 * expired intent, dispatch by kind, purpose=feedback → Media only, async verify (202) above
 * `inlineVerifyMaxMb`, the gateway multipart path and its ceiling, the lifecycle gate, sys-events.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { QuotaExceededException } from '@arcaai/exceptions';
import { ConsultationAttachmentService } from '../consultation-attachment.service';
import { CaseNoteAttachmentProcessor } from '../processors/case-note.processor';
import { DocumentAttachmentProcessor } from '../processors/document.processor';
import { ImageAttachmentProcessor } from '../processors/image.processor';
import { CreateAttachmentIntentRequest } from '../dto';
import {
  CONSULTATION,
  DOCTOR,
  FakeAttachmentRepository,
  FakeBlobStorage,
  NOTE,
  OTHER_TENANT,
  PDF,
  WAV,
  makeBuckets,
  makeCls,
  makeConsultations,
  makeContext,
  makeContextItems,
  makeGate,
  makeMedia,
  makeSettings,
  sha256Hex,
} from './attachment-fakes.task1045';

type Deps = ReturnType<typeof makeDeps>;

function makeDeps(settingsOverrides: Record<string, unknown> = {}) {
  const context = makeContext();
  return {
    emitter: { emit: vi.fn() },
    cls: makeCls(),
    repo: new FakeAttachmentRepository(),
    consultations: makeConsultations([
      { id: CONSULTATION, tenantId: 'tenant-1', doctorId: DOCTOR },
      { id: 'foreign-consultation', tenantId: OTHER_TENANT },
    ]),
    blob: new FakeBlobStorage(),
    buckets: makeBuckets(),
    media: makeMedia(),
    settings: makeSettings(settingsOverrides),
    capability: { supportedKinds: vi.fn(async () => ['document', 'audio', 'case_note']) },
    gate: makeGate(),
    context,
    items: makeContextItems(),
    audio: {
      preflight: vi.fn(async () => undefined),
      process: vi.fn(async () => ({ pending: true, contextItemId: null, transcriptionJobId: 'job-1' })),
    },
    secrets: { encrypt: vi.fn() },
  };
}

function build(d: Deps) {
  return new ConsultationAttachmentService(
    d.emitter as never,
    d.cls as never,
    d.repo as never,
    d.consultations as never,
    d.blob as never,
    d.buckets as never,
    d.media as never,
    d.settings as never,
    d.capability as never,
    d.gate as never,
    new CaseNoteAttachmentProcessor(d.context as never, d.items as never),
    new DocumentAttachmentProcessor(d.context as never, d.items as never),
    new ImageAttachmentProcessor(d.context as never, d.items as never),
    d.audio as never,
    d.secrets as never,
  );
}

const intentFor = (bytes: Buffer, over: Partial<CreateAttachmentIntentRequest> = {}): CreateAttachmentIntentRequest =>
  Object.assign(new CreateAttachmentIntentRequest(), {
    kind: 'document',
    mime: 'application/pdf',
    sizeBytes: bytes.length,
    sha256: sha256Hex(bytes),
    fileName: 'lab-result-jane-doe.pdf',
    ...over,
  });

async function codeOf(promise: Promise<unknown>): Promise<{ status: number; code?: string; body: Record<string, unknown> }> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(HttpException);
  const http = error as HttpException;
  const body = http.getResponse() as Record<string, unknown>;
  return { status: http.getStatus(), code: body.code as string | undefined, body };
}

let d: Deps;
beforeEach(() => {
  d = makeDeps();
});

describe('intent', () => {
  it('creates an INTENT row with an ids-only key in the tenant bucket and a bound presigned PUT', async () => {
    const res = await build(d).createIntent(CONSULTATION, intentFor(PDF), 'key-1');

    expect(res.status).toBe('INTENT');
    expect(res.kind).toBe('document');
    expect(res.uploadMode).toBe('presigned');
    expect(res.uploadMethod).toBe('PUT');
    expect(res.uploadUrl).toMatch(/^https:\/\/store\.example\/tenant-1-attachments\//);
    expect(res.uploadHeaders['Content-Length']).toBe(String(PDF.length));
    const row = d.repo.rows.get(res.attachmentId)!;
    expect(row.objectKey).toMatch(
      new RegExp(`^consultations/\\d{4}/\\d{2}/${CONSULTATION}/attachments/${res.attachmentId}/${res.attachmentId}\\.pdf$`),
    );
    expect(row.objectKey).not.toContain('jane');
    expect(row.bucketName).toBe('tenant-1-attachments');
    expect(row.idempotencyKey).toBe('key-1');
    expect(row.encounterSeq).toBe(1);
    expect(d.repo.encryptFileNameIntoEntity).toHaveBeenCalled();
    // The checksum is bound into the signature (S3 enforces it on write).
    expect(d.blob.presignPutIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        contentType: 'application/pdf',
        contentLength: PDF.length,
        checksumSha256: Buffer.from(sha256Hex(PDF), 'hex').toString('base64'),
        expiresSeconds: 600,
      }),
    );
    expect(Date.parse(res.intentExpiresAt) - Date.parse(res.uploadExpiresAt)).toBeGreaterThan(23 * 3600 * 1000);
    expect(d.gate.assertContentWritable).toHaveBeenCalledWith(CONSULTATION);
    expect(d.gate.touchActivity).toHaveBeenCalledWith(CONSULTATION);
    expect(d.emitter.emit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceId: res.attachmentId }));
  });

  it('replays the same key + body as the same attachment with a re-presigned URL', async () => {
    const service = build(d);
    const first = await service.createIntent(CONSULTATION, intentFor(PDF), 'key-1');
    const second = await service.createIntent(CONSULTATION, intentFor(PDF), 'key-1');
    expect(second.attachmentId).toBe(first.attachmentId);
    expect(second.uploadUrl).not.toBe(first.uploadUrl);
    expect(d.repo.rows.size).toBe(1);
  });

  it('refuses the same key with a different body: 409 IDEMPOTENCY_KEY_REUSED', async () => {
    const service = build(d);
    await service.createIntent(CONSULTATION, intentFor(PDF), 'key-1');
    const err = await codeOf(service.createIntent(CONSULTATION, intentFor(NOTE, { kind: 'case_note', mime: 'text/plain' }), 'key-1'));
    expect(err).toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
  });

  it('refuses a kind the consultation cannot take: 422 with the supported kinds', async () => {
    const err = await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF, { kind: 'image', mime: 'image/png' })));
    expect(err).toMatchObject({ status: 422, code: 'ATTACHMENT_KIND_UNSUPPORTED' });
    expect(err.body.supportedKinds).toEqual(['document', 'audio', 'case_note']);
    expect(d.repo.rows.size).toBe(0);
  });

  it('refuses an oversized declaration (413) and a mismatched type (415)', async () => {
    expect(await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF, { sizeBytes: 26 * 1024 * 1024 })))).toMatchObject({
      status: 413,
      code: 'ATTACHMENT_TOO_LARGE',
    });
    expect(await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF, { mime: 'image/png' })))).toMatchObject({
      status: 415,
      code: 'ATTACHMENT_TYPE_UNSUPPORTED',
    });
  });

  it('checks the quota with the declared size: 409 QUOTA_EXCEEDED, nothing written', async () => {
    d.blob.assertCanStore.mockRejectedValueOnce(new QuotaExceededException('over'));
    const err = await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF)));
    expect(err).toMatchObject({ status: 409, code: 'QUOTA_EXCEEDED' });
    expect(d.blob.assertCanStore).toHaveBeenCalledWith('tenant-1-attachments', PDF.length);
    expect(d.repo.rows.size).toBe(0);
  });

  it('respects the lifecycle gate for purpose=attachment but not for feedback media', async () => {
    d.gate.assertContentWritable.mockRejectedValue(new HttpException({ code: 'CONSULTATION_APPROVED' }, 409));
    expect(await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF)))).toMatchObject({ status: 409, code: 'CONSULTATION_APPROVED' });

    const res = await build(d).createIntent(CONSULTATION, intentFor(PDF, { purpose: 'feedback' }));
    expect(d.repo.rows.get(res.attachmentId)!.objectKey).toContain('/feedback/');
  });

  it('is 404 for another tenant’s consultation and 503 when the tenant has no bucket', async () => {
    expect((await codeOf(build(d).createIntent('foreign-consultation', intentFor(PDF)))).status).toBe(404);
    d.buckets.getBucketByPurpose.mockResolvedValue(null as never);
    expect(await codeOf(build(d).createIntent(CONSULTATION, intentFor(PDF)))).toMatchObject({ status: 503, code: 'MEDIA_STORAGE_UNAVAILABLE' });
  });

  it('falls back to a gateway upload (uploadUrl null) when the store cannot presign', async () => {
    d.blob.presignPutIntent.mockRejectedValueOnce(Object.assign(new Error('no'), { name: 'StorageNotSupportedError' }));
    const res = await build(d).createIntent(CONSULTATION, intentFor(PDF));
    expect(res).toMatchObject({ uploadMode: 'gateway', uploadUrl: null });
    expect(d.repo.rows.get(res.attachmentId)!.uploadMode).toBe('GATEWAY');
  });
});

describe('complete', () => {
  async function uploaded(bytes: Buffer, over: Partial<CreateAttachmentIntentRequest> = {}, put?: Buffer, withChecksum = false) {
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(bytes, over));
    const row = d.repo.rows.get(intent.attachmentId)!;
    d.blob.clientPut(row.bucketName, row.objectKey, put ?? bytes, { withChecksum });
    return { service, intent, row };
  }

  it('document: verifies by server re-hash, writes Media + ATTACHMENT item, READY, usage recorded', async () => {
    const { service, intent, row } = await uploaded(PDF);
    const res = await service.complete(CONSULTATION, intent.attachmentId);

    expect(res).toMatchObject({ attachmentId: intent.attachmentId, status: 'READY', kind: 'document', mediaId: 'media-1', contextItemId: 'item-1' });
    expect(d.blob.getObjectStream).toHaveBeenCalled();
    expect(d.media.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: `${intent.attachmentId}.pdf`,
        uri: `s3://${row.bucketName}/${row.objectKey}`,
        size: PDF.length,
        hash: sha256Hex(PDF),
      }),
    );
    expect(d.context.addContext).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({ type: 'ATTACHMENT', mediaId: 'media-1', metadata: expect.objectContaining({ attachmentId: intent.attachmentId }) }),
    );
    expect(d.blob.recordExternalWrite).toHaveBeenCalledWith(row.bucketName, PDF.length);
    // The item sits on the attachment's encounter (the fact ledger selects inputs by it).
    expect(d.items.rows.get('item-1')!.encounterSeq).toBe(1);
    expect(d.blob.assertCanStore).toHaveBeenLastCalledWith(row.bucketName, PDF.length);
    expect(d.gate.touchActivity).toHaveBeenCalledTimes(2);
    expect(d.emitter.emit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resourceId: intent.attachmentId, data: expect.objectContaining({ status: 'READY' }) }),
    );
  });

  it('trusts the store checksum when it recorded one (no re-hash)', async () => {
    const { service, intent } = await uploaded(PDF, {}, undefined, true);
    await expect(service.complete(CONSULTATION, intent.attachmentId)).resolves.toMatchObject({ status: 'READY' });
    expect(d.blob.getObjectStream).not.toHaveBeenCalled();
  });

  it('case note: strict UTF-8 text becomes a CASE_NOTE item', async () => {
    const { service, intent } = await uploaded(NOTE, { kind: 'case_note', mime: 'text/plain', fileName: undefined });
    const res = await service.complete(CONSULTATION, intent.attachmentId);
    expect(res).toMatchObject({ status: 'READY', kind: 'case_note', contextItemId: 'item-1' });
    expect(d.context.addContext).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({
        type: 'CASE_NOTE',
        content: NOTE.toString('utf8'),
        metadata: expect.objectContaining({ attachmentId: intent.attachmentId }),
      }),
    );
    expect(d.items.rows.get('item-1')!.encounterSeq).toBe(1);
  });

  it('case note that is not valid UTF-8: 415 ATTACHMENT_CONTENT_MISMATCH, object deleted, row FAILED', async () => {
    const bad = Buffer.from([0x48, 0x69, 0xc3, 0x28, 0x21]);
    const { service, intent, row } = await uploaded(bad, { kind: 'case_note', mime: 'text/plain' });
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 415, code: 'ATTACHMENT_CONTENT_MISMATCH' });
    expect(d.blob.objects.has(`${row.bucketName}/${row.objectKey}`)).toBe(false);
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED');
    expect(d.repo.rows.get(intent.attachmentId)!.failureCode).toBe('ATTACHMENT_CONTENT_MISMATCH');
  });

  it('bytes that are not the declared container: 415, object deleted, FAILED', async () => {
    const html = Buffer.concat([Buffer.from('<!doctype html>'), Buffer.alloc(PDF.length - 15, 0x20)]);
    const { service, intent, row } = await uploaded(html, { sha256: sha256Hex(html) });
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 415, code: 'ATTACHMENT_CONTENT_MISMATCH' });
    expect(d.blob.deleteObject).toHaveBeenCalledWith({ bucket: row.bucketName, key: row.objectKey });
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED');
    expect(d.media.create).not.toHaveBeenCalled();
  });

  it('a body whose hash differs from the declaration: 422 ATTACHMENT_CHECKSUM_MISMATCH, object deleted', async () => {
    const tampered = Buffer.from(PDF);
    tampered[PDF.length - 1] = 0x21;
    const { service, intent, row } = await uploaded(PDF, {}, tampered);
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 422, code: 'ATTACHMENT_CHECKSUM_MISMATCH' });
    expect(d.blob.objects.has(`${row.bucketName}/${row.objectKey}`)).toBe(false);
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED');
  });

  it('a body of a different size than declared: 422, FAILED', async () => {
    const { service, intent } = await uploaded(PDF, {}, Buffer.concat([PDF, Buffer.from(' ')]));
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 422, code: 'ATTACHMENT_CHECKSUM_MISMATCH' });
  });

  it('nothing uploaded yet: 409 ATTACHMENT_NOT_UPLOADED and the intent stays open (retryable)', async () => {
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(PDF));
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 409, code: 'ATTACHMENT_NOT_UPLOADED' });
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('INTENT');
  });

  it('re-checks the quota with the real size: 409 QUOTA_EXCEEDED, object deleted, FAILED', async () => {
    const { service, intent, row } = await uploaded(PDF);
    d.blob.assertCanStore.mockRejectedValueOnce(new QuotaExceededException('over'));
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 409, code: 'QUOTA_EXCEEDED' });
    expect(d.blob.objects.has(`${row.bucketName}/${row.objectKey}`)).toBe(false);
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED');
    expect(d.blob.recordExternalWrite).not.toHaveBeenCalled();
  });

  it('an intent past its window: 410 ATTACHMENT_INTENT_EXPIRED', async () => {
    const { service, intent } = await uploaded(PDF);
    d.repo.rows.get(intent.attachmentId)!.intentExpiresAt = new Date(Date.now() - 1000);
    expect(await codeOf(service.complete(CONSULTATION, intent.attachmentId))).toMatchObject({ status: 410, code: 'ATTACHMENT_INTENT_EXPIRED' });

    const other = await uploaded(PDF);
    d.repo.rows.get(other.intent.attachmentId)!.status = 'EXPIRED' as never;
    expect(await codeOf(other.service.complete(CONSULTATION, other.intent.attachmentId))).toMatchObject({ status: 410 });
  });

  it('a repeated complete answers the current state without re-processing', async () => {
    const { service, intent } = await uploaded(PDF);
    await service.complete(CONSULTATION, intent.attachmentId);
    const again = await service.complete(CONSULTATION, intent.attachmentId);
    expect(again).toMatchObject({ status: 'READY', mediaId: 'media-1' });
    expect(d.media.create).toHaveBeenCalledTimes(1);
  });

  it('is 404 for an attachment of another consultation', async () => {
    const { service, intent } = await uploaded(PDF);
    d.repo.rows.get(intent.attachmentId)!.consultationId = 'another';
    expect((await codeOf(service.complete(CONSULTATION, intent.attachmentId))).status).toBe(404);
  });

  it('purpose=feedback: Media row only, no context item', async () => {
    const { service, intent } = await uploaded(PDF, { purpose: 'feedback' });
    const res = await service.complete(CONSULTATION, intent.attachmentId);
    expect(res).toMatchObject({ status: 'READY', mediaId: 'media-1', contextItemId: null });
    expect(d.context.addContext).not.toHaveBeenCalled();
  });

  it('audio: the batch job is started, the row is PROCESSING (202) and the consultation is marked processing', async () => {
    const { service, intent, row } = await uploaded(WAV, { kind: 'audio', mime: 'audio/wav', fileName: undefined });
    const res = await service.complete(CONSULTATION, intent.attachmentId);
    expect(res).toMatchObject({ status: 'PROCESSING', kind: 'audio', transcriptionJobId: 'job-1', mediaId: 'media-1' });
    expect(row.bucketName).toBe('tenant-1-recordings');
    expect(d.audio.preflight).toHaveBeenCalled();
    expect(d.audio.process).toHaveBeenCalledWith(
      expect.objectContaining({
        consultationId: CONSULTATION,
        attachmentId: intent.attachmentId,
        mediaId: 'media-1',
        bucket: row.bucketName,
        key: row.objectKey,
        doctorId: DOCTOR,
        encounterSeq: 1,
      }),
    );
    expect(d.gate.beginProcessing).toHaveBeenCalledWith(CONSULTATION, 'PROCESSING_ATTACHMENT', intent.attachmentId);
    expect(d.repo.rows.get(intent.attachmentId)!.transcriptionJobId).toBe('job-1');
  });

  it('audio refused by the spend limit leaves the intent open and writes nothing', async () => {
    const { service, intent } = await uploaded(WAV, { kind: 'audio', mime: 'audio/wav' });
    d.audio.preflight.mockRejectedValueOnce(new HttpException({ code: 'SPEND_LIMIT_REACHED' }, 402));
    expect((await codeOf(service.complete(CONSULTATION, intent.attachmentId))).status).toBe(402);
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('INTENT');
    expect(d.media.create).not.toHaveBeenCalled();
  });

  it('above inlineVerifyMaxMb with no store checksum: 202 PROCESSING, verified and dispatched in the background', async () => {
    d = makeDeps({ 'consultation.attachments.inlineVerifyMaxMb': 0 });
    const { service, intent } = await uploaded(PDF);
    const res = await service.complete(CONSULTATION, intent.attachmentId);
    expect(res.status).toBe('PROCESSING');
    expect(d.gate.beginProcessing).toHaveBeenCalledWith(CONSULTATION, 'PROCESSING_ATTACHMENT', intent.attachmentId);
    await vi.waitFor(() => expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('READY'));
    expect(d.gate.endProcessing).toHaveBeenCalledWith(CONSULTATION, intent.attachmentId, undefined);
  });

  it('a background verify failure FAILs the row, deletes the object and ends processing as failed', async () => {
    d = makeDeps({ 'consultation.attachments.inlineVerifyMaxMb': 0 });
    const tampered = Buffer.from(PDF);
    tampered[PDF.length - 1] = 0x21;
    const { service, intent, row } = await uploaded(PDF, {}, tampered);
    expect((await service.complete(CONSULTATION, intent.attachmentId)).status).toBe('PROCESSING');
    await vi.waitFor(() => expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED'));
    expect(d.repo.rows.get(intent.attachmentId)!.failureCode).toBe('ATTACHMENT_CHECKSUM_MISMATCH');
    expect(d.blob.objects.has(`${row.bucketName}/${row.objectKey}`)).toBe(false);
    expect(d.gate.endProcessing).toHaveBeenCalledWith(CONSULTATION, intent.attachmentId, expect.objectContaining({ failed: true }));
  });
});

describe('gateway content upload', () => {
  it('stores the bytes through the gateway and completes in one call', async () => {
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(PDF));
    const res = await service.uploadContent(CONSULTATION, intent.attachmentId, { buffer: PDF, mimeType: 'application/pdf' });
    expect(res).toMatchObject({ status: 'READY', mediaId: 'media-1', contextItemId: 'item-1' });
    const row = d.repo.rows.get(intent.attachmentId)!;
    expect(d.blob.putObject).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: row.bucketName, key: row.objectKey, contentType: 'application/pdf' }),
    );
    // `putObject` records usage itself; the presigned-only bookkeeping is not repeated.
    expect(d.blob.recordExternalWrite).not.toHaveBeenCalled();
  });

  it('refuses a body above the multipart ceiling: 413, nothing stored', async () => {
    d = makeDeps({ 'consultation.attachments.multipartMaxMb': 0.0001 });
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(PDF));
    expect(await codeOf(service.uploadContent(CONSULTATION, intent.attachmentId, { buffer: PDF }))).toMatchObject({
      status: 413,
      code: 'ATTACHMENT_TOO_LARGE',
    });
    expect(d.blob.putObject).not.toHaveBeenCalled();
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('INTENT');
  });

  it('refuses a body that is not the declared one: 422, row FAILED, nothing stored', async () => {
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(PDF));
    const other = Buffer.from(PDF);
    other[20] = 0x41;
    expect(await codeOf(service.uploadContent(CONSULTATION, intent.attachmentId, { buffer: other }))).toMatchObject({
      status: 422,
      code: 'ATTACHMENT_CHECKSUM_MISMATCH',
    });
    expect(d.blob.putObject).not.toHaveBeenCalled();
    expect(d.repo.rows.get(intent.attachmentId)!.status).toBe('FAILED');
  });
});

describe('reads', () => {
  it('lists and gets the consultation’s attachments; another consultation’s id is 404', async () => {
    const service = build(d);
    const intent = await service.createIntent(CONSULTATION, intentFor(PDF));
    expect(await service.list(CONSULTATION)).toEqual([expect.objectContaining({ attachmentId: intent.attachmentId, status: 'INTENT' })]);
    expect(await service.get(CONSULTATION, intent.attachmentId)).toMatchObject({ attachmentId: intent.attachmentId, sha256: sha256Hex(PDF) });
    expect((await codeOf(service.get(CONSULTATION, 'nope'))).status).toBe(404);
  });
});
