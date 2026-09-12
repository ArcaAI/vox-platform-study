/**
 * TASK-959 §3.2/§4.2 — `PATCH /api/v1/internal/stt/jobs/:id/complete` must accept
 * the compute and network fields the batch worker now sends.
 *
 * `APIGatewayClient.complete_job` (branch `task-959/stt`) adds four TYPED,
 * top-level siblings beside the TASK-874/958 ones: `device`, `requestBytes`,
 * `responseBytes`, `byteSource`. They are top-level rather than nested in
 * `resultMetadata` for the same reason `durationSeconds` is — that blob is
 * encrypted into ciphertext on the completing persist, so anything trapped only
 * inside it is unqueryable afterwards.
 *
 * The global pipe runs `forbidNonWhitelisted`. Undeclared, ANY ONE of these four
 * 400s the whole completion callback and loses the transcript — which is why the
 * payloads below are copied verbatim from the Python lane's own tests
 * (`apps/stt/tests/unit/test_task959_batch_metering.py`) rather than paraphrased.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it } from 'vitest';

import { InternalCompleteJobRequest } from '../dto/internal.request';

const pipeCfg = { transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true } as const;

const transform = async (body: Record<string, unknown>) =>
  new ValidationPipe(pipeCfg).transform(plainToInstance(InternalCompleteJobRequest, body), {
    type: 'body',
    metatype: InternalCompleteJobRequest,
  } as never);

/**
 * A self-hosted GPU completion, exactly as `complete_job` builds it: compute is
 * present, the byte keys are ABSENT (never `null`) because no third-party call
 * was made — "no such call" and "a call that moved no bytes" are different facts.
 */
const selfHostedGpuCompletion = () => ({
  resultText: 'the patient reports intermittent chest pain',
  resultMetadata: { confidence: 0.95, duration_seconds: 42.5 },
  durationSeconds: 42.5,
  processingTimeSeconds: 12.5,
  engine: 'faster_whisper',
  deployment: 'SELF_HOSTED',
  device: 'cuda',
});

/** A BYOK cloud REST completion — compute on this service's CPU, plus wire bytes. */
const byokCloudCompletion = () => ({
  resultText: 'the patient reports intermittent chest pain',
  durationSeconds: 42.5,
  processingTimeSeconds: 3.0,
  engine: 'sarvam',
  deployment: 'BYOK',
  connectionId: 'conn-1',
  device: 'cpu',
  requestBytes: 4096,
  responseBytes: 512,
  byteSource: 'wire',
});

describe('InternalCompleteJobRequest — TASK-959 compute + network fields', () => {
  it('accepts the self-hosted GPU completion the worker actually sends', async () => {
    const out = (await transform(selfHostedGpuCompletion())) as InternalCompleteJobRequest;

    expect(out.device).toBe('cuda');
    expect(out.processingTimeSeconds).toBe(12.5);
    expect(out.requestBytes).toBeUndefined();
    expect(out.responseBytes).toBeUndefined();
    expect(out.byteSource).toBeUndefined();
  });

  it('accepts the BYOK cloud completion with wire bytes, beside TASK-958 `connectionId`', async () => {
    const out = (await transform(byokCloudCompletion())) as InternalCompleteJobRequest;

    expect(out.device).toBe('cpu');
    expect(out.requestBytes).toBe(4096);
    expect(out.responseBytes).toBe(512);
    expect(out.byteSource).toBe('wire');
    expect(out.connectionId).toBe('conn-1');
  });

  it('accepts a measured ZERO byte count — `0` is a real measurement and IS sent', async () => {
    // `test_zero_bytes_is_a_real_measurement_and_is_sent` on the Python side. A
    // `@Min(1)` here would reject a payload the worker legitimately produces.
    const out = (await transform(
      byokCloudCompletion() && { ...byokCloudCompletion(), requestBytes: 0, responseBytes: 0 },
    )) as InternalCompleteJobRequest;

    expect(out.requestBytes).toBe(0);
    expect(out.responseBytes).toBe(0);
  });

  it.each(['cuda', 'mps', 'cpu'])('accepts device "%s" — the ledger\'s whole device alphabet', async (device) => {
    const out = (await transform({ ...selfHostedGpuCompletion(), device })) as InternalCompleteJobRequest;
    expect(out.device).toBe(device);
  });

  it('refuses a device outside the alphabet — a fourth spelling would fork the PRICE, not a facet', async () => {
    // `normalize_device` guarantees the three values; anything else reaching here
    // is a caller that bypassed it, and `cuda`/`cpu` are an order of magnitude
    // apart in cost. Rejecting is the safe direction: the ledger's own
    // `COMPUTE_DEVICES` check would reject it downstream anyway, but AFTER the
    // transcript had been persisted and the usage silently dropped.
    await expect(transform({ ...selfHostedGpuCompletion(), device: 'gpu' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a byteSource outside {wire, app}', async () => {
    await expect(transform({ ...byokCloudCompletion(), byteSource: 'guess' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a negative byte count', async () => {
    await expect(transform({ ...byokCloudCompletion(), requestBytes: -1 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still accepts the LEGACY completion that carries none of them', async () => {
    const out = (await transform({
      resultText: 'x',
      durationSeconds: 42.5,
      processingTimeSeconds: 12.8,
      engine: 'whisper_cpp',
      deployment: 'SELF_HOSTED',
    })) as InternalCompleteJobRequest;

    expect(out.device).toBeUndefined();
    expect(out.engine).toBe('whisper_cpp');
  });

  it('still refuses an undeclared field — the whitelist is not loosened', async () => {
    await expect(transform({ ...selfHostedGpuCompletion(), gpuSeconds: 12.5 })).rejects.toBeInstanceOf(BadRequestException);
  });
});
