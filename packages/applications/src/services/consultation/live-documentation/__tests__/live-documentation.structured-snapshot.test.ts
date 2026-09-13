/**
 * A1 — the durable finalizer is handed a DOCUMENT, not a wall of prose.
 *
 * ## The defect
 *
 * `persistDurableSnapshot` wrote `payload.runningSummary` into the `LIVE_SOAP_SNAPSHOT` ContextItem,
 * and `harness.finalize` reads that row's content as its `preSummaryText`
 * (`harness-internal.service.ts#loadLiveSoapSnapshot`). But `runningSummary` is
 * `buildRunningSummary(sections)` — an unlabelled `\n\n` join of the section BODIES, titles and
 * keys discarded, because it exists to be the NER OFFSET BASE. So the finalizer was asked to
 * return a 13-section note from text whose partition had been thrown away one function call
 * earlier, and it answered with a narrative paragraph. Every time.
 *
 * ## What this file pins
 *
 *  1. The persisted snapshot carries `## <title>` per non-empty section.
 *  2. The PUBLISHED `runningSummary` is untouched — it is still the headings-free offset base the
 *     entity spans index and the "section content is a contiguous substring of runningSummary"
 *     invariant is stated against. The two must never converge, which is what the second
 *     assertion of the first case is for.
 */
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-snapshot';

/** A turn against the platform SOAP shape that writes two of the four sections and leaves two empty. */
const TURN = JSON.stringify({
  subjective: { addition: 'Cough since monday.' },
  plan: { addition: 'Rest and fluids.' },
});

/** Whatever the model answers, no section header matches → the parser's unstructured fallback. */
const UNPARSEABLE = 'Patient reports a cough. Advised rest and fluids.';

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

function buildService(note: string) {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) return Promise.resolve({ data: { entities: [], vitals: {} } });
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: note } });
    return Promise.resolve({ data: {} });
  });
  // `LIVE_DOC_DURABLE_SNAPSHOT_MS: 0` disables the throttled per-flush write, so the ONE row that
  // reaches the repository is the forced final write `stop()` makes — the row finalize reads.
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };

  const contextItemRepository = {
    create: vi.fn(async (entity: { id?: string }) => ({ ...entity, id: 'ctx-1' })),
    update: vi.fn(async () => ({ id: 'ctx-1' })),
    findTranscripts: vi.fn(async () => []),
    findPreSummaries: vi.fn(async () => []),
    findLatestPreSummary: vi.fn(async () => null),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
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
    { findById: vi.fn(async (id: string) => ({ id, tenantId: ARCAAI, metadata: null })) } as never,
    { resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: null, source: 'platform-default' })) } as never,
    { findPublishedBySlug: vi.fn(async () => null) } as never,
  );

  return { service, contextItemRepository };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

/** Record one utterance and end the session, persisting the snapshot finalize will read. */
async function runToSnapshot(note: string) {
  const { service, contextItemRepository } = buildService(note);
  service.start({ consultationId: CID, tenantId: ARCAAI });
  await settle();
  service.ingestSegment(CID, { text: 'cough since monday, advised rest', isFinal: true, segmentId: 's1' });
  await service.flush(CID);
  const final = await service.stop(CID, { persistSnapshot: true });

  expect(contextItemRepository.create).toHaveBeenCalledTimes(1);
  const persisted = contextItemRepository.create.mock.calls[0][0] as { content: string; metaData: { subType: string } };
  return { final, persisted };
}

describe('A1 — the LIVE_SOAP_SNAPSHOT the finalizer reads is template-shaped', () => {
  it('writes `## <title>` + body for EVERY template section, an untouched one carrying the marker', async () => {
    const { final, persisted } = await runToSnapshot(TURN);

    expect(persisted.metaData.subType).toBe('LIVE_SOAP_SNAPSHOT');
    // Reviewed 2026-09-13: the finalizer keeps exactly the headings it is given, so the
    // snapshot carries the WHOLE template — the two untouched SOAP sections are present
    // under their headings with the marker, never absent (a missing heading reads as an
    // omission in the finished note) and never blank (a blank invites invention).
    expect(persisted.content).toBe(
      [
        '## Subjective',
        'Cough since monday.',
        '',
        '## Objective',
        'Not documented in this consultation.',
        '',
        '## Assessment',
        'Not documented in this consultation.',
        '',
        '## Plan',
        'Rest and fluids.',
      ].join('\n'),
    );

    // The OFFSET BASE is untouched: what the clinician's feed carries, and what entity spans
    // index, is still the headings-free join. These two strings must never become the same one.
    expect(final!.runningSummary).toBe('Cough since monday.\n\nRest and fluids.');
    expect(final!.runningSummary).not.toContain('##');
    // And the substring invariant the SSE/SDK contract states still holds against it.
    for (const section of final!.sections.filter((s) => s.content.trim().length > 0)) {
      expect(final!.runningSummary).toContain(section.content.trim());
    }
  });

  it('falls back to the flat text when the model’s note could not be partitioned at all', async () => {
    // The parser's fallback is `[{ title: 'Running Summary', content: <all of it> }]` — a note
    // whose partition is UNKNOWN, not a note with a section by that name. Heading it would put a
    // title the template does not declare into the finalizer's input, so the snapshot degrades to
    // exactly the text it carried before A1 and gains no invented structure.
    const { final, persisted } = await runToSnapshot(UNPARSEABLE);

    expect(persisted.content).toBe(UNPARSEABLE);
    expect(persisted.content).toBe(final!.runningSummary);
    expect(persisted.content).not.toContain('##');
  });
});
