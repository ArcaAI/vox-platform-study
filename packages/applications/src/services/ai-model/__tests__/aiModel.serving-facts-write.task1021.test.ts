/**
 * TASK-1021 final review F4 — the admin WRITE path for the engine sizing facts on
 * `AiModel._metadata.serving` (D-11).
 *
 * Without it a row that lacks the facts (the live dev Whisper row) answers 409
 * `SERVING_FACTS_MISSING` on the internal serving-spec route forever: the seed writes them, but
 * nothing an operator can reach could. `PATCH admin/ai-models/:id` now takes an optional nested
 * `serving` — strict at the DTO boundary (400 naming the field), MERGED into `_metadata.serving`
 * (sibling `_metadata` keys and unspecified serving keys survive), and written through the SAME
 * platform-admin + OCC path every other field of the route takes.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { BadRequestException, ForbiddenException, ValidationPipe } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import { UpdateModelRequest } from '../dto';
import { buildResolvedServingSpec } from '../serving-spec/build-resolved-serving-spec';

/** The gateway's global pipe options (`apps/api` `createGlobalValidationPipe`). */
const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });

async function parse(body: Record<string, unknown>): Promise<UpdateModelRequest> {
  return pipe.transform(body, { type: 'body', metatype: UpdateModelRequest });
}

async function refusal(body: Record<string, unknown>): Promise<string> {
  const error = await parse(body).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return JSON.stringify((error as BadRequestException).getResponse());
}

describe('UpdateModelRequest.serving — strict at the boundary (F4)', () => {
  it('accepts vramGiB alone, and with maxNumSeqs + enforceEager', async () => {
    await expect(parse({ serving: { vramGiB: 5 }, expectedVersion: 3 })).resolves.toBeInstanceOf(UpdateModelRequest);
    const dto = await parse({ serving: { vramGiB: 5.5, maxNumSeqs: 64, enforceEager: true }, expectedVersion: 3 });
    expect(dto.serving).toEqual({ vramGiB: 5.5, maxNumSeqs: 64, enforceEager: true });
  });

  it.each([
    ['a zero vramGiB', { vramGiB: 0 }],
    ['a negative vramGiB', { vramGiB: -1 }],
    ['a string vramGiB', { vramGiB: '5' }],
    ['a missing vramGiB', { maxNumSeqs: 64 }],
  ])('rejects %s with 400 naming vramGiB', async (_label, serving) => {
    expect(await refusal({ serving, expectedVersion: 3 })).toContain('vramGiB');
  });

  it.each([
    ['maxNumSeqs', { vramGiB: 5, maxNumSeqs: 0 }],
    ['maxNumSeqs', { vramGiB: 5, maxNumSeqs: 1.5 }],
    ['enforceEager', { vramGiB: 5, enforceEager: 'yes' }],
  ])('rejects an invalid %s with 400 naming it', async (field, serving) => {
    expect(await refusal({ serving, expectedVersion: 3 })).toContain(field);
  });

  it('rejects an unknown nested field (strict whitelist) — the retired engine knobs cannot ride in', async () => {
    expect(await refusal({ serving: { vramGiB: 5, gpuMemoryUtilization: 0.2 }, expectedVersion: 3 })).toContain('gpuMemoryUtilization');
  });

  it('rejects serving: null and a non-object serving', async () => {
    expect(await refusal({ serving: null, expectedVersion: 3 })).toContain('serving');
    expect(await refusal({ serving: 5, expectedVersion: 3 })).toContain('serving');
  });
});

// ---------------------------------------------------------------------------
// Service write path — merge, OCC and the platform-admin gate unchanged.
// ---------------------------------------------------------------------------

const BASE_CLIENT = { $lane: 'unscoped' };
const SUPER_ADMIN = { id: 'u1', roles: ['SUPER_ADMIN'], isSuperAdmin: true };

function makeService(user: Record<string, unknown> = SUPER_ADMIN) {
  const cls = { get: (k: string) => (k === 'user' ? user : k === 'tenantId' ? null : undefined) };
  const calls: { id: string; expectedVersion: number }[] = [];
  const repo = {
    findById: async (_id: string) => null as any,
    findBySlug: async (..._args: unknown[]) => null,
    updateWithVersion: async (id: string, entity: unknown, expectedVersion: number) => {
      calls.push({ id, expectedVersion });
      return entity;
    },
  };
  const service = new AiModelService(repo as never, { baseClient: BASE_CLIENT } as never, { emit: () => undefined } as never, cls as never);
  return { service, repo, calls };
}

