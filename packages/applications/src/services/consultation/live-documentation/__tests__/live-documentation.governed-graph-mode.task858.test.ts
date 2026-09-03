/**
 * lane A2 — the substrate gate becomes MODE-AWARE.
 *
 * ## The defect
 *
 * `ensureSubstrateResolved` ( task 13) stands the WHOLE live engine down
 * `stop(consultationId, { persistSnapshot: false })` — whenever a well-formed `governingEngine`
 * marker is on the consultation. That was right when "this engine" meant the LEGACY hardcoded
 * flush: two engines, one document.
 *
 * Since the same session, with `consultation.realtime.graphExecutor.enabled = true`,
 * runs the REALTIME LANE of the tenant's own published graph — and the durable interpreter
 * deliberately SKIPS every `lane: 'realtime'` node (`apps/harness/.../interpreter/workflow.py`
 * `_dispatch_node`, `reason="realtime_lane"`). So on a fully wired stack the realtime NER, the
 * partial summary and the grammar pass ran in NEITHER engine. The realtime lane only ever ran
 * because the durable dispatch was failing and no marker was written.
 *
 * ## The contract this file pins
 *
 * | Governed? | Graph executor | Outcome |
 * |---|---|---|
 * | no | either | this engine documents the consultation (unchanged) |
 * | yes | OFF (no lane) | STAND DOWN — the legacy flush would write the document (unchanged) |
 * | yes | ON (a lane) | the session STAYS UP and walks the GOVERNING definition's realtime lane |
 *
 * The third row is safe because a realtime lane structurally cannot reach a durable writer:
 * `buildRealtimeLane` admits only `REALTIME_NODE_TYPES`, so `consultation.persistDraft`,
 * `consultation.finalizeAssurance` and `consultation.synthesize` are filtered out of every
 * committed consultation graph. That is asserted below over the REAL compiled configs rather
 * than argued.
 *
 * The one remaining way the legacy engine could write a governed consultation's document is
 * `flush()`'s fall-through when the lane cannot be WIRED (a `RealtimeBindingError` makes
 * `runGraphLane` return `null`). In graph mode for a governed consultation that fall-through is
 * refused: nothing is published, nothing is persisted, and the next flush retries the lane.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { buildRealtimeLane } from '../realtime/realtime-lane';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { GOVERNING_ENGINE_METADATA_KEY, TENANT_WORKFLOW_GOVERNS_MARKER } from '../../governing-engine';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-858-a2';
const NOTE = 'Subjective: patient reports cough and takes aspirin\nObjective:\nAssessment:\nPlan:';

/** The tenant DEFAULT — what the cascade answers when the consultation named nothing. */
const ASSIGNED_SLUG = 'arcaai-consultation-soap';
/** What the DURABLE run took ownership of, and therefore what the realtime lane must walk. */
const GOVERNING_SLUG = 'arcaai-example-medical-ner';

/**
 * A governing graph whose partial-summary node is authored OFF ( per-node `enabled`).
 *
 * It is the discriminator this file leans on: the LEGACY flush calls TEXT unconditionally, so
 * "the session flushed and TEXT was never called" is decisive proof that the lane ran and the
 * legacy path did not.
 */
const NER_ONLY_CONFIG = {
  slug: GOVERNING_SLUG,
  versionNumber: 3,
  stages: [
    {
      stageIndex: 0,
      nodes: [{ nodeId: 'capture', type: 'consultation.captureBinding', config: {}, inputs: [], onError: 'fail' }],
    },
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'extract',
          type: 'consultation.extractEntities',
          config: {},
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
        {
          nodeId: 'summarize',
          type: 'consultation.realtimeSummary',
          config: { enabled: false },
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
};

/** The same graph with ONE bad edge — `capture` declares no `not-a-port` output socket. */
const UNWIRABLE_CONFIG = {
  ...NER_ONLY_CONFIG,
  stages: [
    NER_ONLY_CONFIG.stages[0],
    {
      stageIndex: 1,
      nodes: [
        {
          nodeId: 'extract',
          type: 'consultation.extractEntities',
          config: {},
          inputs: [{ fromNodeId: 'capture', fromPort: 'not-a-port', toPort: 'in' }],
          onError: 'degrade',
        },
      ],
    },
  ],
};

/** A graph that DOES summarize — used where the assertion is about the document, not the call. */
const FULL_CONFIG = {
  ...NER_ONLY_CONFIG,
  stages: [
    NER_ONLY_CONFIG.stages[0],
    {
      stageIndex: 1,
      nodes: NER_ONLY_CONFIG.stages[1].nodes.map((n) => (n.nodeId === 'summarize' ? { ...n, config: {} } : n)),
    },
  ],
};

function httpMock() {
  const post = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/classify/tokens')) {
      return Promise.resolve({
        data: {
          entities: [{ text: 'aspirin', entity_type: 'MEDICATION', confidence: 0.9, position: { start: 0, end: 7 } }],
          vitals: { systolic: 120, diastolic: 80 },
        },
      });
    }
    if (url.includes('/generate')) return Promise.resolve({ data: { summary: NOTE } });
    return Promise.resolve({ data: {} });
  });
  return { post, http: { axiosRef: { post } } };
}

