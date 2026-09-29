/**
 * TASK-1012 L-7 — a transcription job runs on the ASR Agent the GATEWAY resolves, never on an
 * engine chain the caller hands in.
 *
 * `POST audio/transcription-jobs`, `/batch` and `/streaming` used to declare `agentVersionId` +
 * `resolvedSpec` on their public DTOs: `/batch` and `/streaming` forwarded them to the job verbatim
 * (they could not run without a caller-built spec at all), and `create` honoured them whenever
 * `agentVersionId` was present. A `ResolvedAsrSpec` names the models, their weight paths and the
 * fallback chain — a caller writing one bypasses agent selection entirely. Now:
 *
 *   - the three DTOs no longer declare either field, so the strict global pipe 400s them;
 *   - each route resolves `agentSlug` (or the assignment cascade) and keys the job to THAT;
 *   - `codeSwitching` (ignored by the worker since TASK-1004) stays accepted but deprecated, since
 *     a published integration may still send it.
 */
import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { CreateBatchJobRequest, CreateJobRequest, CreateStreamingJobRequest } from '@arcaai/applications';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobController } from '../transcription-job.controller';

/** The exact options `main.ts` installs globally. */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

const MEDIA = '01923d4e-0000-7000-8000-000000000001';

const DTOS = [
  ['POST audio/transcription-jobs', CreateJobRequest, { jobType: 'BATCH', mediaId: MEDIA }],
  ['POST audio/transcription-jobs/batch', CreateBatchJobRequest, { mediaId: MEDIA }],
  ['POST audio/transcription-jobs/streaming', CreateStreamingJobRequest, {}],
] as const;

async function messages(metatype: new () => object, body: Record<string, unknown>): Promise<string[]> {
  try {
    await pipe.transform(body, { type: 'body', metatype });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { message: string[] }).message;
  }
  return [];
}

describe('the public job DTOs no longer accept a caller-built engine chain', () => {
  it.each(DTOS)('%s refuses agentVersionId and resolvedSpec', async (_route, metatype, base) => {
    const refused = await messages(metatype as unknown as new () => object, {
      ...base,
      agentVersionId: 'caller-version',
      resolvedSpec: { models: { asr: { localPath: '/etc/passwd' } } },
    });
    expect(refused).toContain('property agentVersionId should not exist');
    expect(refused).toContain('property resolvedSpec should not exist');
  });

  it.each(DTOS)('%s accepts agentSlug — the selector', async (_route, metatype, base) => {
    await expect(messages(metatype as unknown as new () => object, { ...base, agentSlug: 'platform-transcription' })).resolves.toEqual([]);
  });

  it.each(DTOS)('%s still accepts codeSwitching, documented deprecated + ignored', async (_route, metatype, base) => {
    await expect(messages(metatype as unknown as new () => object, { ...base, codeSwitching: true })).resolves.toEqual([]);
    const meta = Reflect.getMetadata('swagger/apiModelProperties', (metatype as unknown as { prototype: object }).prototype, 'codeSwitching') as {
      deprecated?: boolean;
      description?: string;
    };
    expect(meta.deprecated).toBe(true);
    expect(meta.description).toMatch(/^Ignored/);
  });
});

const SPEC = { runtimeKey: 'agent-v-1', agent: { slug: 'platform-transcription', versionId: 'agent-v-1' } };

function build() {
  const jobService = {
    create: vi.fn().mockResolvedValue({ id: 'job-1' }),
    createBatchJob: vi.fn().mockResolvedValue({ id: 'job-2' }),
    createStreamingJob: vi.fn().mockResolvedValue({ id: 'job-3' }),
  };
  const asrResolver = { resolve: vi.fn().mockResolvedValue({ spec: SPEC }) };
  const cls = { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : { id: 'user-1', tenantId: 'tenant-1' })) };
  const controller = new TranscriptionJobController(
    jobService as never,
    {} as never,
    {} as never,
    cls as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    asrResolver as never,
  );
  return { controller, jobService, asrResolver };
}

const CALLER_CHAIN = { agentVersionId: 'caller-version', resolvedSpec: { models: { asr: { localPath: '/etc/passwd' } } } };

beforeEach(() => vi.clearAllMocks());

describe('every job route keys the job to the RESOLVED agent, never a caller-supplied one', () => {
  it.each([
    ['create', 'create', { jobType: 'BATCH', mediaId: MEDIA }],
    ['createBatch', 'createBatchJob', { mediaId: MEDIA }],
    ['createStreaming', 'createStreamingJob', {}],
  ] as const)('%s: agentSlug → the resolver; a smuggled agentVersionId/resolvedSpec is overwritten', async (route, serviceMethod, base) => {
    const { controller, jobService, asrResolver } = build();

    await (controller as unknown as Record<string, (dto: unknown) => Promise<unknown>>)[route]({
      ...base,
      agentSlug: 'platform-transcription',
      ...CALLER_CHAIN,
    });

    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: 'platform-transcription', departmentId: null, consultationId: null });
    const input = jobService[serviceMethod].mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({ agentVersionId: 'agent-v-1', resolvedSpec: SPEC });
    expect(input).not.toHaveProperty('agentSlug');
    expect(JSON.stringify(input)).not.toContain('caller-version');
    expect(JSON.stringify(input)).not.toContain('/etc/passwd');
  });

  it.each([['createBatch'], ['createStreaming']] as const)('%s with no selector → the assignment cascade', async (route) => {
    const { controller, asrResolver } = build();

    await (controller as unknown as Record<string, (dto: unknown) => Promise<unknown>>)[route]({ mediaId: MEDIA });

    expect(asrResolver.resolve).toHaveBeenCalledWith({ tenantId: 'tenant-1', agentSlug: null, departmentId: null, consultationId: null });
  });
});
