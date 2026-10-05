/** A terminally failed batch transcription must not leave its attachment PROCESSING forever. */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { ConsultationAttachmentFactory } from '@arcaai/domains';
import { AttachmentTranscriptSink } from '../attachment-transcript.sink';
import { SttInternalService } from '../../../stt/internal/sttInternal.service';
import { CONSULTATION, DOCTOR, FakeAttachmentRepository, TENANT, makeCls, makeContext, makeContextItems, makeGate } from './attachment-fakes.task1045';

function sinkSetup(status = 'PROCESSING') {
  const repo = new FakeAttachmentRepository();
  const row = ConsultationAttachmentFactory.CreateConsultationAttachment({
    tenantId: TENANT,
    consultationId: CONSULTATION,
    kind: 'AUDIO' as never,
    status: status as never,
    declaredMime: 'audio/wav',
    declaredSizeBytes: 100,
    declaredSha256: 'a'.repeat(64),
    bucketName: 'b',
    objectKey: 'k',
    uploadExpiresAt: new Date(),
    intentExpiresAt: new Date(Date.now() + 1000),
    mediaId: 'media-9',
    transcriptionJobId: 'job-1',
    createdBy: DOCTOR,
  });
  repo.rows.set(row.id, row);
  const gate = makeGate();
  const emitter = { emit: vi.fn() };
  const sink = new AttachmentTranscriptSink(emitter as never, makeCls(null, null) as never, repo as never, makeContext() as never, gate as never, makeContextItems() as never);
  return { row, gate, emitter, sink };
}

describe('AttachmentTranscriptSink.onBatchFailure', () => {
  it('fails the PROCESSING attachment with a code and ends the consultation processing as failed', async () => {
    const s = sinkSetup();
    await expect(s.sink.onBatchFailure({ jobId: 'job-1', errorCode: 'ASR_ERROR' })).resolves.toBe(true);
    expect(s.row.status).toBe('FAILED');
    expect(s.row.failureCode).toBe('ASR_ERROR');
    expect(s.gate.endProcessing).toHaveBeenCalledWith(CONSULTATION, s.row.id, { failed: true, reason: 'ASR_ERROR' });
    expect(s.emitter.emit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceId: s.row.id }));
  });

  it('defaults the code and is a no-op claim for a row that already left PROCESSING', async () => {
    const s = sinkSetup('READY');
    await expect(s.sink.onBatchFailure({ jobId: 'job-1' })).resolves.toBe(true);
    expect(s.row.status).toBe('READY');
    expect(s.gate.endProcessing).not.toHaveBeenCalled();
  });

  it('does not claim a job no attachment owns', async () => {
    const s = sinkSetup();
    await expect(s.sink.onBatchFailure({ jobId: 'other' })).resolves.toBe(false);
  });
});

function sttSetup(job: Record<string, unknown>) {
  const jobRepository = { findById: vi.fn().mockResolvedValue(job), update: vi.fn(async (_i: string, e: unknown) => e) };
  const sink = { onBatchTranscript: vi.fn(), onBatchFailure: vi.fn(async () => true) };
  const service = new SttInternalService(
    jobRepository as never, {} as never, {} as never, {} as never, { emit: vi.fn() } as never, { get: vi.fn(() => null) } as never,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, sink as never,
  );
  return { service, sink };
}

describe('SttInternalService.failJob → attachment sink', () => {
  const job = (canRetry: boolean) => ({
    id: 'job-1', tenantId: TENANT, status: 'PROCESSING', createdBy: DOCTOR, canRetry,
    fail: vi.fn(function (this: { canRetry: boolean }) { /* status flip not needed */ }),
  });

  it('notifies the sink when retries are spent', async () => {
    const j = job(false);
    const { service, sink } = sttSetup(j);
    await service.failJob('job-1', { errorMessage: 'boom', errorCode: 'ASR_ERROR' } as never).catch(() => undefined);
    expect(sink.onBatchFailure).toHaveBeenCalledWith({ jobId: 'job-1', errorCode: 'ASR_ERROR' });
  });

  it('does not notify while a retry remains', async () => {
    const j = job(true);
    const { service, sink } = sttSetup(j);
    await service.failJob('job-1', { errorMessage: 'boom', errorCode: 'ASR_ERROR' } as never).catch(() => undefined);
    expect(sink.onBatchFailure).not.toHaveBeenCalled();
  });
});
