/**
 * TASK-710 (re-opened) — PHI redaction on the SYNCHRONOUS NER hop.
 *
 * TASK-710 originally wired hop 1 (transcript → NLP) into
 * `consultation/jobs/processors/ner.processor.ts`. TASK-732 DELETED that file,
 * and the surviving synchronous path — `SummaryService.extractEntities()` —
 * posted `contextItem.content` to the NLP service RAW. Assessment finding A-02
 * was therefore effectively re-opened: PHI reached `apps/nlp` unredacted.
 *
 * These tests lock the fixed contract:
 *   1. the NLP service receives PSEUDONYMIZED text, never the raw content;
 *   2. a THROWING redactor aborts the operation — NLP is never called and the
 *      caller sees the failure (never a silent fallback to raw text);
 *   3. an ABSENT redactor is itself fail-closed (owner directive D-A: a
 *      day-1-production PHI dependency is REQUIRED, not best-effort).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';

vi.mock('@arcaai/domains', async () => {
  const actual = await vi.importActual('@arcaai/domains');
  return {
    ...actual,
    NamedEntityFactory: {
      CreateNamedEntity: vi.fn((data) => ({ id: 'temp-id', ...data })),
    },
  };
});

const RAW_CONTENT = 'Patient John Doe, DOB 1974-03-02, diagnosed with Type 2 Diabetes. Prescribed Metformin 500mg.';
const PSEUDONYMIZED_CONTENT = 'Patient [PERSON_1], DOB [DATE_OF_BIRTH_1], diagnosed with Type 2 Diabetes. Prescribed Metformin 500mg.';

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'user-1', firstName: 'Test', lastName: 'User' };
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
  content: RAW_CONTENT,
  isSummary: false,
  toObject: vi.fn().mockReturnValue({}),
  changes: {},
});

describe('TASK-710 — SummaryService.extractEntities redacts before calling NLP', () => {
  let mockContextItemRepository: { findById: ReturnType<typeof vi.fn> };
  let mockNamedEntityRepository: { create: ReturnType<typeof vi.fn> };
  let mockHttpService: { axiosRef: { post: ReturnType<typeof vi.fn> } };
  let mockConfigService: { get: ReturnType<typeof vi.fn> };
  let mockPhiRedactor: { redact: ReturnType<typeof vi.fn> };

  /** Build the service with exactly one variable: the redactor (param #27). */
  const buildService = (phiRedactor: unknown): SummaryService =>
    new SummaryService(
      mockContextItemRepository as never,
      { findById: vi.fn(), update: vi.fn(), updateWithVersion: vi.fn() } as never,
      { create: vi.fn(), findByContextItem: vi.fn().mockResolvedValue(null), encryptFieldsIntoEntity: vi.fn() } as never,
      mockNamedEntityRepository as never,
      mockHttpService as never,
      mockConfigService as never,
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
      { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as any, // aiTaskDefaultService (fail-closed resolver needs a row)
      undefined, // transcriptSegmentRepository
      undefined, // usageLedger
      undefined, // unitOfWork
      undefined, // billing
      undefined, // departmentAgentRepository
      undefined, // aiModelRepository
      undefined, // noteGenerationService
      phiRedactor as never, // phiRedactor
    );

  const nlpCall = () => mockHttpService.axiosRef.post.mock.calls.find((c: unknown[]) => String(c[0]).includes('/api/v1/classify/tokens'));

  beforeEach(() => {
    vi.clearAllMocks();
    mockContextItemRepository = { findById: vi.fn().mockResolvedValue(createMockContextItem()) };
    mockNamedEntityRepository = { create: vi.fn().mockResolvedValue({ id: 'entity-1' }) };
    mockHttpService = { axiosRef: { post: vi.fn().mockResolvedValue({ data: { entities: [] } }) } };
    mockConfigService = {
      get: vi.fn().mockImplementation((key: string) => (key === 'NLP_URL' ? 'http://localhost:8864' : undefined)),
    };
    mockPhiRedactor = { redact: vi.fn().mockResolvedValue(PSEUDONYMIZED_CONTENT) };
  });

  it('posts PSEUDONYMIZED text to the NLP service, never the raw content', async () => {
    const service = buildService(mockPhiRedactor);

    await service.extractEntities('ctx-item-123');

    expect(mockPhiRedactor.redact).toHaveBeenCalledWith(RAW_CONTENT, 'pseudonymize');

    const call = nlpCall();
    expect(call, 'the NLP token-classification endpoint must have been called').toBeDefined();
    const body = call![1] as { text: string };
    expect(body.text).toBe(PSEUDONYMIZED_CONTENT);
    expect(body.text).not.toContain('John Doe');
    expect(body.text).not.toContain('1974-03-02');
    // Clinical terms survive pseudonymization — that is the whole reason this
    // hop uses `pseudonymize` rather than `full`.
    expect(body.text).toContain('Type 2 Diabetes');
    expect(body.text).toContain('Metformin 500mg');
  });

  it('aborts fail-closed when the redactor throws — NLP is never called', async () => {
    mockPhiRedactor.redact.mockRejectedValue(new Error('guardrail redact unavailable'));
    const service = buildService(mockPhiRedactor);

    await expect(service.extractEntities('ctx-item-123')).rejects.toThrow();

    expect(nlpCall(), 'a redactor failure must never fall through to an unredacted NLP call').toBeUndefined();
    expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
  });

  it('aborts fail-closed when NO redactor is wired — NLP is never called', async () => {
    const service = buildService(undefined);

    await expect(service.extractEntities('ctx-item-123')).rejects.toThrow(/redact/i);

    expect(nlpCall(), 'an unwired redactor must abort, not silently post raw PHI').toBeUndefined();
    expect(mockNamedEntityRepository.create).not.toHaveBeenCalled();
  });
});
