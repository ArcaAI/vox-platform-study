/**
 * Finalize lineage on `SummaryService.generateSummary`.
 *
 * R-N2: the agent that ran the live session is the agent that reviews and
 * finalizes. This suite locks the three observable consequences:
 *
 *   1. the frozen lineage on the consumed `LIVE_SOAP_SNAPSHOT`'s
 *      `metaData.agent` reaches prompt assembly as `preSummaryLineage` +
 *      `pinnedAgentId`;
 *   2. `SummaryMeta` records `sessionAgentId` / `sessionAgentPromptVersion`
 *      and the consumed snapshot id in `preSummaryIds`;
 *   3. ADDITIVE PROOF — a consultation with NO live lineage behaves exactly as
 *      before C5: both columns null, `preSummaryIds` empty, no pinning.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SummaryService } from '../summary.service';
import { ModelTaskType } from '@arcaai/domains';

const LINEAGE = {
  agentId: 'agent-session',
  agentName: 'Cardiology Default',
  promptTemplateId: 'tpl-live',
  promptVersionNumber: 4,
  resolvedFrom: 'agent',
  frozenAt: '2026-08-08T00:00:00.000Z',
};

const createMockClsService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'tenantId') return 'tenant-1';
    if (key === 'user') return { id: 'user-1', firstName: 'Test', lastName: 'User' };
    return null;
  }),
  set: vi.fn(),
  run: vi.fn((callback: () => unknown) => callback()),
});

const createMockContextItemRepository = () => ({
  findById: vi.fn(),
  findCaseNotes: vi.fn(),
  findTranscripts: vi.fn().mockResolvedValue([{ content: 'transcript text' }]),
  findSummaries: vi.fn(),
  findLatestModifiedSummary: vi.fn(),
  findLatestRawSummary: vi.fn(),
  findLatestPreSummary: vi.fn(),
  findLatestPreSummaryWithDecryptedContent: vi.fn().mockResolvedValue({ entity: null, plaintext: null }),
  create: vi.fn().mockResolvedValue({ id: 'ctx-new', content: 'S', createdAt: new Date(), updatedAt: new Date() }),
  update: vi.fn(),
  encryptContentIntoEntity: vi.fn().mockResolvedValue(undefined),
});

const createMockHttpService = () => ({
  axiosRef: { post: vi.fn().mockResolvedValue({ data: { summary: 'S', modelName: 'm' } }) },
});

const createMockConfigService = () => ({
  get: vi.fn().mockImplementation((key: string) => {
    if (key === 'TEXT_URL') return 'http://localhost:8862';
    if (key === 'NLP_URL') return 'http://localhost:8864';
    return undefined;
  }),
});

describe('SummaryService.generateSummary — finalize lineage', () => {
  let contextItemRepository: ReturnType<typeof createMockContextItemRepository>;
  let summaryMetaRepository: { create: ReturnType<typeof vi.fn>; encryptFieldsIntoEntity: ReturnType<typeof vi.fn> };
  let promptAssemblyService: { assemble: ReturnType<typeof vi.fn> };
  let service: SummaryService;

  const createdMeta = () => summaryMetaRepository.create.mock.calls.at(-1)![0] as Record<string, unknown>;
  const assembleParams = () => promptAssemblyService.assemble.mock.calls.at(-1)![0] as Record<string, unknown>;

  beforeEach(() => {
    contextItemRepository = createMockContextItemRepository();
    summaryMetaRepository = { create: vi.fn().mockResolvedValue({ id: 'meta-1' }), encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined) };
    promptAssemblyService = {
      assemble: vi.fn().mockResolvedValue({
        userPrompt: 'assembled',
        systemPrompt: '',
        hyperparameters: {},
        responseFormat: null,
        resolvedFrom: 'agent',
        promptId: 'tpl-finalize',
      }),
    };

    service = new SummaryService(
      contextItemRepository as never,
      { findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' }), update: vi.fn() } as never,
      summaryMetaRepository as never,
      { create: vi.fn() } as never,
      createMockHttpService() as never,
      createMockConfigService() as never,
      { emit: vi.fn() } as never,
      createMockClsService() as never,
      { create: vi.fn(), findById: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]), encryptFieldsIntoEntity: vi.fn() } as never,
      promptAssemblyService as never,
    );
  });

  /** The snapshot the live loop wrote, with (or without) its frozen agent block. */
  function withSnapshot(metaData: Record<string, unknown> | undefined) {
    contextItemRepository.findLatestPreSummaryWithDecryptedContent.mockImplementation(
      async (_consultationId: string, _secrets: unknown, options?: { subType?: string }) => {
        if (options?.subType === 'LIVE_SOAP_SNAPSHOT') {
          return { entity: { id: 'ctx-snapshot', metaData }, plaintext: 'S: live running note' };
        }
        return { entity: null, plaintext: null };
      },
    );
  }

  it('threads the frozen lineage into prompt assembly and pins the agent', async () => {
    withSnapshot({ subType: 'LIVE_SOAP_SNAPSHOT', agent: LINEAGE });

    await service.generateSummary('c-1', {} as never, 'user-1');

    expect(assembleParams().preSummaryText).toBe('S: live running note');
    expect(assembleParams().preSummaryLineage).toMatchObject({ agentId: 'agent-session' });
    expect(assembleParams().pinnedAgentId).toBe('agent-session');
  });

  it('records the lineage + consumed snapshot id on SummaryMeta', async () => {
    withSnapshot({ subType: 'LIVE_SOAP_SNAPSHOT', agent: LINEAGE });

    await service.generateSummary('c-1', {} as never, 'user-1');

    const meta = createdMeta();
    expect(meta.sessionAgentId).toBe('agent-session');
    expect(meta.sessionAgentPromptVersion).toBe('tpl-live@4');
    expect(meta.preSummaryIds).toEqual(['ctx-snapshot']);
  });

  it('ADDITIVE PROOF — a snapshot with no agent block behaves exactly as before C5', async () => {
    withSnapshot({ subType: 'LIVE_SOAP_SNAPSHOT' });

    await service.generateSummary('c-1', {} as never, 'user-1');

    expect(assembleParams().preSummaryLineage).toBeUndefined();
    expect(assembleParams().pinnedAgentId).toBeUndefined();
    const meta = createdMeta();
    expect(meta.sessionAgentId).toBeNull();
    expect(meta.sessionAgentPromptVersion).toBeNull();
    expect(meta.preSummaryIds).toEqual([]);
  });

  it('ADDITIVE PROOF — no pre-summary at all leaves the lineage columns null', async () => {
    await service.generateSummary('c-1', {} as never, 'user-1');

    const meta = createdMeta();
    expect(meta.sessionAgentId).toBeNull();
    expect(meta.sessionAgentPromptVersion).toBeNull();
    expect(meta.preSummaryIds).toEqual([]);
  });

  it('ignores a malformed agent block rather than fabricating provenance', async () => {
    withSnapshot({ subType: 'LIVE_SOAP_SNAPSHOT', agent: { agentName: 'no id here' } });

    await service.generateSummary('c-1', {} as never, 'user-1');

    expect(assembleParams().pinnedAgentId).toBeUndefined();
    expect(createdMeta().sessionAgentId).toBeNull();
  });

  // ── RF-4 — finalize LLM precedence, end to end through callTextService ──
  describe('finalize LLM precedence (RF-4)', () => {
    const httpService = createMockHttpService();
    const resolveTextSelection = vi.fn().mockResolvedValue({ provider: 'tenant-provider', model: 'tenant-model' });

    /**
     * The full positional constructor: everything before `harnessPolicyService`
     * (index 14) and the two trailing repositories (23, 24).
     */
    function buildService(agent: unknown) {
      // Positional indices 10…22: secretsService(10) … billing(22).
      const tail: unknown[] = new Array(13).fill(undefined);
      tail[0] = { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('') }; // secretsService
      tail[4] = { getEffectivePolicy: vi.fn(), resolveTextSelection, resolveTextFallbackSelection: vi.fn().mockResolvedValue(null) }; // harnessPolicyService
      return new SummaryService(
        contextItemRepository as never,
        { findById: vi.fn().mockResolvedValue({ id: 'c-1', tenantId: 'tenant-1' }), update: vi.fn() } as never,
        summaryMetaRepository as never,
        { create: vi.fn() } as never,
        httpService as never,
        createMockConfigService() as never,
        { emit: vi.fn() } as never,
        createMockClsService() as never,
        { create: vi.fn(), findById: vi.fn(), getVersionsByChangeReason: vi.fn().mockResolvedValue([]), encryptFieldsIntoEntity: vi.fn() } as never,
        promptAssemblyService as never,
        ...(tail as never[]),
        { findById: vi.fn().mockResolvedValue(agent) } as never, // departmentAgentRepository (23)
        { findAll: vi.fn().mockResolvedValue([{ provider: 'openai', sourceUri: 'gpt-4.1', taskType: ModelTaskType.TEXT_GENERATION }]) } as never,
      );
    }

    const textOptions = () => httpService.axiosRef.post.mock.calls.at(-1)![1] as Record<string, unknown>;

    it("the session agent's finalize override outranks the tenant text.finalize default", async () => {
      withSnapshot({ subType: 'LIVE_SOAP_SNAPSHOT', agent: LINEAGE });
      const svc = buildService({ llmOverrides: { finalize: { aiModelSlug: 'gpt-4-1' } } });

      await svc.generateSummary('c-1', {} as never, 'user-1');

      expect(textOptions().llm_provider ?? textOptions().provider).toBeDefined();
      expect(JSON.stringify(textOptions())).toContain('gpt-4.1');
    });

    it('REGRESSION LOCK — no lineage ⇒ the tenant selection decides, exactly as before', async () => {
      const svc = buildService({ llmOverrides: { finalize: { aiModelSlug: 'gpt-4-1' } } });

      await svc.generateSummary('c-1', {} as never, 'user-1');

      expect(resolveTextSelection).toHaveBeenCalledWith('tenant-1', 'finalize');
      expect(JSON.stringify(textOptions())).toContain('tenant-model');
    });
  });
});
