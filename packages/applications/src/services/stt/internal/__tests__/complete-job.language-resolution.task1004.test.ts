/**
 * TASK-1004 — a batch job's language RECEIPT arrives on the worker's completion callback
 * (`languageResolution`, inner keys snake_case), is persisted camelCase on the job row, and is
 * answered on every job read. A malformed receipt is dropped — the completion itself never fails
 * over a display/audit fact.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SttInternalService } from '../sttInternal.service';
import { InternalCompleteJobRequest, InternalFailJobRequest } from '../dto/internal.request';
import { TranscriptionJobDtoMapper } from '../../job/transcriptionJob.dto.mapper';

const fixture = JSON.parse(readFileSync(resolve(__dirname, '../../../../../../../tests/contracts/language-resolution.fixture.json'), 'utf-8')) as {
  receipt: { examples: Array<{ python: Record<string, unknown>; gateway: Record<string, unknown> }> };
};
const whisper = fixture.receipt.examples[0]!;

/* eslint-disable @typescript-eslint/no-explicit-any */
function makeJob(overrides: Record<string, any> = {}) {
  const job: Record<string, any> = {
    id: 'job-1',
    tenantId: 'tenant-1',
    status: 'PROCESSING',
    version: 3,
    resolvedSpec: null,
    dispatchEnvelope: {
      audioUri: 's3://a.wav',
      pipelineId: 'agent-v-1',
      languageMode: 'ml-en',
      languageModeSource: 'request',
      hadStorageDescriptor: false,
    },
    createdBy: 'user-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  job.complete = vi.fn((text: string) => {
    job.resultText = text;
    job.status = 'COMPLETED';
  });
  return job;
}

function build(job: Record<string, any>) {
  const jobRepository = {
    findById: vi.fn().mockResolvedValue(job),
    update: vi.fn(async (_id: string, e: unknown) => e),
    updateWithVersion: vi.fn(async (_id: string, e: unknown) => e),
    encryptFieldsIntoEntity: vi.fn(),
  };
  const service = new SttInternalService(
    jobRepository as never,
    {} as never,
    {} as never,
    {} as never,
    { emit: vi.fn() } as never,
    { get: vi.fn(() => null) } as never,
    undefined,
  );
  return { service, jobRepository };
}

beforeEach(() => vi.clearAllMocks());

describe('completeJob — languageResolution', () => {
  it('persists the receipt camelCase beside the dispatch facts and answers it', async () => {
    const job = makeJob();
    const { service, jobRepository } = build(job);

    const response = await service.completeJob('job-1', { resultText: 'hello', languageResolution: whisper.python } as any);

    const saved = jobRepository.update.mock.calls[0]![1] as Record<string, any>;
    expect(saved.dispatchEnvelope).toMatchObject({ audioUri: 's3://a.wav', languageMode: 'ml-en', languageResolution: whisper.gateway });
    expect(response.languageResolution).toEqual(whisper.gateway);
  });

  it('a malformed receipt is dropped; the completion still succeeds', async () => {
    const job = makeJob();
    const { service, jobRepository } = build(job);
    const response = await service.completeJob('job-1', { resultText: 'hello', languageResolution: { source: 'guess' } } as any);
    expect((jobRepository.update.mock.calls[0]![1] as any).dispatchEnvelope).not.toHaveProperty('languageResolution');
    expect(response.languageResolution ?? null).toBeNull();
    expect(job.status).toBe('COMPLETED');
  });

  it('no receipt (an older worker) leaves the row untouched', async () => {
    const job = makeJob();
    const { service, jobRepository } = build(job);
    await service.completeJob('job-1', { resultText: 'hello' } as any);
    expect((jobRepository.update.mock.calls[0]![1] as any).dispatchEnvelope).not.toHaveProperty('languageResolution');
  });
});

describe('job reads answer the receipt', () => {
  it('TranscriptionJobDtoMapper lifts languageResolution; null when the row has none', () => {
    const withReceipt = TranscriptionJobDtoMapper.toResponse(
      makeJob({ dispatchEnvelope: { audioUri: 'x', languageResolution: whisper.gateway } }) as never,
    );
    expect(withReceipt.languageResolution).toEqual(whisper.gateway);
    expect(TranscriptionJobDtoMapper.toResponse(makeJob({ dispatchEnvelope: null }) as never).languageResolution).toBeNull();
  });
});

describe('the internal callback DTOs accept the TASK-1004 fields (forbidNonWhitelisted)', () => {
  const opts = { whitelist: true, forbidNonWhitelisted: true };
  it('InternalCompleteJobRequest accepts languageResolution', async () => {
    expect(await validate(plainToInstance(InternalCompleteJobRequest, { resultText: 'x', languageResolution: whisper.python }), opts)).toEqual([]);
  });
  it('InternalFailJobRequest accepts error code LANGUAGE_MODE_UNSUPPORTED', async () => {
    expect(
      await validate(
        plainToInstance(InternalFailJobRequest, { errorMessage: 'no engine can serve vi-en', errorCode: 'LANGUAGE_MODE_UNSUPPORTED' }),
        opts,
      ),
    ).toEqual([]);
  });
});