const generateCalls = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((c) => String(c[0]).includes('/generate'));
const nerCalls = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((c) => String(c[0]).includes('/classify/tokens'));

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
  liveLlm: null,
  frozenAt: '2026-08-28T00:00:00.000Z',
});

/** A well-formed marker — only written when the durable dispatch actually started a run. */
const governedBy = (slug: string) => ({
  [GOVERNING_ENGINE_METADATA_KEY]: {
    engine: TENANT_WORKFLOW_GOVERNS_MARKER,
    workflowRunId: 'run-858-a2',
    workflowDefinitionSlug: slug,
    decidedAt: '2026-09-03T00:00:00.000Z',
  },
});

interface BuildOpts {
  graphEnabled?: boolean;
  consultationMetadata?: unknown;
  /** The compiled config `findPublishedBySlug` returns for the GOVERNING slug. */
  governingConfig?: unknown;
}

function buildService(opts: BuildOpts = {}) {
  const { post, http } = httpMock();
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0', LIVE_DOC_DURABLE_SNAPSHOT_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };

  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
        ? { value: opts.graphEnabled ?? true, sourceScope: 'tenant' }
        : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  const consultationRepository = {
    findById: vi.fn(async (id: string) => ({ id, tenantId: ARCAAI, metadata: opts.consultationMetadata ?? null })),
  };

  const assignments = {
    resolve: vi.fn(
      async (tenantId: string, paletteKey: string): Promise<ResolvedWorkflowAssignment> =>
        tenantId === ARCAAI && paletteKey === 'consultation'
          ? { workflowDefinitionSlug: ASSIGNED_SLUG, source: 'tenant' }
          : { workflowDefinitionSlug: null, source: 'platform-default' },
    ),
  };

  const definitions = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) => {
      if (tenantId !== ARCAAI) return null;
      if (slug === GOVERNING_SLUG) return { slug, paletteKey: 'consultation', compiledConfig: opts.governingConfig ?? NER_ONLY_CONFIG };
      if (slug === ASSIGNED_SLUG) return { slug, paletteKey: 'consultation', compiledConfig: FULL_CONFIG };
      return null;
    }),
  };

  const contextItemRepository = {
    create: vi.fn(async (entity: { id?: string }) => ({ ...entity, id: 'ctx-pre-1' })),
    update: vi.fn(async () => ({ id: 'ctx-pre-1' })),
    findTranscripts: vi.fn(async () => []),
    findPreSummaries: vi.fn(async () => []),
    findLatestPreSummary: vi.fn(async () => null),
    findLatestPreSummaryWithDecryptedContent: vi.fn(async () => ({ entity: null, plaintext: null })),
    encryptContentIntoEntity: vi.fn(),
  };

  const service = new LiveDocumentationService(
    http as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined, // audioBridge
    contextItemRepository as never,
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    effectiveSettings as never,
    { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    consultationRepository as never,
    assignments as never,
    definitions as never,
  );

  return { service, post, assignments, definitions, consultationRepository, contextItemRepository };
}

