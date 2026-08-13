/**
 * Batch upload ceilings + the two read surfaces.
 *
 * The requirement is "up to 5 recordings, each at most 60 minutes". Before this
 * ticket the route enforced neither: its only bound was a hardcoded 100 MB,
 * which rejects a legitimate 60-minute WAV (~115 MB) and admits a 3-hour
 * 64 kbps MP3 (~86 MB). These tests pin the enforcement in the units the
 * requirement is written in, and pin the two GETs the SDK reads so it never
 * hardcodes the same numbers a second time.
 *
 * Every rejection must happen BEFORE storage I/O and BEFORE the worker dispatch
 * — an over-long upload that still writes 200 MB to MinIO is not a rejection.
 */

import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

/** 16 kHz mono 16-bit WAV of `seconds`, declared in the header (payload elided). */
function wavFile(seconds: number, overrides: Partial<Express.Multer.File> = {}): Express.Multer.File {
  const sampleRate = 16000;
  const byteRate = sampleRate * 2;
  const dataSize = Math.round(seconds * byteRate);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);
  return { buffer: header, size: 44 + dataSize, mimetype: 'audio/wav', originalname: 'consult.wav', ...overrides } as Express.Multer.File;
}

function build(overrides: { limits?: Partial<Record<string, number>>; counts?: Record<string, number>; fallbackPipelineId?: string | null } = {}) {
  const mocks = {
    jobService: {
      createBatchJob: vi.fn().mockResolvedValue({ id: 'job-1', status: 'QUEUED' }),
      getStatusCountsForOwner: vi
        .fn()
        .mockResolvedValue({ queued: 0, processing: 0, completed: 9, failed: 2, cancelled: 0, dead: 0, ...overrides.counts }),
      failJob: vi.fn().mockResolvedValue(undefined),
    },
    realtimeService: { dispatchDramatiqJob: vi.fn().mockResolvedValue(undefined) },
    sessionService: {},
    cls: { get: vi.fn().mockReturnValue({ id: 'user-1', tenantId: 'tenant-1' }) },
    blobStorage: { putObject: vi.fn().mockResolvedValue(undefined), resolveDescriptor: vi.fn().mockResolvedValue(null) },
    tenantBucketService: { getBucketByPurpose: vi.fn().mockResolvedValue(null), getBucketBySlug: vi.fn().mockResolvedValue(null) },
    pipelineService: { getById: vi.fn().mockImplementation(async (id: string) => ({ id, tenantId: 'tenant-1', name: 'Primary', slug: id })) },
    streamTicketService: {},
    binding: {},
    entitlements: { assertConcurrencyQuota: vi.fn().mockResolvedValue(undefined) },
    sttConfig: {
      getEffective: vi
        .fn()
        .mockResolvedValue({ fallbackPipelineId: overrides.fallbackPipelineId === undefined ? 'fallback-pipe' : overrides.fallbackPipelineId }),
      resolveProviderOverrides: vi.fn().mockResolvedValue({}),
    },
    batchLimits: {
      resolve: vi
        .fn()
        .mockResolvedValue({ maxFilesPerBatch: 5, maxDurationMinutes: 60, maxFileSizeMb: 250, maxActiveJobsPerUser: 5, ...overrides.limits }),
    },
  };

  const controller = new TranscriptionJobController(
    mocks.jobService as never,
    mocks.realtimeService as never,
    mocks.sessionService as never,
    mocks.cls as never,
    mocks.blobStorage as never,
    mocks.tenantBucketService as never,
    mocks.pipelineService as never,
    mocks.streamTicketService as never,
    mocks.binding as never,
    mocks.entitlements as never,
    mocks.sttConfig as never,
    mocks.batchLimits as never,
  );
  return { controller, mocks };
}

const body = { pipelineId: 'primary-pipe' } as never;

describe('POST transcribe — duration ceiling', () => {
  beforeEach(() => vi.clearAllMocks());

  it('accepts a recording under the ceiling', async () => {
    const { controller, mocks } = build();
    await expect(controller.transcribeFile(wavFile(59 * 60), body)).resolves.toMatchObject({ id: 'job-1' });
    expect(mocks.blobStorage.putObject).toHaveBeenCalledTimes(1);
  });

  it('rejects a 61-minute recording with 400 naming both durations', async () => {
    const { controller } = build();
    await expect(controller.transcribeFile(wavFile(61 * 60), body)).rejects.toThrow(BadRequestException);
    await expect(controller.transcribeFile(wavFile(61 * 60), body)).rejects.toThrow(/61(\.\d+)?\s*min.*60\s*min/i);
  });

  it('rejects BEFORE touching storage, the job table, or the worker queue', async () => {
    const { controller, mocks } = build();
    await expect(controller.transcribeFile(wavFile(90 * 60), body)).rejects.toThrow(BadRequestException);
    expect(mocks.blobStorage.putObject).not.toHaveBeenCalled();
    expect(mocks.jobService.createBatchJob).not.toHaveBeenCalled();
    expect(mocks.realtimeService.dispatchDramatiqJob).not.toHaveBeenCalled();
  });

  it('honours an operator-lowered ceiling', async () => {
    const { controller } = build({ limits: { maxDurationMinutes: 10 } });
    await expect(controller.transcribeFile(wavFile(11 * 60), body)).rejects.toThrow(BadRequestException);
    await expect(controller.transcribeFile(wavFile(9 * 60), body)).resolves.toBeDefined();
  });

  it('rejects a file whose duration cannot be established (fail-closed)', async () => {
    // Owner decision 2026-08-03: an unmeasurable recording is not evidence of a
    // recording within the limit.
    const opaque = {
      buffer: Buffer.from('nothing parseable here at all'),
      size: 29,
      mimetype: 'audio/wav',
      originalname: 'x.wav',
    } as Express.Multer.File;
    await expect(build().controller.transcribeFile(opaque, body)).rejects.toThrow(/duration/i);
  });

  it('does not trust the declared MIME type over the actual bytes', async () => {
    // Labelled mp3, actually a 3-hour WAV — the parsed duration must still win.
    const mislabelled = wavFile(180 * 60, { mimetype: 'audio/mpeg', originalname: 'consult.mp3' });
    await expect(build().controller.transcribeFile(mislabelled, body)).rejects.toThrow(BadRequestException);
  });
});

