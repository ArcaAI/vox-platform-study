/**
 * TASK-958 D-7 — `PATCH /api/v1/internal/stt/jobs/:id/complete` must accept
 * `connectionId`.
 *
 * The batch worker sends it as a TYPED, top-level sibling (`gateway.py::complete_job`
 * adds `payload["connectionId"]`) because `resultMetadata` is encrypted into
 * ciphertext on the completing persist, so anything trapped only inside it is
 * unqueryable afterwards. The global pipe runs `forbidNonWhitelisted`: undeclared,
 * this field would 400 the whole completion callback and lose the transcript.
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

const completion = (over: Record<string, unknown> = {}) => ({
  resultText: 'the patient reports intermittent chest pain',
  durationSeconds: 42.5,
  processingTimeSeconds: 12.8,
  engine: 'azure-speech',
  deployment: 'BYOK',
  ...over,
});

describe('InternalCompleteJobRequest — TASK-958 connection attribution', () => {
  it('accepts `connectionId`', async () => {
    const out = (await transform(completion({ connectionId: 'conn-azure-research' }))) as InternalCompleteJobRequest;
    expect(out.connectionId).toBe('conn-azure-research');
  });

  it('still accepts the LEGACY completion that names none', async () => {
    const out = (await transform(completion())) as InternalCompleteJobRequest;
    expect(out.connectionId).toBeUndefined();
    expect(out.engine).toBe('azure-speech');
  });

  it('still refuses an undeclared field — the whitelist is not loosened', async () => {
    await expect(transform(completion({ connectionApiKey: 'sk-live-oops' }))).rejects.toBeInstanceOf(BadRequestException);
  });
});
