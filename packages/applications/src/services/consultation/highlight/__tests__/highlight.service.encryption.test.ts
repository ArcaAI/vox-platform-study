/**
 * HighlightService — TASK-369 Phase 3C field-encryption wiring.
 *
 * Verifies the service dual-writes encrypted highlight fields (exact / prefix /
 * suffix / note via `HighlightRepository.encryptFieldsIntoEntity` + the injected
 * SecretsService) before the create persist, is best-effort during the soak
 * (never throws into the write path), and never exposes ciphertext columns in
 * the response DTO.
 */
import { HighlightFactory, HighlightTargetKind } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HighlightService } from '../highlight.service';

const TENANT = 'tenant-1';
const CONSULTATION = 'consultation-1';

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };
const mockHighlightRepository = {
  create: vi.fn(),
  findById: vi.fn(),
  findByConsultation: vi.fn(),
  softDelete: vi.fn(),
  encryptFieldsIntoEntity: vi.fn(async () => undefined),
};
const mockConsultationRepository = { findById: vi.fn() };
const mockSecretsService = {
  encrypt: vi.fn(async () => 'vault:v1:x'),
  decrypt: vi.fn(),
  getPhiTransitKeyName: () => 'hope-phi',
};

function buildService(withSecrets = true): HighlightService {
  return new HighlightService(
    mockHighlightRepository as never,
    mockConsultationRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    withSecrets ? (mockSecretsService as never) : undefined,
  );
}

const requestWithNote = {
  targetKind: HighlightTargetKind.TRANSCRIPT,
  exact: 'severe chest pain',
  startOffset: 10,
  endOffset: 27,
  note: 'follow up on cardiac history',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockHighlightRepository.encryptFieldsIntoEntity.mockResolvedValue(undefined);
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return TENANT;
    if (key === 'user') return { id: 'user-1' };
    return undefined;
  });
});

describe('createHighlight — encrypts fields before create (Phase 3C)', () => {
  it('calls encryptFieldsIntoEntity with the entity + SecretsService BEFORE create', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
    mockHighlightRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(true);
    await service.createHighlight(CONSULTATION, requestWithNote);

    expect(mockHighlightRepository.encryptFieldsIntoEntity).toHaveBeenCalledTimes(1);
    expect(mockHighlightRepository.encryptFieldsIntoEntity).toHaveBeenCalledWith(
      expect.objectContaining({ exact: 'severe chest pain' }),
      mockSecretsService,
    );
    const encOrder = mockHighlightRepository.encryptFieldsIntoEntity.mock.invocationCallOrder[0];
    const createOrder = mockHighlightRepository.create.mock.invocationCallOrder[0];
    expect(encOrder).toBeLessThan(createOrder);
  });

  it('is best-effort: a SecretsService failure does NOT break the write (soak)', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
    mockHighlightRepository.create.mockImplementation((e) => Promise.resolve(e));
    mockHighlightRepository.encryptFieldsIntoEntity.mockRejectedValueOnce(new Error('vault down'));

    const service = buildService(true);
    const res = await service.createHighlight(CONSULTATION, requestWithNote);

    expect(res.exact).toBe('severe chest pain');
    expect(mockHighlightRepository.create).toHaveBeenCalledTimes(1);
  });

  it('skips encryption entirely when no SecretsService is wired', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
    mockHighlightRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(false);
    await service.createHighlight(CONSULTATION, requestWithNote);

    expect(mockHighlightRepository.encryptFieldsIntoEntity).not.toHaveBeenCalled();
    expect(mockHighlightRepository.create).toHaveBeenCalledTimes(1);
  });

  it('never exposes ciphertext columns in the response DTO', async () => {
    mockConsultationRepository.findById.mockResolvedValue({ id: CONSULTATION, tenantId: TENANT });
    mockHighlightRepository.create.mockImplementation((e) => Promise.resolve(e));

    const service = buildService(true);
    const res = await service.createHighlight(CONSULTATION, requestWithNote);

    expect(res).not.toHaveProperty('encryptedExact');
    expect(res).not.toHaveProperty('encryptedNote');
    expect(res).not.toHaveProperty('keyVersion');
  });
});

// Reference the unused factory import so the suite keeps the entity contract in
// view for future field changes (no-op assertion).
it('HighlightFactory remains importable', () => {
  expect(typeof HighlightFactory.CreateHighlight).toBe('function');
});
