/**
 * An uploaded audio attachment is transcribed by the batch path and lands as ONE transcript item.
 *
 * The processor replicates the batch route's money gate and dispatch in the service layer (spend
 * limit before a job exists; `createBatchJob` + `dispatchDramatiqJob`; `failJob` when the dispatch
 * fails), resolving the ASR agent from the consultation and the job owner from the consultation's
 * doctor — never the caller. The transcript sink claims the job's callback: one TRANSCRIPT item
 * (`metaData.origin = 'attachment_audio'`, the audio `mediaId`), the row READY, processing ended,
 * and `true` so the STT path writes no segments and emits no `TranscriptionCreated`.
 */
import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import { ConsultationAttachmentFactory } from '@arcaai/domains';
import { AudioAttachmentProcessor } from '../processors/audio.processor';
import { AttachmentTranscriptSink } from '../attachment-transcript.sink';
import {
  CONSULTATION,
  DOCTOR,
  FakeAttachmentRepository,
  FakeBlobStorage,
  TENANT,
  makeCls,
  makeContext,
  makeContextItems,
  makeGate,
} from './attachment-fakes.task1045';

const SPEC = { agent: { slug: 'asr-default', versionId: 'agent-v-1' } };

function makeProcessorDeps() {
  return {
    asr: { resolve: vi.fn(async () => ({ spec: SPEC, consultationLanguageMode: 'ml-en' })) },
    jobs: { createBatchJob: vi.fn(async () => ({ id: 'job-1', status: 'QUEUED' })), failJob: vi.fn(async () => undefined) },
    realtime: { dispatchDramatiqJob: vi.fn(async () => undefined) },
    blob: new FakeBlobStorage(),
    billing: { assertSpendLimit: vi.fn(async () => undefined) },
    cls: makeCls(),
  };
}

const buildProcessor = (p: ReturnType<typeof makeProcessorDeps>) =>
  new AudioAttachmentProcessor(p.asr as never, p.jobs as never, p.realtime as never, p.blob as never, p.cls as never, p.billing as never);

const input = {
  consultationId: CONSULTATION,
  attachmentId: 'att-1',
  mediaId: 'media-1',
  bucket: 'tenant-1-recordings',
  key: `consultations/2026/10/${CONSULTATION}/attachments/att-1/att-1.wav`,
  mime: 'audio/wav',
  doctorId: DOCTOR,
};

describe('AudioAttachmentProcessor', () => {
  let p: ReturnType<typeof makeProcessorDeps>;
  beforeEach(() => {
    p = makeProcessorDeps();
  });

  it('preflight is the tenant spend limit, before any job exists', async () => {
    p.billing.assertSpendLimit.mockRejectedValueOnce(new HttpException('limit', 402));
    await expect(buildProcessor(p).preflight()).rejects.toMatchObject({ status: 402 });
    expect(p.billing.assertSpendLimit).toHaveBeenCalledWith(TENANT);
    expect(p.jobs.createBatchJob).not.toHaveBeenCalled();
  });

  it('resolves the ASR agent from the consultation, creates the batch job and dispatches it', async () => {
    p.blob.resolveDescriptor.mockResolvedValueOnce({ provider: 's3' } as never);
    const outcome = await buildProcessor(p).process(input);

    expect(outcome).toEqual({ pending: true, contextItemId: null, transcriptionJobId: 'job-1' });
    expect(p.asr.resolve).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, consultationId: CONSULTATION }));
    expect(p.asr.resolve.mock.calls[0][0]).not.toHaveProperty('agentSlug');
    expect(p.jobs.createBatchJob).toHaveBeenCalledWith(
      expect.objectContaining({ agentVersionId: 'agent-v-1', resolvedSpec: SPEC, mediaId: 'media-1', consultationId: CONSULTATION }),
    );
    expect(p.realtime.dispatchDramatiqJob).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 'job-1',
        tenantId: TENANT,
        resolvedSpec: SPEC,
        audioUri: `s3://${input.bucket}/${input.key}`,
        consultationId: CONSULTATION,
        mediaId: 'media-1',
        userId: DOCTOR,
        audioBucketName: input.bucket,
        storage: { provider: 's3' },
        languageMode: 'ml-en',
        languageModeSource: 'consultation',
      }),
    );
  });

  it('fails the job and answers 502 when the dispatch fails', async () => {
    p.realtime.dispatchDramatiqJob.mockRejectedValueOnce(new Error('redis down'));
    const error = await buildProcessor(p)
      .process(input)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(502);
    expect(p.jobs.failJob).toHaveBeenCalledWith('job-1', 'redis down', 'SETUP_ERROR');
  });
});

