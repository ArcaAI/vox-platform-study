import 'reflect-metadata';
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { CreateBatchJobRequest, CreateJobRequest, CreateStreamingJobRequest, TranscriptionJobResponse } from '@arcaai/applications';
import { CreateStreamSessionRequest, StreamSessionResponse, TranscribeFileRequest } from '../dto';

/**
 * TASK-1006 — `pipelineId` is no longer an input anywhere on the native STT surface. Selection is
 * `agentSlug` (or nothing: the assignment cascade) → `AsrAgentResolverService` → `ResolvedAsrSpec`.
 * The field is GONE from the request DTOs, so the global pipe's `forbidNonWhitelisted` answers a
 * client that still sends it with a 400 naming the property — it is never silently honoured and
 * never silently dropped.
 */

/** The exact options `main.ts` installs globally. */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

async function rejection(metatype: new () => object, body: Record<string, unknown>): Promise<string[]> {
  try {
    await pipe.transform(body, { type: 'body', metatype });
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse() as { message: string[] };
    return response.message;
  }
  return [];
}

const MEDIA = '01923d4e-0000-7000-8000-000000000001';

describe('TASK-1006 — a request that still sends pipelineId is a 400', () => {
  it.each([
    ['POST audio/transcription-jobs/stream/session', CreateStreamSessionRequest, {}],
    ['POST audio/transcription-jobs/transcribe', TranscribeFileRequest, {}],
    ['POST audio/transcription-jobs', CreateJobRequest, { jobType: 'BATCH', mediaId: MEDIA }],
    ['POST audio/transcription-jobs/batch', CreateBatchJobRequest, { mediaId: MEDIA }],
    ['POST audio/transcription-jobs/streaming', CreateStreamingJobRequest, {}],
  ] as const)('%s', async (_route, metatype, base) => {
    const messages = await rejection(metatype as unknown as new () => object, { ...base, pipelineId: 'general-consult' });
    expect(messages).toContain('property pipelineId should not exist');
  });

  it('fallbackPipelineId is not an input either', async () => {
    const messages = await rejection(CreateStreamSessionRequest, { fallbackPipelineId: 'fallback-pipe' });
    expect(messages).toContain('property fallbackPipelineId should not exist');
  });

  it('the agent path is unaffected: agentSlug (or nothing) validates', async () => {
    await expect(
      pipe.transform({ agentSlug: 'platform-transcription' }, { type: 'body', metatype: CreateStreamSessionRequest }),
    ).resolves.toBeInstanceOf(CreateStreamSessionRequest);
    await expect(pipe.transform({}, { type: 'body', metatype: TranscribeFileRequest })).resolves.toBeInstanceOf(TranscribeFileRequest);
  });
});

describe('TASK-1006 — no response names a pipeline any more', () => {
  it('the stream-session and job responses declare no pipelineId / pipeline field', () => {
    // `@ApiProperty` records each declared field as `:<name>` on the prototype.
    const declared = (cls: new () => object) =>
      ((Reflect.getMetadata('swagger/apiModelPropertiesArray', cls.prototype) ?? []) as string[]).map((key) => key.replace(/^:/, ''));
    expect(declared(StreamSessionResponse)).toContain('sessionId');
    expect(declared(StreamSessionResponse)).not.toContain('pipelineId');
    expect(declared(TranscriptionJobResponse)).not.toContain('pipelineId');
    expect(declared(TranscriptionJobResponse)).not.toContain('pipeline');
  });
});