/** `start()` is synchronous; the gate and the lane are fire-and-forget promises it kicks off. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

// =============================================================================
// (a) GOVERNED + graph executor ON — the session stays up and runs the governing lane
// =============================================================================

describe(' A2 — governed + graph mode: the realtime lane of the GOVERNING definition runs', () => {
  it('keeps the session: a governing marker is no longer, by itself, a stand-down', async () => {
    const { service } = buildService({ graphEnabled: true, consultationMetadata: governedBy(GOVERNING_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();

    // The durable interpreter SKIPS every realtime node, so standing this engine down here left
    // realtime NER / partial summary / grammar running in neither engine.
    expect(service.isActive(CID)).toBe(true);
    await service.stop(CID, { persistSnapshot: false });
  });

  it('the lane comes from the GOVERNING marker’s slug, not the assignment cascade', async () => {
    const { service, definitions, assignments } = buildService({
      graphEnabled: true,
      consultationMetadata: governedBy(GOVERNING_SLUG),
    });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();

    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, GOVERNING_SLUG);
    expect(assignments.resolve).not.toHaveBeenCalled();
    await service.stop(CID, { persistSnapshot: false });
  });

  it('the LEGACY flush never runs: the governing graph’s disabled summary node means no TEXT call', async () => {
    const { service, post } = buildService({ graphEnabled: true, consultationMetadata: governedBy(GOVERNING_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });
    await service.flush(CID);

    // The legacy path calls TEXT unconditionally. It did not run.
    expect(generateCalls(post)).toHaveLength(0);
    // The lane DID run — its enabled NER node made exactly the call the tenant authored.
    expect(nerCalls(post)).toHaveLength(1);
    await service.stop(CID, { persistSnapshot: false });
  });

  it('refuses the legacy FALL-THROUGH when the governing lane cannot be wired', async () => {
    const { service, post } = buildService({
      graphEnabled: true,
      consultationMetadata: governedBy(GOVERNING_SLUG),
      governingConfig: UNWIRABLE_CONFIG,
    });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    // A `RealtimeBindingError` makes `runGraphLane` return null, which for an UNGOVERNED session
    // means "fall back to the legacy engine". For a GOVERNED one that would be the exact hazard
    // the gate exists to prevent — a hardcoded document written beside the tenant's own.
    expect(payload).toBeNull();
    expect(generateCalls(post)).toHaveLength(0);
    await service.stop(CID, { persistSnapshot: false });
  });
});

// =============================================================================
// (b) GOVERNED + graph executor OFF — stand down, exactly as task 13 does
// =============================================================================

describe(' A2 — governed + LEGACY mode still stands the engine down', () => {
  it('tears the session down when there is no lane to run', async () => {
    const { service } = buildService({ graphEnabled: false, consultationMetadata: governedBy(GOVERNING_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();

    expect(service.isActive(CID)).toBe(false);
  });

  it('publishes NOTHING — no TEXT call, no NLP call', async () => {
    const { service, post } = buildService({ graphEnabled: false, consultationMetadata: governedBy(GOVERNING_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });

    expect(await service.flush(CID)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });
});

// =============================================================================
// (c) NOT governed + graph executor ON — the cascade, unchanged
// =============================================================================

describe(' A2 — an ungoverned consultation is untouched', () => {
  it('resolves the assignment cascade and documents the consultation', async () => {
    const { service, post, assignments, definitions } = buildService({ graphEnabled: true, consultationMetadata: null });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });
    const payload = await service.flush(CID);

    expect(assignments.resolve).toHaveBeenCalledWith(ARCAAI, 'consultation', null);
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, ASSIGNED_SLUG);
    expect(payload?.runningSummary).toContain('patient reports cough');
    expect(generateCalls(post)).toHaveLength(1);
    await service.stop(CID, { persistSnapshot: false });
  });
});

// =============================================================================
// (d) STRUCTURAL — a realtime lane cannot reach a durable writer, over the REAL configs
// =============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed');
/* eslint-disable @typescript-eslint/no-explicit-any */
const arcaai: any = await import(/* @vite-ignore */ `${SEED}/23-arcaai-workflow-authoring.generated.ts`);
const examples: any = await import(/* @vite-ignore */ `${SEED}/24-example-consultation-workflows.generated.ts`);

