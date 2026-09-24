import 'reflect-metadata';
import { BadRequestException, HttpStatus, ValidationPipe } from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { LoadLmStudioModelRequest, LoadLmStudioModelResponse } from '@arcaai/applications';
import { InferenceEnginesController } from '../inference-engines.controller';

/**
 * TASK-1005 — `POST admin/inference-engines/lm-studio/models/:modelKey/load`
 * stops answering 501 and dispatches over LM Studio REST v1.
 *
 * The request body is validated by the SAME pipe `main.ts` installs
 * (`whitelist + forbidNonWhitelisted + forbidUnknownValues`), because that pipe
 * is what keeps the engine's strict schema safe: a key LM Studio would 400 on
 * (`ttl`, `identifier`, `gpu`) — or the retired free-form `profile` — must be
 * refused at the gateway, not forwarded.
 */

/** `DECORATORS.API_RESPONSE` in `@nestjs/swagger` — its constants module is not an exported subpath. */
const API_RESPONSE_METADATA = 'swagger/apiResponse';

const GLOBAL_PIPE = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

function validateBody(body: unknown): Promise<unknown> {
  return GLOBAL_PIPE.transform(body, { type: 'body', metatype: LoadLmStudioModelRequest });
}

describe('InferenceEnginesController.load (TASK-1005)', () => {
  const MODEL_KEY = 'gemma-4-e4b-it-qat@q4_0';
  const RESULT = {
    outcome: 'loaded',
    model: {
      modelRef: MODEL_KEY,
      aiModelId: 'model-1',
      cache: 'llm',
      state: 'loaded',
      device: 'multi',
      bytes: null,
      bytesSource: 'unknown',
      inFlight: null,
      pinned: false,
      adminPinned: false,
      ttlSeconds: null,
      loadedAt: null,
      lastUsedAt: null,
      loadSeconds: 98.4,
      instanceId: MODEL_KEY,
      loadConfig: { contextLength: 4096, parallel: 4, flashAttention: true },
    },
  };

  it('delegates to the service and answers `{outcome, model}` verbatim', async () => {
    const service = { runtime: vi.fn(), load: vi.fn().mockResolvedValue(RESULT), unload: vi.fn() };
    const controller = new InferenceEnginesController(service as never);
    const body = { contextLength: 4096, flashAttention: true };

    await expect(controller.load(MODEL_KEY, body)).resolves.toEqual(RESULT);
    expect(service.load).toHaveBeenCalledWith(MODEL_KEY, body);
  });

  it('answers 200 — the load has COMPLETED when the response is sent, so it is not a 202', () => {
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, InferenceEnginesController.prototype.load)).toBe(HttpStatus.OK);
  });

  it('documents the real outcomes and no longer advertises a 501', () => {
    const responses = Reflect.getMetadata(API_RESPONSE_METADATA, InferenceEnginesController.prototype.load) as Record<string, { type?: unknown }>;
    expect(Object.keys(responses)).not.toContain('501');
    expect(responses['200']?.type).toBe(LoadLmStudioModelResponse);
    for (const status of ['400', '403', '404', '409', '502', '503']) expect(Object.keys(responses), status).toContain(status);
  });

  describe('request body — the documented REST v1 options, and nothing else', () => {
    it('accepts every documented option plus `force`', async () => {
      const body = { contextLength: 4096, evalBatchSize: 256, flashAttention: true, numExperts: 4, offloadKvCacheToGpu: false, force: true };
      await expect(validateBody(body)).resolves.toMatchObject(body);
    });

    it('accepts an empty body — every option resolves from the model row or the platform default', async () => {
      await expect(validateBody({})).resolves.toBeInstanceOf(LoadLmStudioModelRequest);
    });

    for (const [what, body] of [
      ['ttl', { ttl: 120 }],
      ['identifier', { identifier: 'probe-x' }],
      ['gpu', { gpu: { ratio: 1 } }],
      ['the retired free-form profile', { profile: { contextLength: 4096 } }],
      ['snake_case context_length', { context_length: 4096 }],
    ] as const) {
      it(`refuses ${what} (400) — LM Studio's strict schema would 400 on it, so it never leaves the gateway`, async () => {
        await expect(validateBody(body)).rejects.toBeInstanceOf(BadRequestException);
      });
    }

    for (const [what, body] of [
      ['a fractional context window', { contextLength: 4096.5 }],
      ['a context window below 512', { contextLength: 256 }],
      ['a zero batch size', { evalBatchSize: 0 }],
      ['a non-boolean flash attention', { flashAttention: 'yes' }],
    ] as const) {
      it(`refuses ${what}`, async () => {
        await expect(validateBody(body)).rejects.toBeInstanceOf(BadRequestException);
      });
    }
  });
});
