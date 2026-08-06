/**
 * TASK-615 WS-D2 (item 1b) — `ContextService#addRawSummary` is one of the two
 * unmetered `SummaryMeta` writers flagged in the WS-D handoff ("compat"
 * path). Unlike `comprehensive-summary.processor.ts` (item 1a), this write
 * path makes NO SMR call of its own — confirmed by an exhaustive search: zero
 * httpService/axios references anywhere in context.service.ts. It exists to
 * persist a summary + bare `inputTokens`/`outputTokens` a caller already
 * computed elsewhere, so there is no real `SmrUsageDetail` (no provider, no
 * endpointKind, no raw provider payload) — hence
 * `buildLlmUsageInputFromTokenCounts` (smr-usage.ts) rather than
 * `buildLlmUsageInput`, which would force a fabricated `endpointKind` onto
 * `attributesJson`.
 *
 * Same transactional treatment as item 1a: the SummaryMeta write and the
 * (best-effort) usage row commit together via the DOMAINS
 * `CoreUnitOfWorkService`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';
import { ContextService } from '../context.service';

const TX = { __brand: 'tx' } as unknown as never;

function makeConsultation(overrides: Record<string, unknown> = {}) {
  return { id: 'consultation-1', tenantId: 'tenant-1', doctorId: 'doctor-1', departmentId: 'dept-1', ...overrides };
}

function makeHarness(overrides: { usageLedgerService?: unknown; unitOfWorkService?: unknown } = {}) {
  const contextItemRepository = {
    create: vi.fn().mockResolvedValue({ id: 'new-summary-id', tenantId: 'tenant-1', createdAt: new Date() }),
    encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
    findWithSummaryMeta: vi.fn().mockResolvedValue({ id: 'new-summary-id', tenantId: 'tenant-1', createdAt: new Date(), updatedAt: new Date() }),
  };
  const contextItemVersionRepository = { create: vi.fn().mockResolvedValue({ id: 'ver-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
  const audioRecordingRepository = {};
  const summaryMetaRepository = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
  const namedEntityRepository = {};
  const consultationRepository = { findById: vi.fn().mockResolvedValue(makeConsultation()) };
  const eventEmitter = { emit: vi.fn() };
  const clsService = {
    get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : key === 'user' ? { id: 'user-1' } : undefined)),
  };
  const secretsService = { getSecretOptional: vi.fn().mockResolvedValue('') };
  const usageLedgerService = overrides.usageLedgerService ?? { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 1 }) };
  const unitOfWorkService = overrides.unitOfWorkService ?? { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(TX)) };

  const service = new ContextService(
    contextItemRepository as never,
    contextItemVersionRepository as never,
    audioRecordingRepository as never,
    summaryMetaRepository as never,
    namedEntityRepository as never,
    consultationRepository as never,
    eventEmitter as never,
    clsService as never,
    secretsService as never,
    undefined, // mediaRepository
    undefined, // blobStorage
    usageLedgerService as never,
    unitOfWorkService as never,
  );

  return { service, summaryMetaRepository, consultationRepository, usageLedgerService: usageLedgerService as { recordUsage: ReturnType<typeof vi.fn> }, unitOfWorkService };
}

describe('ContextService#addRawSummary — usage-ledger emission (TASK-615 WS-D2)', () => {
  let harness: ReturnType<typeof makeHarness>;

  beforeEach(() => {
    harness = makeHarness();
  });

  it('emits an LLM usage row in the SAME transaction as the SummaryMeta write, from bare token counts', async () => {
    await harness.service.addRawSummary('consultation-1', {
      content: 'AI generated summary',
      aiModelId: 'gpt-4',
      inputTokens: 1500,
      outputTokens: 500,
    });

    expect(harness.summaryMetaRepository.create).toHaveBeenCalledWith(expect.anything(), TX);

    expect(harness.usageLedgerService.recordUsage).toHaveBeenCalledTimes(1);
    const [input, tx] = harness.usageLedgerService.recordUsage.mock.calls[0];
    expect(tx).toBe(TX);
    expect(input.common.operation).toBe('generate');
    expect(input.common.tenantId).toBe('tenant-1');
    expect(input.common.consultationId).toBe('consultation-1');
    expect(input.common.doctorId).toBe('doctor-1');
    expect(input.common.departmentId).toBe('dept-1');
    expect(input.common.model).toBe('gpt-4');
    expect(input.common.idempotencyKey).toMatch(/^llm:.+/);
    expect(input.units).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 1500 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 500 },
    ]);
  });

  it('emits nothing when the request carries no token counts (no work billed)', async () => {
    await harness.service.addRawSummary('consultation-1', { content: 'x', aiModelId: 'gpt-4' });

    expect(harness.usageLedgerService.recordUsage).not.toHaveBeenCalled();
    expect(harness.summaryMetaRepository.create).toHaveBeenCalled();
  });

  it('still persists the SummaryMeta when the ledger is not wired', async () => {
    const unwired = makeHarness({ usageLedgerService: null, unitOfWorkService: null });

    await expect(
      unwired.service.addRawSummary('consultation-1', { content: 'x', aiModelId: 'gpt-4', inputTokens: 100, outputTokens: 10 }),
    ).resolves.toBeDefined();
    expect(unwired.summaryMetaRepository.create).toHaveBeenCalled();
  });

  it('does not fail the write when the ledger rejects', async () => {
    const failing = makeHarness({ usageLedgerService: { recordUsage: vi.fn().mockRejectedValue(new Error('outbox unavailable')) } });

    await expect(
      failing.service.addRawSummary('consultation-1', { content: 'x', aiModelId: 'gpt-4', inputTokens: 100, outputTokens: 10 }),
    ).resolves.toBeDefined();
    expect(failing.summaryMetaRepository.create).toHaveBeenCalled();
  });
});