/** Every committed `consultation`-palette compiled config, by the export that carries it. */
const COMMITTED_CONSULTATION_CONFIGS: ReadonlyArray<readonly [string, unknown]> = [
  ['GEN_COMPILED_CONFIG', arcaai.GEN_COMPILED_CONFIG],
  ['RHEUM_COMPILED_CONFIG', arcaai.RHEUM_COMPILED_CONFIG],
  ['PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG', examples.PLATFORM_GRAMMAR_FIX_COMPILED_CONFIG],
  ['ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG', examples.ARCAAI_GRAMMAR_FIX_COMPILED_CONFIG],
  ['PLATFORM_MEDICAL_NER_COMPILED_CONFIG', examples.PLATFORM_MEDICAL_NER_COMPILED_CONFIG],
  ['ARCAAI_MEDICAL_NER_COMPILED_CONFIG', examples.ARCAAI_MEDICAL_NER_COMPILED_CONFIG],
  ['PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG', examples.PLATFORM_NER_GRAMMAR_FIX_COMPILED_CONFIG],
  ['ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG', examples.ARCAAI_NER_GRAMMAR_FIX_COMPILED_CONFIG],
];

/** The durable writers. `persistDraft` is the one names; the other two write too. */
const DURABLE_WRITERS = ['consultation.persistDraft', 'consultation.finalizeAssurance', 'consultation.synthesize'];

describe(' A2 — exclusivity holds BY CONSTRUCTION, not by the gate', () => {
  it.each(COMMITTED_CONSULTATION_CONFIGS)('%s: its realtime lane contains no durable writer', (_name, compiled) => {
    const lane = buildRealtimeLane(compiled as never);

    expect(lane).not.toBeNull();
    const types = lane!.stages.flatMap((stage) => stage.nodes.map((node) => node.type));
    expect(types.length).toBeGreaterThan(0);
    for (const writer of DURABLE_WRITERS) expect(types).not.toContain(writer);
  });

  it('the durable writers really are present in the graphs — the filter is doing work', () => {
    const declared = (compiled: any): string[] => (compiled.stages ?? []).flatMap((s: any) => (s.nodes ?? []).map((n: any) => n.type));

    for (const [name, compiled] of COMMITTED_CONSULTATION_CONFIGS) {
      expect(declared(compiled), `${name} declares no durable writer — the assertion above would be vacuous`).toEqual(
        expect.arrayContaining(['consultation.persistDraft']),
      );
    }
  });
});

// =============================================================================
// (e) stop() in graph mode — the durable run's INPUT is preserved, nothing legacy runs
// =============================================================================

describe(' A2 — stop() on a governed graph-mode session', () => {
  it('persists the LIVE_SOAP_SNAPSHOT the durable run warm-starts from', async () => {
    const { service, contextItemRepository } = buildService({
      graphEnabled: true,
      consultationMetadata: governedBy(GOVERNING_SLUG),
      governingConfig: FULL_CONFIG,
    });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });
    await service.flush(CID);
    await service.stop(CID, { persistSnapshot: true });

    // `livedoc.stop` is the durable run's FIRST endpoint action, and
    // `harness.finalize` reads this exact row as `preSummaryText`. It is the durable engine's
    // INPUT, not a second draft — which is why graph mode keeps writing it.
    expect(contextItemRepository.create).toHaveBeenCalled();
    const created = contextItemRepository.create.mock.calls[0][0] as { metaData?: Record<string, unknown> };
    expect(created.metaData?.subType).toBe('LIVE_SOAP_SNAPSHOT');
  });

  it('runs NO legacy finalization: an unwirable lane means stop() writes nothing at all', async () => {
    const { service, post, contextItemRepository } = buildService({
      graphEnabled: true,
      consultationMetadata: governedBy(GOVERNING_SLUG),
      governingConfig: UNWIRABLE_CONFIG,
    });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await settle();
    service.ingestSegment(CID, { text: 'patient reports cough and takes aspirin', isFinal: true, segmentId: 's1' });
    await service.stop(CID, { persistSnapshot: true });

    // The drain loop inside stop() is a `flush(force)` loop, so the fall-through guard is what
    // keeps a hardcoded note off a governed consultation at the one moment it matters most.
    expect(generateCalls(post)).toHaveLength(0);
    expect(contextItemRepository.create).not.toHaveBeenCalled();
    expect(contextItemRepository.update).not.toHaveBeenCalled();
  });
});