describe('POST transcribe — size and concurrency ceilings', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a file over the resolved size ceiling', async () => {
    const { controller } = build({ limits: { maxFileSizeMb: 10 } });
    const big = wavFile(30, { size: 11 * 1024 * 1024 });
    await expect(controller.transcribeFile(big, body)).rejects.toThrow(/10\s*MB/i);
  });

  it('admits a 60-minute WAV that the old hardcoded 100 MB limit rejected', async () => {
    // The regression this ticket exists to fix: ~115 MB of legitimate audio.
    const sixtyMinutes = wavFile(60 * 60, { size: 115 * 1024 * 1024 });
    await expect(build().controller.transcribeFile(sixtyMinutes, body)).resolves.toBeDefined();
  });

  it('rejects with 429 when the caller already holds the maximum in-flight jobs', async () => {
    const { controller } = build({ counts: { queued: 3, processing: 2 } });
    await expect(controller.transcribeFile(wavFile(60), body)).rejects.toMatchObject({ status: 429 });
  });

  it('counts only queued + processing as in-flight', async () => {
    // 20 finished jobs must not block the 1st new one.
    const { controller } = build({ counts: { queued: 0, processing: 0, completed: 20, failed: 8, cancelled: 4, dead: 1 } });
    await expect(controller.transcribeFile(wavFile(60), body)).resolves.toBeDefined();
  });
});

describe('GET limits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports the resolved ceilings plus the accepted MIME types', async () => {
    const { controller } = build({ limits: { maxFilesPerBatch: 3, maxDurationMinutes: 45 } });
    const limits = await controller.getBatchLimits();

    expect(limits.maxFilesPerBatch).toBe(3);
    expect(limits.maxDurationMinutes).toBe(45);
    expect(limits.maxFileSizeBytes).toBe(250 * 1024 * 1024);
    expect(limits.maxActiveJobsPerUser).toBe(5);
    expect(limits.allowedMimeTypes).toContain('audio/wav');
    expect(limits.allowedMimeTypes).toContain('audio/webm');
  });
});

describe('GET fallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('names the tenant’s configured fallback pipeline', async () => {
    const { controller } = build({ fallbackPipelineId: 'fallback-pipe' });
    await expect(controller.getFallbackProvider()).resolves.toEqual({ configured: true, pipelineId: 'fallback-pipe', pipelineName: 'Primary' });
  });

  it('reports configured:false rather than throwing when no fallback is set', async () => {
    // The live toggle must be able to DISABLE its button instead of discovering
    // the 409 mid-consultation.
    const { controller } = build({ fallbackPipelineId: null });
    await expect(controller.getFallbackProvider()).resolves.toEqual({ configured: false, pipelineId: null, pipelineName: null });
  });

  it('reports configured:false when the pipeline row is gone (stale pointer)', async () => {
    const { controller, mocks } = build({ fallbackPipelineId: 'deleted-pipe' });
    mocks.pipelineService.getById.mockResolvedValue(null);
    await expect(controller.getFallbackProvider()).resolves.toEqual({ configured: false, pipelineId: 'deleted-pipe', pipelineName: null });
  });

  it('never leaks a settings error to the caller — it degrades to not-configured', async () => {
    const { controller, mocks } = build();
    mocks.sttConfig.getEffective.mockRejectedValue(new Error('vault down'));
    await expect(controller.getFallbackProvider()).resolves.toMatchObject({ configured: false });
  });
});

describe('route ordering', () => {
  it('declares the literal GETs before the catch-all :id route', () => {
    // `@Get(':id')` would otherwise swallow `/limits` and `/fallback` and try to
    // load them as job ids. Nest registers routes in method-declaration order,
    // which is the order `getOwnPropertyNames` reports.
    const methods = Object.getOwnPropertyNames(TranscriptionJobController.prototype);
    expect(methods).toContain('getBatchLimits');
    expect(methods).toContain('getFallbackProvider');
    expect(methods.indexOf('getBatchLimits')).toBeLessThan(methods.indexOf('getById'));
    expect(methods.indexOf('getFallbackProvider')).toBeLessThan(methods.indexOf('getById'));
  });
});