describe('AttachmentTranscriptSink', () => {
  function setup() {
    const repo = new FakeAttachmentRepository();
    const row = ConsultationAttachmentFactory.CreateConsultationAttachment({
      tenantId: TENANT,
      consultationId: CONSULTATION,
      kind: 'AUDIO' as never,
      status: 'PROCESSING' as never,
      declaredMime: 'audio/wav',
      declaredSizeBytes: 100,
      declaredSha256: 'a'.repeat(64),
      bucketName: 'tenant-1-recordings',
      objectKey: 'k',
      uploadExpiresAt: new Date(),
      intentExpiresAt: new Date(Date.now() + 1000),
      mediaId: 'media-9',
      transcriptionJobId: 'job-1',
      createdBy: DOCTOR,
    });
    repo.rows.set(row.id, row);
    const context = makeContext();
    const gate = makeGate();
    const emitter = { emit: vi.fn() };
    const cls = makeCls(null, null);
    const items = makeContextItems();
    const sink = new AttachmentTranscriptSink(emitter as never, cls as never, repo as never, context as never, gate as never, items as never);
    return { repo, row, context, gate, emitter, cls, items, sink };
  }

  it('writes ONE transcript item for the attachment, marks it READY and claims the callback', async () => {
    const s = setup();
    await expect(s.sink.onBatchTranscript({ jobId: 'job-1', text: 'Patient has a cough.' })).resolves.toBe(true);

    expect(s.context.addContext).toHaveBeenCalledTimes(1);
    expect(s.context.addContext).toHaveBeenCalledWith(
      CONSULTATION,
      expect.objectContaining({
        type: 'TRANSCRIPT',
        source: 'TRANSCRIPTION',
        content: 'Patient has a cough.',
        mediaId: 'media-9',
        metadata: expect.objectContaining({ origin: 'attachment_audio', mediaId: 'media-9', attachmentId: s.row.id }),
      }),
    );
    // Tenant context comes from the row: the internal STT callback carries none.
    expect(s.cls.set).toHaveBeenCalledWith('tenantId', TENANT);
    expect(s.row.status).toBe('READY');
    expect(s.row.contextItemId).toBe('item-1');
    // No encounter on the row: the consultation's current one (the fact ledger selects by it).
    expect(s.gate.currentEncounterSeq).toHaveBeenCalledWith(CONSULTATION);
    expect(s.items.rows.get('item-1')!.encounterSeq).toBe(1);
    expect(s.gate.endProcessing).toHaveBeenCalledWith(CONSULTATION, s.row.id, undefined);
    expect(s.emitter.emit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resourceId: s.row.id }));
  });

  it('stamps the encounter the file was attached in when the row carries one', async () => {
    const s = setup();
    s.row.encounterSeq = 2;
    await s.sink.onBatchTranscript({ jobId: 'job-1', text: 'second visit' });
    expect(s.items.rows.get('item-1')!.encounterSeq).toBe(2);
    expect(s.context.addContext.mock.calls[0][1]).toMatchObject({ metadata: { encounterSeq: 2 } });
  });

  it('a replayed callback is still claimed but writes nothing new', async () => {
    const s = setup();
    await s.sink.onBatchTranscript({ jobId: 'job-1', text: 'once' });
    await expect(s.sink.onBatchTranscript({ jobId: 'job-1', text: 'once' })).resolves.toBe(true);
    expect(s.context.addContext).toHaveBeenCalledTimes(1);
  });

  it('a job that no attachment started is not claimed', async () => {
    const s = setup();
    await expect(s.sink.onBatchTranscript({ jobId: 'job-other', text: 'x' })).resolves.toBe(false);
    expect(s.context.addContext).not.toHaveBeenCalled();
  });

  it('an empty transcript ends processing without an item', async () => {
    const s = setup();
    await expect(s.sink.onBatchTranscript({ jobId: 'job-1', text: '   ' })).resolves.toBe(true);
    expect(s.context.addContext).not.toHaveBeenCalled();
    expect(s.row.status).toBe('FAILED');
    expect(s.row.failureCode).toBe('ATTACHMENT_TRANSCRIPT_EMPTY');
    expect(s.gate.endProcessing).toHaveBeenCalledWith(CONSULTATION, s.row.id, undefined);
  });
});
