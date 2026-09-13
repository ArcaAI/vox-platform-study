/**
 * TASK-957 F-8 — the CLINICAL `ner.extract` row declares `CONSULTATION`.
 *
 * `SummaryService.extractEntities` is the surviving synchronous NER hop (the
 * async `ner.processor.ts` was deleted), and it is reached from exactly one
 * place: a consultation's context item. The agent NER route and the playground
 * bench share the same builder and declare their own triggers, so without this
 * one a tenant reading "spend by activity" sees its clinicians' NER spend as
 * untriggered — the single largest slice, unattributable.
 *
 * Asserted at the CALL SITE rather than on the builder because the builder
 * cannot know: the value is a property of which path called it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SummaryService } from '../summary.service';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    NamedEntityFactory: { CreateNamedEntity: vi.fn((data) => ({ id: 'temp-id', ...data })) },
  };
});

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'user-1' };
    return null;
  }),
  set: vi.fn(),
  run: vi.fn((callback: () => unknown) => callback()),
});

const createMockContextItem = () => ({
  id: 'ctx-item-123',
  tenantId: 'tenant-1',
  consultationId: 'consultation-1',
  type: 'TRANSCRIPT',
  content: 'Patient with Type 2 Diabetes.',
  isSummary: false,
  toObject: vi.fn().mockReturnValue({}),
  changes: {},
});

describe('SummaryService.extractEntities — ner.extract trigger (TASK-957 F-8)', () => {
  let usageLedger: { recordUsage: ReturnType<typeof vi.fn> };
  let mockHttpService: { axiosRef: { post: ReturnType<typeof vi.fn> } };

  const buildService = (): SummaryService =>
    new SummaryService(
      { findById: vi.fn().mockResolvedValue(createMockContextItem()) } as never,
      { findById: vi.fn(), update: vi.fn(), updateWithVersion: vi.fn() } as never,
      { create: vi.fn(), findByContextItem: vi.fn().mockResolvedValue(null), encryptFieldsIntoEntity: vi.fn() } as never,
      { create: vi.fn().mockResolvedValue({ id: 'entity-1' }) } as never,
      mockHttpService as never,
      { get: vi.fn().mockImplementation((key: string) => (key === 'NLP_URL' ? 'http://localhost:8864' : undefined)) } as never,
      { emit: vi.fn() } as never,
      createMockClsService() as never,
      { create: vi.fn() } as never,
      { assemble: vi.fn() } as never,
      undefined, // secretsService
      undefined, // userProfileRepository
      undefined, // harnessAuditService
      undefined, // harnessGatewayService
      undefined, // harnessPolicyService
      undefined, // configResolver
      undefined, // entitlements
      undefined, // trajectoryService
      { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never, // routingPolicies
      undefined, // transcriptSegmentRepository
      usageLedger as never, // usageLedger
      undefined, // unitOfWork
      undefined, // billing
      undefined, // aiModelRepository
      undefined, // noteGenerationService
      { redact: vi.fn(async (text: string) => text) } as never, // phiRedactor
    );

  beforeEach(() => {
    vi.clearAllMocks();
    usageLedger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
    mockHttpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { entities: [] } }) } };
  });

  it('records the clinical NER row with trigger CONSULTATION', async () => {
    const service = buildService();

    await service.extractEntities('ctx-item-123');

    expect(usageLedger.recordUsage).toHaveBeenCalledTimes(1);
    const [input] = usageLedger.recordUsage.mock.calls[0];
    expect(input.common.operation).toBe('ner.extract');
    expect(input.common.consultationId).toBe('consultation-1');
    expect(input.common.attributesJson.trigger).toBe('CONSULTATION');
  });
});
