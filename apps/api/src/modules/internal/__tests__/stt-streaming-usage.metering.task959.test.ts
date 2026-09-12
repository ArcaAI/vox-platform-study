/**
 * TASK-959 §3.2/§4.2 — `POST /api/v1/internal/stt/streaming/usage` must accept
 * the compute and network fields every `UsageSegment` now carries.
 *
 * `UsageSegment.to_dict()` on branch `task-959/stt` emits five more keys —
 * `processing_seconds`, `device`, `request_bytes`, `response_bytes`,
 * `byte_source` — and, unlike the batch callback, it emits them ALWAYS,
 * including as explicit `null`s (`to_dict` dumps every field). The reaper POSTs
 * that dict verbatim (`gateway.py::record_streaming_usage` sends
 * `{**summary, interrupted}`), and the global pipe runs `forbidNonWhitelisted`:
 * undeclared, ANY ONE of the five 400s the whole push-back — on the path that
 * exists precisely because the gateway already crashed once.
 *
 * The segment fixtures below are the shapes the Python lane's own tests assert
 * (`test_task959_usage_segments_compute.py::test_to_dict_carries_every_field…`
 * and `test_session_manager_usage_segments.py`), not paraphrases of them.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { SttStreamingUsagePushbackRequest } from '../dto/stt-streaming-usage.request';

const pipeCfg = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

const transform = async (body: Record<string, unknown>) =>
  new ValidationPipe(pipeCfg).transform(plainToInstance(SttStreamingUsagePushbackRequest, body), {
    type: 'body',
    metatype: SttStreamingUsagePushbackRequest,
  } as never);

const summary = (overrides: Record<string, unknown> = {}) => ({
  session_id: 's-1',
  tenant_id: 't-1',
  consultation_id: 'c-1',
  user_id: 'u-1',
  pipeline_id: 'p-1',
  closed_at: '2026-09-12T10:01:30',
  audio_seconds: 42.5,
  session_seconds: 90.0,
  engine: 'whisper_cpp',
  deployment: 'SELF_HOSTED',
  language_mode: 'ml-en',
  channel_count: 1,
  interrupted: false,
  ...overrides,
});

/** `UsageSegment.to_dict()` for a BYOK cloud leg — bytes measured on the wire. */
const cloudSegment = () => ({
  engine: 'sarvam',
  deployment: 'BYOK',
  audio_seconds: 20.0,
  session_seconds: 60.0,
  connection_id: 'conn-1',
  processing_seconds: 4.0,
  device: 'cpu',
  request_bytes: 4096,
  response_bytes: 512,
  byte_source: 'wire',
});

/**
 * `UsageSegment.to_dict()` for a self-hosted GPU leg. The byte keys are present
 * and NULL — "never applicable", which `to_dict` states rather than omitting,
 * and which is a different fact from a measured zero.
 */
const selfHostedSegment = () => ({
  engine: 'whisper_cpp',
  deployment: 'SELF_HOSTED',
  audio_seconds: 22.5,
  session_seconds: 30.0,
  connection_id: null,
  processing_seconds: 11.25,
  device: 'cuda',
  request_bytes: null,
  response_bytes: null,
  byte_source: null,
});

describe('SttStreamingUsageSegmentRequest — TASK-959 compute + network fields', () => {
  it('accepts the two-segment switched session the reaper actually POSTs', async () => {
    const out = (await transform(summary({ segments: [cloudSegment(), selfHostedSegment()] }))) as SttStreamingUsagePushbackRequest;

    expect(out.segments).toHaveLength(2);
    expect(out.segments?.[0]).toMatchObject({
      processing_seconds: 4.0,
      device: 'cpu',
      request_bytes: 4096,
      response_bytes: 512,
      byte_source: 'wire',
      // TASK-958's field is untouched beside them.
      connection_id: 'conn-1',
    });
    expect(out.segments?.[1]).toMatchObject({ processing_seconds: 11.25, device: 'cuda' });
  });

  it('accepts explicit NULL byte fields — `to_dict` dumps them, it does not omit them', async () => {
    const out = (await transform(summary({ segments: [selfHostedSegment()] }))) as SttStreamingUsagePushbackRequest;

    expect(out.segments?.[0].request_bytes).toBeNull();
    expect(out.segments?.[0].response_bytes).toBeNull();
    expect(out.segments?.[0].byte_source).toBeNull();
  });

  it('accepts the RECOVERED session segment — zero compute, `cpu`, nulls throughout', async () => {
    // `test_a_session_with_no_accumulator_synthesizes_one_segment_from_the_totals`:
    // a crash-restarted session has no accumulator, so it reports 0.0 seconds on
    // the default device rather than omitting the fields.
    const out = (await transform(
      summary({
        segments: [
          {
            engine: 'whisper_cpp',
            deployment: 'SELF_HOSTED',
            audio_seconds: 42.5,
            session_seconds: 90.0,
            connection_id: null,
            processing_seconds: 0.0,
            device: 'cpu',
            request_bytes: null,
            response_bytes: null,
            byte_source: null,
          },
        ],
      }),
    )) as SttStreamingUsagePushbackRequest;

    expect(out.segments?.[0].processing_seconds).toBe(0);
  });

  it.each(['cuda', 'mps', 'cpu'])('accepts device "%s" on a segment', async (device) => {
    const out = (await transform(summary({ segments: [{ ...cloudSegment(), device }] }))) as SttStreamingUsagePushbackRequest;
    expect(out.segments?.[0].device).toBe(device);
  });

  it('refuses a device outside the alphabet — a fourth spelling forks the PRICE', async () => {
    await expect(transform(summary({ segments: [{ ...cloudSegment(), device: 'gpu' }] }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a byte_source outside {wire, app}', async () => {
    await expect(transform(summary({ segments: [{ ...cloudSegment(), byte_source: 'guess' }] }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses negative compute seconds and negative byte counts', async () => {
    await expect(transform(summary({ segments: [{ ...cloudSegment(), processing_seconds: -1 }] }))).rejects.toBeInstanceOf(BadRequestException);
    await expect(transform(summary({ segments: [{ ...cloudSegment(), request_bytes: -1 }] }))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts the LEGACY segment that carries none of the five', async () => {
    const out = (await transform(
      summary({ segments: [{ engine: 'whisper_cpp', deployment: 'SELF_HOSTED', audio_seconds: 42.5, session_seconds: 90 }] }),
    )) as SttStreamingUsagePushbackRequest;

    expect(out.segments?.[0].processing_seconds).toBeUndefined();
    expect(out.segments?.[0].device).toBeUndefined();
  });

  it('still refuses an undeclared segment field — the whitelist is not loosened', async () => {
    await expect(transform(summary({ segments: [{ ...cloudSegment(), gpu_seconds: 4.0 }] }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
