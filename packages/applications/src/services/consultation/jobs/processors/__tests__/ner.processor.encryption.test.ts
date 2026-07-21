/**
 * NerProcessor — field-encryption wiring.
 *
 * The async NER pipeline persists NamedEntity rows (recognized PHI spans). This
 * verifies the processor encrypts each entity via
 * `NamedEntityRepository.encryptFieldsIntoEntity` (+ the injected SecretsService)
 * BEFORE the row is created, is best-effort during the soak (a Vault failure
 * never aborts the job), and is a no-op when no SecretsService is wired.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@arcaai/domains', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arcaai/domains')>();
  return {
    ...actual,
    NamedEntityFactory: {
      CreateNamedEntity: vi.fn((init: Record<string, unknown>) => ({ ...init })),
    },
  };
});

import { NerProcessor } from '../ner.processor';

const mockJobService = {
  notifyProgress: vi.fn(async () => undefined),
  notifyComplete: vi.fn(async () => undefined),
  notifyFailed: vi.fn(async () => undefined),
};
const mockContextItemRepository = { findById: vi.fn() };
const mockNamedEntityRepository = {
  create: vi.fn(),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};
const mockHttpService = { axiosRef: { post: vi.fn() } };
const mockConfigService = { get: vi.fn().mockReturnValue('http://nlp') };
const mockEventEmitter = { emit: vi.fn() };
// cls.run must execute the callback so `process` runs inline.
const mockCls = { run: vi.fn(async (fn: () => Promise<unknown>) => fn()), set: vi.fn() };
const mockSecretsService = {
  encrypt: vi.fn(async () => 'vault:v1:x'),
  decrypt: vi.fn(),
  getPhiTransitKeyName: () => 'hope-phi',
};

function makeProcessor(withSecrets = true): NerProcessor {
  return new NerProcessor(
    mockJobService as any,
    mockContextItemRepository as any,
    mockNamedEntityRepository as any,
    mockHttpService as any,
    mockConfigService as any,
    mockEventEmitter as any,
    mockCls as any,
    withSecrets ? (mockSecretsService as any) : undefined,
  );
}

const job = {
  id: 'job-1',
  data: { jobId: 'job-1', contextItemId: 'ctx-1', tenantId: 'tenant-1', userId: 'user-1', consultationId: 'c-1' },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mockNamedEntityRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockContextItemRepository.findById.mockResolvedValue({ id: 'ctx-1', tenantId: 'tenant-1', content: 'Patient takes aspirin' });
  mockNamedEntityRepository.create.mockResolvedValue({ id: 'ne-1', className: 'DRUG', text: 'aspirin', confidence: 0.9, startOffset: 14, endOffset: 21 });
  mockHttpService.axiosRef.post.mockResolvedValue({
    data: { entities: [{ type: 'DRUG', value: 'aspirin', confidence: 0.9, start: 14, end: 21 }] },
  });
});

describe('NerProcessor.process — encrypts NamedEntity before create (Phase 3C)', () => {
  it('encrypts each entity via encryptFieldsIntoEntity BEFORE its create', async () => {
    const processor = makeProcessor(true);
    await processor.process(job);

    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'aspirin' }),
      mockSecretsService,
    );
    const encOrder = mockNamedEntityRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockNamedEntityRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('is best-effort: a Vault failure does NOT abort the NER job', async () => {
    mockNamedEntityRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const processor = makeProcessor(true);
    const result = await processor.process(job);

    expect(result.namedEntities).toHaveLength(1);
    expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
    expect(mockJobService.notifyComplete).toHaveBeenCalledTimes(1);
  });

  it('skips encryption entirely when no SecretsService is wired', async () => {
    const processor = makeProcessor(false);
    await processor.process(job);

    expect(mockNamedEntityRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockNamedEntityRepository.create).toHaveBeenCalledTimes(1);
  });
});
