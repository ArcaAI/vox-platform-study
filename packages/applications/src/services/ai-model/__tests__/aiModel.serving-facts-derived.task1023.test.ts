/**
 * Registration writes `_metadata.serving = { vramGiB, derived: true }` as an ESTIMATE. An admin's
 * `PATCH :id { serving }` states a real value, so the estimate flag must not survive it. The
 * platform `ModelResponse` exposes the facts (with the flag) so the Serving tab can show which.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { ValidationPipe } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, ModelTaskType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import { AiModelDtoMapper } from '../aiModel.dto.mapper';
import { UpdateModelRequest } from '../dto';

const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
const parse = (body: Record<string, unknown>): Promise<UpdateModelRequest> => pipe.transform(body, { type: 'body', metatype: UpdateModelRequest });

function vllmRow(metaData: Record<string, unknown> | undefined) {
  return {
    id: 'm-vllm',
    tenantId: SYSTEM_TENANT_ID,
    version: 2,
    slug: 'whisper-vllm',
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'vllm',
    servedBy: 'vllm',
    provider: 'vllm',
    wireModelId: 'whisper-vllm',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    resourceStatus: 'ENABLED',
    languages: [],
    isPlatformDefaultFor: [],
    tags: [],
    metaData,
    validate() {},
  };
}

function makeService(row: ReturnType<typeof vllmRow>) {
  const cls = { get: (k: string) => (k === 'user' ? { id: 'u1', roles: ['SUPER_ADMIN'] } : k === 'tenantId' ? null : undefined) };
  const repo = {
    findById: async () => row,
    findBySlug: async () => null,
    updateWithVersion: async (_id: string, entity: unknown) => entity,
  };
  return new AiModelService(repo as never, { baseClient: {} } as never, { emit: () => undefined } as never, cls as never);
}

describe('serving PATCH drops the registration estimate flag', () => {
  it('an admin-set vramGiB replaces the derived estimate; `derived` does not survive', async () => {
    const row = vllmRow({ serving: { vramGiB: 4, derived: true }, asr: { maxModelLen: 448 } });
    await makeService(row).update(row.id, await parse({ serving: { vramGiB: 6, maxNumSeqs: 32 }, expectedVersion: 2 }));
    expect(row.metaData).toEqual({ serving: { vramGiB: 6, maxNumSeqs: 32 }, asr: { maxModelLen: 448 } });
  });

  it('keeps the other stored serving keys the PATCH did not name', async () => {
    const row = vllmRow({ serving: { vramGiB: 4, derived: true, enforceEager: true } });
    await makeService(row).update(row.id, await parse({ serving: { vramGiB: 5 }, expectedVersion: 2 }));
    expect(row.metaData).toEqual({ serving: { vramGiB: 5, enforceEager: true } });
  });
});

describe('ModelResponse.servingFacts', () => {
  it('exposes the stored facts with the estimate flag', () => {
    const response = AiModelDtoMapper.toResponse(vllmRow({ serving: { vramGiB: 4, derived: true } }) as any);
    expect(response.servingFacts).toEqual({ vramGiB: 4, maxNumSeqs: null, enforceEager: null, derived: true });
  });

  it('an admin-set row reports derived false', () => {
    const response = AiModelDtoMapper.toResponse(vllmRow({ serving: { vramGiB: 6, maxNumSeqs: 32, enforceEager: false } }) as any);
    expect(response.servingFacts).toEqual({ vramGiB: 6, maxNumSeqs: 32, enforceEager: false, derived: false });
  });

  it('null when the row carries no usable facts', () => {
    expect(AiModelDtoMapper.toResponse(vllmRow(undefined) as any).servingFacts).toBeNull();
    expect(AiModelDtoMapper.toResponse(vllmRow({ serving: { vramGiB: 'x' } }) as any).servingFacts).toBeNull();
  });
});