/**
 * The Whisper row served by `vllm`. The LIVE dev row was seeded before the serving facts AND before
 * the seed named a `wireModelId` (pass `wireModelId: null` for that shape).
 */
function liveWhisperRow(metaData: Record<string, unknown> | undefined, wireModelId: string | null = 'arcaai-whisper-large-ml-en-vllm') {
  return {
    id: '00000000-0000-0000-0001-000000000026',
    tenantId: SYSTEM_TENANT_ID,
    version: 4,
    slug: 'arcaai-whisper-large-ml-en-vllm',
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'vllm',
    servedBy: 'vllm',
    provider: 'vllm',
    wireModelId,
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    computeType: 'float16',
    sourceUri: 'hf:arcaai/whisper-large-ml-en',
    bucketPrefix: 'arcaai-whisper-large-ml-en-vllm/fp16-abc',
    primaryObject: null,
    resourceStatus: 'ENABLED',
    metaData,
    validate() {},
  };
}

describe('AiModelService.update — serving facts (F4)', () => {
  it('writes vramGiB into _metadata.serving, after which the serving-spec builder resolves the row', async () => {
    const { service, repo, calls } = makeService();
    const row = liveWhisperRow({ asr: { maxModelLen: 448 } }, null); // the live dev shape
    (repo as any).findById = async () => row;
    expect(buildResolvedServingSpec(row as any)).toEqual({ ok: false, reason: 'SERVING_FACTS_MISSING' });

    // The live row also lacks a wireModelId (an ENGINE_SERVED provider needs one), so the operator's
    // PATCH names both in one write.
    await service.update(
      row.id,
      await parse({ serving: { vramGiB: 5, maxNumSeqs: 64 }, wireModelId: 'arcaai-whisper-large-ml-en-vllm', expectedVersion: 4 }),
    );

    expect(row.metaData).toEqual({ asr: { maxModelLen: 448 }, serving: { vramGiB: 5, maxNumSeqs: 64 } });
    const built = buildResolvedServingSpec(row as any);
    expect(built.ok).toBe(true);
    expect(built.ok && built.spec.engine).toMatchObject({ vramGiB: 5, maxNumSeqs: 64 });
    expect(calls).toEqual([{ id: row.id, expectedVersion: 4 }]); // the OCC CAS, as for every field
  });

  it('on the live row, serving alone is refused 400 for the missing wireModelId (the engine-served rule, unchanged)', async () => {
    const { service, repo, calls } = makeService();
    const row = liveWhisperRow(undefined, null);
    (repo as any).findById = async () => row;

    const error = await service.update(row.id, await parse({ serving: { vramGiB: 5 }, expectedVersion: 4 })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('wireModelId');
    expect(calls).toHaveLength(0);
  });

  it('merges: a serving key the PATCH omits survives, and sibling _metadata keys are untouched', async () => {
    const { service, repo } = makeService();
    const row = liveWhisperRow({ capabilities: { x: 1 }, serving: { vramGiB: 5, maxNumSeqs: 64, enforceEager: true } });
    (repo as any).findById = async () => row;

    await service.update(row.id, await parse({ serving: { vramGiB: 6 }, expectedVersion: 4 }));

    expect(row.metaData).toEqual({ capabilities: { x: 1 }, serving: { vramGiB: 6, maxNumSeqs: 64, enforceEager: true } });
  });

  it('leaves _metadata.serving untouched when the PATCH carries no serving', async () => {
    const { service, repo } = makeService();
    const row = liveWhisperRow({ serving: { vramGiB: 5 } });
    (repo as any).findById = async () => row;

    await service.update(row.id, await parse({ name: 'renamed', expectedVersion: 4 }));

    expect(row.metaData).toEqual({ serving: { vramGiB: 5 } });
  });

  it('keeps the platform-admin gate: a tenant admin gets 403 and nothing is written', async () => {
    const { service, repo, calls } = makeService({ id: 'u2', roles: ['TENANT_ADMIN'], isSuperAdmin: false });
    const row = liveWhisperRow(undefined);
    (repo as any).findById = async () => row;

    const error = await service.update(row.id, await parse({ serving: { vramGiB: 5 }, expectedVersion: 4 })).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(row.metaData).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
