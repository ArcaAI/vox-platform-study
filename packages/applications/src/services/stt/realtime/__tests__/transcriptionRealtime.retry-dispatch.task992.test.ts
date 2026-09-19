/**
 * TASK-992 FU-1 — a retry must PUBLISH a message, not just flip a status.
 *
 * Before this, `retryJob` set the row back to QUEUED and nothing re-published a
 * Dramatiq message. The caller got a 200 and a job no worker would ever claim —
 * from the outside indistinguishable from a backed-up queue.
 *
 * These tests are about the message, not the row: every one of them asserts on
 * what reached (or did not reach) the broker.
 */

import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionRealtimeService } from '../transcriptionRealtime.service';

vi.mock('uuidv7', () => ({ uuidv7: vi.fn(() => 'test-uuid-1234') }));

const ORIGINAL_DISPATCH = {
  jobId: 'job-001',
  tenantId: 'tenant-1',
  pipelineId: 'agent-v-1',
  audioUri: 's3://recordings/2026/09/jobs/job-001/raw/visit.wav',
  consultationId: 'consult-1',
  mediaId: 'media-1',
  language: 'en',
  userId: 'clinician-1',
  audioBucketName: 'recordings',
};

const DESCRIPTOR = { provider: 'aws_s3' as const, bucket: 'recordings', secret_access_key: 'rotates-between-attempts' };

/** The row's own TASK-861 snapshot, which the envelope deliberately does NOT duplicate. */
const RESOLVED_SPEC = { runtimeKey: 'agent-v-1', models: { embedding: null }, audioFrontEnd: { diarization: { enabled: false } } };

/** What `dispatchDramatiqJob` wrote for the ORIGINAL attempt, read back on retry. */
const STORED_ENVELOPE = {
  audioUri: ORIGINAL_DISPATCH.audioUri,
  pipelineId: ORIGINAL_DISPATCH.pipelineId,
  consultationId: ORIGINAL_DISPATCH.consultationId,
  mediaId: ORIGINAL_DISPATCH.mediaId,
  language: ORIGINAL_DISPATCH.language,
  userId: ORIGINAL_DISPATCH.userId,
  audioBucketName: ORIGINAL_DISPATCH.audioBucketName,
  hadStorageDescriptor: true,
};

function build(overrides: { job?: Record<string, unknown>; blob?: unknown } = {}) {
  const cache = {
    hset: vi.fn().mockResolvedValue(undefined),
    rpush: vi.fn().mockResolvedValue(1),
    publish: vi.fn().mockResolvedValue(undefined),
  };
  const jobService = {
    recordDispatchEnvelope: vi.fn().mockResolvedValue(undefined),
    getDispatchContextForOwner: vi.fn().mockResolvedValue({ envelope: STORED_ENVELOPE, resolvedSpec: RESOLVED_SPEC, tenantId: 'tenant-1' }),
    retryJobForOwner: vi.fn().mockResolvedValue({ id: 'job-001', status: 'QUEUED', retryCount: 1 }),
    failJob: vi.fn().mockResolvedValue(undefined),
    ...(overrides.job ?? {}),
  };
  const blob = overrides.blob === undefined ? { resolveDescriptor: vi.fn().mockResolvedValue(DESCRIPTOR) } : overrides.blob;
  const service = new TranscriptionRealtimeService(
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    jobService as never,
    cache as never,
    undefined,
    blob as never,
  );
  return { service, cache, jobService, blob };
}

const publishedMessage = (cache: { hset: ReturnType<typeof vi.fn> }) => JSON.parse(cache.hset.mock.calls[0][2]);

