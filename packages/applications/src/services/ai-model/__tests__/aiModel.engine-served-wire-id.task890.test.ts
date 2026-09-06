/**
 * TASK-890 §3.1 — the ENGINE-SERVED half of the conditional `wireModelId` rule.
 *
 * `wireModelId` is the ROUTED id since the §3.1 repoint, so a row that cannot
 * produce one cannot be invoked. `AiModelEntity.validate()` enforces that for
 * `deploymentKind = CLOUD` — it is DB-agnostic and must not restate which
 * providers are engine-served — and the SERVICE enforces the other half here:
 * a self-hosted row served by an engine that hosts its own model store
 * (LM Studio, Ollama, vLLM, llama.cpp) puts a model id on the wire exactly like
 * a cloud row does, so it needs one too.
 *
 * A `built-in` / bucket-loaded row is deliberately NOT covered: those weights
 * are loaded from a path, nothing goes on a wire, and requiring an id there
 * would refuse 23 of the 33 seeded rows.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AiDeploymentKind, AiModelFormat, AiModelSource, ModelCategory, ModelTaskType, ModelType, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { AiModelService } from '../aiModel.service';
import type { CreateModelRequest } from '../dto';

const BASE_CLIENT = { $lane: 'unscoped' };

function makeCls(user: Record<string, unknown> = { id: 'u1', roles: ['SUPER_ADMIN'], isSuperAdmin: true }) {
  return { get: vi.fn((k: string) => (k === 'user' ? user : k === 'tenantId' ? SYSTEM_TENANT_ID : undefined)) };
}

function makeService() {
  const repo = {
    findById: vi.fn(),
    findBySlug: vi.fn().mockResolvedValue(null),
    create: vi.fn(async (entity: unknown) => entity),
    update: vi.fn(async (_id: string, entity: unknown) => entity),
    updateWithVersion: vi.fn(async (_id: string, entity: unknown) => entity),
  };
  const service = new AiModelService(repo as never, { baseClient: BASE_CLIENT } as never, { emit: vi.fn() } as never, makeCls() as never);
  return { service, repo };
}

const ENGINE_ROW: CreateModelRequest = {
  name: 'Gemma 4 E2B IT QAT',
  slug: 'lms-gemma-4-e2b-it-qat',
  category: ModelCategory.NLP,
  taskType: ModelTaskType.TEXT_GENERATION,
  modelType: ModelType.QUANTIZED_MODEL,
  source: AiModelSource.HUGGINGFACE,
  sourceUri: 'google/gemma-4-e2b-it-qat-GGUF',
  format: AiModelFormat.GGUF,
  libraryName: 'llama.cpp',
  servedBy: 'lmstudio',
  deploymentKind: AiDeploymentKind.SELF_HOSTED,
  provider: 'lm-studio',
};

beforeEach(() => vi.clearAllMocks());

describe('the engine-served wireModelId rule', () => {
  it('refuses an engine-served row with no wireModelId, naming the field', async () => {
    const { service, repo } = makeService();
    const error = await service.create(ENGINE_ROW).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toContain('wireModelId');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('accepts it once the wire id is declared', async () => {
    const { service } = makeService();
    const result = await service.create({ ...ENGINE_ROW, wireModelId: 'gemma-4-e2b-it-qat' });
    expect(result.wireModelId).toBe('gemma-4-e2b-it-qat');
  });

  it('leaves a bucket-loaded (`built-in`) self-hosted row alone — nothing goes on a wire for it', async () => {
    const { service } = makeService();
    const result = await service.create({ ...ENGINE_ROW, slug: 'built-in-row', provider: 'built-in', servedBy: 'nlp', libraryName: 'transformers' });
    expect(result.slug).toBe('built-in-row');
  });

  it('refuses an UPDATE that would leave an engine-served row without its wire id', async () => {
    const { service, repo } = makeService();
    repo.findById.mockResolvedValue({
      id: 'row-1',
      tenantId: SYSTEM_TENANT_ID,
      slug: 'lms-gemma',
      provider: 'lm-studio',
      wireModelId: 'gemma-4-e2b-it-qat',
      deploymentKind: AiDeploymentKind.SELF_HOSTED,
    });
    const error = await service.update('row-1', { wireModelId: '', expectedVersion: 3 } as any).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });
});
