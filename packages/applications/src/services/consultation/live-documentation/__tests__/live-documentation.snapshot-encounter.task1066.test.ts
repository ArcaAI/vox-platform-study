/**
 * The live note snapshot (PRE_SUMMARY, `LIVE_SOAP_SNAPSHOT`) belongs to the encounter it was
 * written in: it is stamped with the consultation's current encounter, a later write of the same
 * encounter updates the row in place, and a new encounter starts its own row rather than
 * overwriting the previous encounter's running note.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-snapshot-encounter';

const TURN = JSON.stringify({ subjective: { addition: 'Cough since monday.' }, plan: { addition: 'Rest and fluids.' } });

function cacheMock() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-13T00:00:00.000Z',
});

function buildService(currentEncounterSeq: number, existing: Record<string, unknown> | null) {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [], vitals: {} } });
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: TURN } });
    return Promise.resolve({ data: {} });
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };

  const contextItemRepository = {
    create: vi.fn(async (entity: { id?: string }) => ({ ...entity, id: 'ctx-new' })),
    update: vi.fn(async (id: string) => ({ id })),
    findTranscripts: vi.fn(async () => []),
    findPreSummaries: vi.fn(async () => []),
    findLatestPreSummary: vi.fn(async () => null),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: existing, plaintext: null })),
    encryptContentIntoEntity: vi.fn(),
  };

  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
    cacheMock() as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
    undefined, // audioBridge
    contextItemRepository as never,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    {
      resolveEffective: vi.fn(async (key: string) =>
        key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
      ),
    } as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async (id: string) => ({ id, tenantId: ARCAAI, metadata: null, currentEncounterSeq })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: null, source: 'platform-default' })) } as never,
    { findPublishedBySlug: vi.fn(async () => null) } as never,
  );

  return { service, contextItemRepository };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

async function runToSnapshot(currentEncounterSeq: number, existing: Record<string, unknown> | null) {
  const built = buildService(currentEncounterSeq, existing);
  built.service.start({ consultationId: CID, tenantId: ARCAAI });
  await settle();
  built.service.ingestSegment(CID, { text: 'cough since monday, advised rest', isFinal: true, segmentId: 's1' });
  await built.service.flush(CID);
  await built.service.stop(CID, { persistSnapshot: true });
  return built;
}

const existingRow = (encounterSeq: number | null) => ({
  id: 'ctx-old',
  type: 'PRE_SUMMARY',
  encounterSeq,
  content: 'old note',
  metaData: { subType: 'LIVE_SOAP_SNAPSHOT' },
  createdAt: new Date('2026-10-13T08:00:00Z'),
});

describe('live note snapshot — encounter scoping', () => {
  it('stamps a new snapshot with the consultation’s current encounter', async () => {
    const { contextItemRepository } = await runToSnapshot(2, null);
    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
    expect((contextItemRepository.create.mock.calls[0][0] as { encounterSeq: number | null }).encounterSeq).toBe(2);
  });

  it('a new encounter starts its own snapshot row instead of overwriting the previous encounter’s', async () => {
    const { contextItemRepository } = await runToSnapshot(2, existingRow(1));
    expect(contextItemRepository.update).not.toHaveBeenCalledWith('ctx-old', expect.anything());
    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
    expect((contextItemRepository.create.mock.calls[0][0] as { encounterSeq: number | null }).encounterSeq).toBe(2);
  });

  it('an unstamped (pre-encounter) snapshot counts as encounter 1 and is left alone in encounter 2', async () => {
    const { contextItemRepository } = await runToSnapshot(2, existingRow(null));
    expect(contextItemRepository.update).not.toHaveBeenCalledWith('ctx-old', expect.anything());
    expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
  });

  it('the same encounter’s snapshot is reused in place and carries the encounter stamp', async () => {
    const { contextItemRepository } = await runToSnapshot(1, existingRow(null));
    expect(contextItemRepository.create).not.toHaveBeenCalled();
    const [id, written] = contextItemRepository.update.mock.calls.find((call) => call[0] === 'ctx-old') as unknown as [
      string,
      { encounterSeq: number | null },
    ];
    expect(id).toBe('ctx-old');
    expect(written.encounterSeq).toBe(1);
  });
});
