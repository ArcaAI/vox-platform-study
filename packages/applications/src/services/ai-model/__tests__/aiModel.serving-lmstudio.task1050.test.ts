/**
 * TASK-1050 W2h (README §11.3 D, OD-37) — the LM Studio per-model serving fields become WRITABLE on the AiModel
 * `serving` DTO: `contextLength`, `parallel`, `flashAttention`, `kvCacheQuant { k, v }`, `gpuSplit { strategy,
 * priority, disabledGpus }`. They already exist in seed `_metadata.serving`; `/ai-models` is their one editor.
 *
 * Strict at the boundary (class-validator bounds from `@arcaai/types`), merged into `_metadata.serving` with
 * every other key kept, and written through the unchanged platform-admin + If-Match path. A body carrying
 * only LM Studio fields does not have to restate the vLLM `vramGiB`; a vLLM body still does (TASK-1021).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it } from 'vitest';
import { AiModelService } from '../aiModel.service';
import { UpdateModelRequest } from '../dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
const parse = (body: Record<string, unknown>): Promise<UpdateModelRequest> => pipe.transform(body, { type: 'body', metatype: UpdateModelRequest });

async function refusal(body: Record<string, unknown>): Promise<string> {
  const error = await parse(body).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return JSON.stringify((error as BadRequestException).getResponse());
}

const GRANITE_SERVING = {
  contextLength: 16384,
  parallel: 10,
  flashAttention: true,
  gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] },
  kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
};

describe('UpdateModelRequest.serving — LM Studio fields', () => {
  it('accepts the seed granite profile as a body, with no vramGiB', async () => {
    const dto = await parse({ serving: GRANITE_SERVING, expectedVersion: 3 });
    expect(JSON.parse(JSON.stringify(dto.serving))).toEqual(GRANITE_SERVING);
  });

  it('accepts a single LM Studio field', async () => {
    await expect(parse({ serving: { parallel: 4 }, expectedVersion: 3 })).resolves.toBeInstanceOf(UpdateModelRequest);
  });

  it('still requires vramGiB on a vLLM-only body (TASK-1021 unchanged)', async () => {
    expect(await refusal({ serving: { maxNumSeqs: 64 }, expectedVersion: 3 })).toContain('vramGiB');
  });

  it.each([
    ['contextLength below the engine floor', { contextLength: 256 }, 'contextLength'],
    ['contextLength not whole', { contextLength: 4096.5 }, 'contextLength'],
    ['contextLength above the cap', { contextLength: 2_000_000 }, 'contextLength'],
    ['parallel 0', { parallel: 0 }, 'parallel'],
    ['parallel above 64', { parallel: 65 }, 'parallel'],
    ['flashAttention not boolean', { flashAttention: 'yes' }, 'flashAttention'],
    ['an unknown kv-cache type', { kvCacheQuant: { k: 'q3_k', v: 'f16' } }, 'k'],
    ['an unknown kvCacheQuant member', { kvCacheQuant: { k: 'f16', x: 'f16' } }, 'x'],
    ['an unknown split strategy', { gpuSplit: { strategy: 'round-robin' } }, 'strategy'],
    ['a negative device index', { gpuSplit: { priority: [-1] } }, 'priority'],
    ['a fractional device index', { gpuSplit: { disabledGpus: [0.5] } }, 'disabledGpus'],
    ['duplicate device indices', { gpuSplit: { priority: [0, 0] } }, 'priority'],
    ['an unknown gpuSplit member', { gpuSplit: { strategy: 'evenly', ratio: [1] } }, 'ratio'],
  ])('refuses %s with 400 naming the field', async (_label, serving, field) => {
    expect(await refusal({ serving, expectedVersion: 3 })).toContain(field);
  });
});

const SUPER_ADMIN = { id: 'u1', roles: ['SUPER_ADMIN'], isSuperAdmin: true };

function graniteRow(metaData: Record<string, unknown>) {
  return {
    id: 'model-granite',
    tenantId: SYSTEM_TENANT_ID,
    version: 4,
    slug: 'granite-guardian-4.1-8b',
    taskType: ModelTaskType.GUARDRAIL,
    format: AiModelFormat.GGUF,
    libraryName: 'llama.cpp',
    servedBy: 'lm-studio',
    provider: 'lm-studio',
    wireModelId: 'granite-guardian-4.1-8b',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    computeType: null,
    sourceUri: 'hf:mradermacher/granite-guardian-4.1-8b-GGUF',
    bucketPrefix: 'granite-guardian-4.1-8b/q4',
    primaryObject: null,
    resourceStatus: 'ENABLED',
    metaData,
    validate() {},
  };
}

function makeService(row: ReturnType<typeof graniteRow>) {
  const cls = { get: (k: string) => (k === 'user' ? SUPER_ADMIN : k === 'tenantId' ? null : undefined) };
  const calls: number[] = [];
  const repo = {
    findById: async () => row,
    findBySlug: async () => null,
    updateWithVersion: async (_id: string, entity: unknown, expectedVersion: number) => {
      calls.push(expectedVersion);
      return entity;
    },
  };
  const service = new AiModelService(repo as never, { baseClient: {} } as never, { emit: () => undefined } as never, cls as never);
  return { service, calls };
}

describe('AiModelService.update — LM Studio serving fields map into _metadata.serving', () => {
  it('merges the written fields, keeps the rest of serving and every other _metadata key, under the same If-Match', async () => {
    const row = graniteRow({ serving: GRANITE_SERVING, policy: { judgeTemperature: 0.05 } });
    const { service, calls } = makeService(row);
    await service.update(row.id, await parse({ serving: { parallel: 6, kvCacheQuant: { k: 'q4_0', v: 'q4_0' } }, expectedVersion: 4 }));
    expect(row.metaData).toEqual({
      serving: { ...GRANITE_SERVING, parallel: 6, kvCacheQuant: { k: 'q4_0', v: 'q4_0' } },
      policy: { judgeTemperature: 0.05 },
    });
    expect(calls).toEqual([4]);
  });

  it('a nested block replaces that block whole (no half-merged split)', async () => {
    const row = graniteRow({ serving: GRANITE_SERVING });
    const { service } = makeService(row);
    await service.update(row.id, await parse({ serving: { gpuSplit: { strategy: 'evenly' } }, expectedVersion: 4 }));
    expect((row.metaData as any).serving.gpuSplit).toEqual({ strategy: 'evenly' });
  });

  it('an LM Studio-only write keeps a derived vramGiB estimate flagged as derived', async () => {
    const row = graniteRow({ serving: { vramGiB: 6, derived: true } });
    const { service } = makeService(row);
    await service.update(row.id, await parse({ serving: { contextLength: 8192 }, expectedVersion: 4 }));
    expect((row.metaData as any).serving).toEqual({ vramGiB: 6, derived: true, contextLength: 8192 });
  });
});
