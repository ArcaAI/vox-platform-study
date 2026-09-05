/**
 * TASK-874 — `POST /api/v1/internal/stt/streaming/usage` must accept the
 * per-engine `segments` breakdown.
 *
 * The STT idle reaper POSTs its teardown summary VERBATIM
 * (`gateway.py::record_streaming_usage` sends `{**summary, interrupted}`), and
 * the global pipe runs `forbidNonWhitelisted`. So a field added to the summary
 * that is NOT declared on this DTO does not degrade gracefully — every push-back
 * from a session that switched engines 400s, and the usage is lost exactly on
 * the path that exists because the gateway already crashed once.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { SttStreamingUsagePushbackRequest } from '../dto/stt-streaming-usage.request';

// The global pipe configuration from `main.ts`.
const pipeCfg = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

const summary = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  tenant_id: 't-1',
  consultation_id: 'c-1',
  user_id: 'u-1',
  pipeline_id: 'p-1',
  closed_at: '2026-08-06T10:01:30',
  audio_seconds: 42.5,
  session_seconds: 90.0,
  engine: 'whisper_cpp',
  deployment: 'SELF_HOSTED',
  language_mode: 'ml-en',
  channel_count: 1,
  interrupted: true,
  ...overrides,
});

const transform = async (body: Record<string, unknown>) =>
  new ValidationPipe(pipeCfg).transform(plainToInstance(SttStreamingUsagePushbackRequest, body), {
    type: 'body',
    metatype: SttStreamingUsagePushbackRequest,
  } as never);

describe('SttStreamingUsagePushbackRequest — per-engine segments', () => {
  it('accepts a reaper summary carrying the per-engine segments', async () => {
    const result = (await transform(
      summary({
        segments: [
          { engine: 'sarvam', deployment: 'BYOK', audio_seconds: 30.0, session_seconds: 60.0 },
          { engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 12.5, session_seconds: 30.0 },
        ],
      }),
    )) as SttStreamingUsagePushbackRequest;

    expect(result.segments).toHaveLength(2);
    expect(result.segments?.[0]).toMatchObject({ engine: 'sarvam', deployment: 'BYOK', audio_seconds: 30.0, session_seconds: 60.0 });
    expect(result.segments?.[1]?.deployment).toBe('SELF_HOSTED');
  });

  it('still accepts a summary from an STT that predates segments', async () => {
    const result = (await transform(summary())) as SttStreamingUsagePushbackRequest;
    expect(result.segments).toBeUndefined();
    expect(result.engine).toBe('whisper_cpp');
  });

  it('rejects a segment whose deployment is not a known kind — never a guessed economic tier', async () => {
    await expect(
      transform(summary({ segments: [{ engine: 'sarvam', deployment: 'FREE', audio_seconds: 1, session_seconds: 1 }] })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a negative segment duration', async () => {
    await expect(
      transform(summary({ segments: [{ engine: 'sarvam', deployment: 'BYOK', audio_seconds: -1, session_seconds: 1 }] })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
