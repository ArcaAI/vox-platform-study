/**
 * TASK-958 D-7 — `POST /api/v1/internal/stt/streaming/usage` must accept
 * `connection_id`, top-level and on every segment.
 *
 * Same failure mode TASK-874's segments had, for the same reason: the STT idle
 * reaper POSTs its teardown summary VERBATIM (`gateway.py::record_streaming_usage`
 * sends `{**summary, interrupted}`), and the global pipe runs
 * `forbidNonWhitelisted`. A field `apps/stt` now puts in that summary and this DTO
 * does not declare 400s the whole push-back — losing the usage on the path that
 * exists precisely because the gateway already crashed once.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { SttStreamingUsagePushbackRequest } from '../dto/stt-streaming-usage.request';

const pipeCfg = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

const summary = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  tenant_id: 't-1',
  consultation_id: 'c-1',
  user_id: 'u-1',
  pipeline_id: 'p-1',
  closed_at: '2026-09-12T10:01:30',
  audio_seconds: 42.5,
  session_seconds: 90.0,
  engine: 'azure-speech',
  deployment: 'BYOK',
  language_mode: 'ml-en',
  channel_count: 1,
  interrupted: false,
  ...overrides,
});

const transform = async (body: Record<string, unknown>) =>
  new ValidationPipe(pipeCfg).transform(plainToInstance(SttStreamingUsagePushbackRequest, body), {
    type: 'body',
    metatype: SttStreamingUsagePushbackRequest,
  } as never);

describe('SttStreamingUsagePushbackRequest — TASK-958 connection attribution', () => {
  it('accepts `connection_id` at the top level and on every segment', async () => {
    const body = summary({
      connection_id: 'conn-azure-primary',
      segments: [
        { engine: 'azure-speech', deployment: 'BYOK', audio_seconds: 30, session_seconds: 60, connection_id: 'conn-azure-primary' },
        { engine: 'azure-speech', deployment: 'BYOK', audio_seconds: 12.5, session_seconds: 30, connection_id: 'conn-azure-research' },
      ],
    });
    const out = (await transform(body)) as SttStreamingUsagePushbackRequest;
    expect(out.connection_id).toBe('conn-azure-primary');
    // Two segments on ONE engine name, separated only by the account — which is the
    // whole point: a session that failed over between a tenant's two accounts bills
    // two rows, and each must name the one it spent.
    expect(out.segments?.map((s) => s.connection_id)).toEqual(['conn-azure-primary', 'conn-azure-research']);
  });

  it('still accepts the LEGACY payload that names no connection anywhere', async () => {
    const out = (await transform(
      summary({ segments: [{ engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 42.5, session_seconds: 90 }] }),
    )) as SttStreamingUsagePushbackRequest;
    expect(out.connection_id).toBeUndefined();
    expect(out.segments?.[0].connection_id).toBeUndefined();
  });

  it('still refuses a field nobody declared — the whitelist is not loosened', async () => {
    await expect(transform(summary({ connection_secret: 'sk-live-oops' }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