describe('dispatchDramatiqJob — snapshots what it published (TASK-992 FU-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records the envelope a retry will need', async () => {
    const { service, jobService } = build();

    await service.dispatchDramatiqJob({ ...ORIGINAL_DISPATCH, storage: DESCRIPTOR as never });

    expect(jobService.recordDispatchEnvelope).toHaveBeenCalledWith('job-001', {
      audioUri: ORIGINAL_DISPATCH.audioUri,
      pipelineId: 'agent-v-1',
      consultationId: 'consult-1',
      mediaId: 'media-1',
      language: 'en',
      userId: 'clinician-1',
      audioBucketName: 'recordings',
      hadStorageDescriptor: true,
    });
  });

  it('never snapshots the storage credential — only that one was in play', async () => {
    const { service, jobService } = build();

    await service.dispatchDramatiqJob({ ...ORIGINAL_DISPATCH, storage: DESCRIPTOR as never });

    expect(JSON.stringify(jobService.recordDispatchEnvelope.mock.calls[0][1])).not.toContain('rotates-between-attempts');
  });

  it('enqueues even when the snapshot write fails — dispatch must not gain a hard DB dependency', async () => {
    const { service, cache } = build({ job: { recordDispatchEnvelope: vi.fn().mockRejectedValue(new Error('db blip')) } });

    await expect(service.dispatchDramatiqJob({ ...ORIGINAL_DISPATCH })).resolves.toBeUndefined();

    expect(cache.rpush).toHaveBeenCalledWith('dramatiq:stt_batch', 'test-uuid-1234');
  });
});

describe('retryAndDispatch (TASK-992 FU-1)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('publishes a Dramatiq message carrying the original job arguments', async () => {
    const { service, cache } = build();

    await service.retryAndDispatch('job-001', { ownerId: 'clinician-1' });

    expect(cache.rpush).toHaveBeenCalledWith('dramatiq:stt_batch', 'test-uuid-1234');
    expect(cache.publish).toHaveBeenCalledWith('dramatiq:__events__', 'stt_batch');
    const message = publishedMessage(cache);
    expect(message.actor_name).toBe('transcribe_file');
    expect(message.args).toEqual([
      'job-001',
      'tenant-1',
      'agent-v-1',
      ORIGINAL_DISPATCH.audioUri,
      'consult-1',
      'media-1',
      'en',
      null,
      'recordings',
      'clinician-1',
    ]);
    expect(message.kwargs.resolved_spec).toEqual(RESOLVED_SPEC);
  });

  it('flips the row to QUEUED as well', async () => {
    const { service, jobService } = build();

    const result = await service.retryAndDispatch('job-001', { ownerId: 'clinician-1' });

    expect(jobService.retryJobForOwner).toHaveBeenCalledWith('clinician-1', 'job-001');
    expect(result.status).toBe('QUEUED');
  });

  it('re-resolves the storage descriptor live rather than replaying a stored one', async () => {
    const { service, cache, blob } = build();

    await service.retryAndDispatch('job-001', { ownerId: 'clinician-1' });

    expect((blob as { resolveDescriptor: ReturnType<typeof vi.fn> }).resolveDescriptor).toHaveBeenCalledWith('recordings');
    expect(publishedMessage(cache).kwargs.storage).toEqual(DESCRIPTOR);
  });

  it('refuses a row with no envelope, and leaves its status alone', async () => {
    const { service, jobService, cache } = build({
      job: { getDispatchContextForOwner: vi.fn().mockResolvedValue({ envelope: null, resolvedSpec: null, tenantId: 'tenant-1' }) },
    });

    await expect(service.retryAndDispatch('job-001', { ownerId: 'clinician-1' })).rejects.toThrow(ConflictException);

    expect(jobService.retryJobForOwner).not.toHaveBeenCalled();
    expect(cache.rpush).not.toHaveBeenCalled();
  });

  it('refuses when a descriptor was in play but cannot be produced, rather than dispatching at the wrong backend', async () => {
    const { service, jobService, cache } = build({ blob: { resolveDescriptor: vi.fn().mockResolvedValue(null) } });

    await expect(service.retryAndDispatch('job-001', { ownerId: 'clinician-1' })).rejects.toThrow(ServiceUnavailableException);

    expect(jobService.retryJobForOwner).not.toHaveBeenCalled();
    expect(cache.rpush).not.toHaveBeenCalled();
  });

  it('fails the job back when the enqueue throws, so no row is left QUEUED with nothing behind it', async () => {
    const { service, jobService } = build();
    (jobService.recordDispatchEnvelope as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const service2 = service as unknown as { cacheService: { hset: ReturnType<typeof vi.fn> } };
    service2.cacheService.hset.mockRejectedValue(new Error('redis down'));

    await expect(service.retryAndDispatch('job-001', { ownerId: 'clinician-1' })).rejects.toThrow('redis down');

    expect(jobService.failJob).toHaveBeenCalledWith('job-001', expect.stringContaining('redis down'), 'RETRY_DISPATCH_ERROR');
  });
});
