/**
 * SummaryService — persist prompt-resolution tier on SummaryMeta (TASK-331 doc-06 F4).
 *
 * Both `generateSummary` and `generatePreSummary` compute an `assembledPrompt`
 * whose `resolvedFrom` (preferred/department/default) + `promptId` describe which
 * tier produced the summary. Before this slice the tier was only forwarded to SMR;
 * now it must also be written onto the SummaryMeta record so it can be surfaced.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'user-1' };
    return null;
  }),
  set: vi.fn(),
});

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findCaseNotes: vi.fn().mockResolvedValue([]),
  findTranscripts: vi.fn().mockResolvedValue([]),
  findLatestPreSummary: vi.fn().mockResolvedValue(null),
  create: vi.fn().mockResolvedValue({
    id: 'ctx-new',
    consultationId: 'c-1',
    type: 'RAW_SUMMARY',
    content: 'Generated summary',
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
});

const createMockConsultationRepository = () => ({
  findById: vi.fn().mockResolvedValue({
    id: 'c-1',
    tenantId: 'tenant-1',
    departmentId: 'dept-1',
    doctorId: 'doc-1',
    parentConsultationId: null,
  }),
});

const createMockSummaryMetaRepository = () => ({
  create: vi.fn().mockResolvedValue({ id: 'meta-1' }),
});

const createMockHttpService = () => ({
  axiosRef: {
    post: vi.fn().mockResolvedValue({ data: { summary: 'Generated summary', modelName: 'gpt-4o' } }),
  },
});

const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'SMR_URL') return 'http://localhost:8862';
    if (key === 'NLP_URL') return 'http://localhost:8864';
    return undefined;
  }),
});

const createMockPromptAssemblyService = (resolvedFrom: string, promptId: string) => ({
  assemble: vi.fn().mockResolvedValue({
    userPrompt: 'assembled prompt text',
    systemPrompt: '',
    hyperparameters: {},
    responseFormat: null,
    resolvedFrom,
    promptId,
  }),
});

const buildService = (promptAssembly: ReturnType<typeof createMockPromptAssemblyService>) => {
  const ctx = createMockContextItemRepository();
  const consult = createMockConsultationRepository();
  const meta = createMockSummaryMetaRepository();
  const service = new SummaryService(
    ctx as never,
    consult as never,
    meta as never,
    { create: vi.fn() } as never, // namedEntityRepository
    createMockHttpService() as never,
    createMockConfigService() as never,
    { emit: vi.fn() } as never,
    createMockClsService() as never,
    { create: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]) } as never,
    promptAssembly as never,
  );
  return { service, ctx, consult, meta };
};

describe('SummaryService — persist promptResolvedFrom/resolvedPromptId (TASK-331 F4)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generateSummary creates SummaryMeta carrying the assembled tier + prompt id', async () => {
    const promptAssembly = createMockPromptAssemblyService('department', 'dept-prompt-id');
    const { service, meta } = buildService(promptAssembly);

    await service.generateSummary('c-1', { transcription: 'patient transcript' } as never);

    expect(meta.create).toHaveBeenCalledTimes(1);
    const created = meta.create.mock.calls[0][0];
    expect(created.promptResolvedFrom).toBe('department');
    expect(created.resolvedPromptId).toBe('dept-prompt-id');
  });

  it('generatePreSummary creates SummaryMeta carrying the assembled tier + prompt id', async () => {
    const promptAssembly = createMockPromptAssemblyService('preferred', 'preferred-prompt-id');
    const { service, ctx, meta } = buildService(promptAssembly);
    ctx.findCaseNotes.mockResolvedValue([{ id: 'cn-1', content: 'historical case note' }]);

    await service.generatePreSummary('c-1', {} as never);

    expect(meta.create).toHaveBeenCalledTimes(1);
    const created = meta.create.mock.calls[0][0];
    expect(created.promptResolvedFrom).toBe('preferred');
    expect(created.resolvedPromptId).toBe('preferred-prompt-id');
  });
});
