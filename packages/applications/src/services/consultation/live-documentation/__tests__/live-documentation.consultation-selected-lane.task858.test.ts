/**
 * lane A (gap G1) — the REALTIME lane honours the consultation's own workflow selection.
 *
 * ## The defect
 *
 * lets a clinician choose `workflowDefinitionSlug` at session open. The choice is
 * authorized (`assertSelectableForConsultation`) and honoured by the DURABLE dispatcher, which
 * records it on the consultation. `resolveTenantLane` — the one function that decides which graph
 * the realtime executor walks — consulted ONLY `workflowAssignments.resolve(tenant, 'consultation',
 * department)`. So a clinician who selected workflow B got workflow A's realtime nodes: live NER,
 * partial summarization and grammar came from the tenant DEFAULT, silently, while
 * `GET /consultations/:id/workflow` reported B. seeds three selectable example
 * consultation workflows; without this they can never run live.
 *
 * ## Two recorded selections, and why both are read
 *
 * `governingEngine` requires a non-empty `workflowRunId`, so it exists only when the
 * durable dispatch SUCCEEDED. `workflowSelection` (this ticket) is written at consultation CREATE,
 * before and regardless of dispatch. They are read in that order.
 *
 * The interaction below is asserted rather than assumed, because it decides which of the two is
 * load-bearing in practice.
 *
 * AMENDED by lane A2: this used to read "a well-formed `governingEngine` marker ALSO
 * makes the substrate gate stand this whole engine down, so on a live session it is
 * `workflowSelection` that actually steers the lane". That relaxation of the gate has now
 * HAPPENED — it is mode-aware, so in GRAPH mode a governed session stays up and walks the
 * governing definition's realtime lane, and BOTH markers steer a live session. Only in LEGACY
 * mode (no lane) does a governing marker still stand the engine down.
 *
 * ## Fail-safe direction
 *
 * Every unresolvable selection — unpublished, foreign, wrong palette, no realtime nodes, an
 * unreadable row — falls back to the EXISTING cascade. Never to "no lane": a consultation
 * documented by the tenant default is a better clinical outcome than one documented by nothing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { GOVERNING_ENGINE_METADATA_KEY, TENANT_WORKFLOW_GOVERNS_MARKER } from '../../governing-engine';
import { WORKFLOW_SELECTION_METADATA_KEY } from '../../consultation/workflow-selection';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_GENERATED = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const seed: any = await import(/* @vite-ignore */ SEED_GENERATED);
const GEN_COMPILED_CONFIG = seed.GEN_COMPILED_CONFIG;
const RHEUM_COMPILED_CONFIG = seed.RHEUM_COMPILED_CONFIG;

const ARCAAI = '50000000-0000-0000-0000-000000000001';
const OTHER_TENANT = 'tenant-not-arcaai-858';
const CID = 'consultation-858-001';

/** The tenant DEFAULT — what the cascade resolves when nothing else speaks. */
const ASSIGNED_SLUG = 'arcaai-consultation-soap';
/** A DIFFERENT published consultation graph — what a clinician selects instead. */
const SELECTED_SLUG = 'arcaai-rheum-consultation-soap';
/** Published, visible to this tenant, but not a consultation-governing graph. */
const STT_SLUG = 'arcaai-transcription-agent';

const PUBLISHED_DEFINITIONS: Record<string, { slug: string; paletteKey: string; compiledConfig: unknown }> = {
  [ASSIGNED_SLUG]: { slug: ASSIGNED_SLUG, paletteKey: 'consultation', compiledConfig: GEN_COMPILED_CONFIG },
  [SELECTED_SLUG]: { slug: SELECTED_SLUG, paletteKey: 'consultation', compiledConfig: RHEUM_COMPILED_CONFIG },
  [STT_SLUG]: { slug: STT_SLUG, paletteKey: 'stt', compiledConfig: { slug: STT_SLUG, versionNumber: 1, stages: [] } },
};

/** Only the TENANT-scope row exists, so the cascade always answers `tenant` + the default slug. */
function assignmentServiceDouble() {
  return {
    resolve: vi.fn(
      async (tenantId: string, paletteKey: string): Promise<ResolvedWorkflowAssignment> =>
        tenantId === ARCAAI && paletteKey === 'consultation'
          ? { workflowDefinitionSlug: ASSIGNED_SLUG, source: 'tenant' }
          : { workflowDefinitionSlug: null, source: 'platform-default' },
    ),
  };
}

/** The real repository's contract: PUBLISHED + ACTIVE + this tenant, or nothing. */
function definitionRepositoryDouble() {
  return {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) => (tenantId === ARCAAI ? (PUBLISHED_DEFINITIONS[slug] ?? null) : null)),
  };
}

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
  frozenAt: '2026-08-28T00:00:00.000Z',
});

/** A well-formed marker — only written when the durable dispatch actually started a run. */
const governedBy = (slug: string) => ({
  [GOVERNING_ENGINE_METADATA_KEY]: {
    engine: TENANT_WORKFLOW_GOVERNS_MARKER,
    workflowRunId: 'run-858-1',
    workflowDefinitionSlug: slug,
    decidedAt: '2026-09-03T00:00:00.000Z',
  },
});

/** The selection marker — written at consultation CREATE, dispatch or no dispatch. */
const selected = (slug: string) => ({
  [WORKFLOW_SELECTION_METADATA_KEY]: { workflowDefinitionSlug: slug, selectedAt: '2026-09-03T00:00:00.000Z' },
});

interface BuildOpts {
  graphEnabled?: boolean;
  /** `Consultation.metadata` as stored on the row. */
  consultationMetadata?: unknown;
  /** The tenant that owns the consultation row (defaults to the caller's). */
  consultationTenantId?: string;
  /** No row at all for this id. */
  consultationMissing?: boolean;
  /** The consultation read throws. */
  consultationReadThrows?: boolean;
  /** Omit the consultation repository entirely (production DI may not supply it). */
  withoutConsultationRepository?: boolean;
}

function buildService(opts: BuildOpts = {}) {
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const redisSubscriber = { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() };
  const post = vi.fn().mockResolvedValue({ data: {} });

  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY
        ? { value: opts.graphEnabled ?? true, sourceScope: 'tenant' }
        : { value: undefined, sourceScope: 'code-default' },
    ),
  };

  const consultationRepository = {
    findById: vi.fn(async (id: string) => {
      if (opts.consultationReadThrows) throw new Error('consultation store unreachable');
      if (opts.consultationMissing) return null;
      return { id, tenantId: opts.consultationTenantId ?? ARCAAI, metadata: opts.consultationMetadata ?? null };
    }),
  };

  const assignments = assignmentServiceDouble();
  const definitions = definitionRepositoryDouble();

  const service = new LiveDocumentationService(
    { axiosRef: { post } } as never,
    configService as never,
    cacheMock() as never,
    redisSubscriber as never,
    undefined, // audioBridge
    undefined, // contextItemRepository
    { resolveTextSelection: vi.fn().mockResolvedValue({ provider: 'vllm', model: 'gemma' }) } as never,
    { encrypt: vi.fn(), decrypt: vi.fn(), getSecretOptional: vi.fn().mockResolvedValue('svc-token') } as never,
    undefined, // trajectoryService
    effectiveSettings as never,
    { resolveDefault: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    (opts.withoutConsultationRepository ? undefined : consultationRepository) as never,
    assignments as never,
    definitions as never,
  );

  return { service, assignments, definitions, consultationRepository };
}

// =============================================================================
// (a) the selection WINS over the cascade
// =============================================================================

describe(' G1 — the consultation’s own selection resolves the realtime lane', () => {
  it('a governing-engine marker naming a published consultation graph supplies the lane, not the tenant default', async () => {
    const { service, assignments, definitions } = buildService({ consultationMetadata: governedBy(SELECTED_SLUG) });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.laneSource).toBe('tenant-graph');
    expect(caps.definitionSlug).toBe(SELECTED_SLUG);
    expect(caps.assignmentSource).toBe('consultation');
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, SELECTED_SLUG);
    // The cascade is not consulted at all — consulting it and discarding the answer would put a
    // second, invisible slug in the logs for an operator to mistake for the one that ran.
    expect(assignments.resolve).not.toHaveBeenCalled();
  });

  it('the `workflowSelection` key does the same job when no durable run ever started', async () => {
    const { service, assignments } = buildService({ consultationMetadata: selected(SELECTED_SLUG) });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    // `workflowSelection` survives a failed dispatch (no run, so no `governingEngine` marker) and
    // this engine keeps running. Since the marker path steers a live session too, in
    // graph mode — but this is the path that works when the durable dispatch never started.
    expect(caps.assignmentSource).toBe('consultation');
    expect(caps.definitionSlug).toBe(SELECTED_SLUG);
    expect(assignments.resolve).not.toHaveBeenCalled();
  });

  it('reads `governingEngine` FIRST — what actually governs beats what was asked for', async () => {
    const { service } = buildService({
      consultationMetadata: { ...governedBy(SELECTED_SLUG), ...selected(ASSIGNED_SLUG) },
    });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.definitionSlug).toBe(SELECTED_SLUG);
  });

  it('carries the SELECTED graph’s realtime nodes, so the clinician gets the capabilities they chose', async () => {
    const { service } = buildService({ consultationMetadata: selected(SELECTED_SLUG) });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.nodes.length).toBeGreaterThan(0);
    expect(caps.nodes.some((n) => n.type === 'consultation.captureBinding')).toBe(true);
    // Never a durable node: two writers on one clinical document is the hazard the lane filter exists for.
    expect(caps.nodes.some((n) => n.type === 'consultation.persistDraft')).toBe(false);
  });
});

// =============================================================================
// (b) every unresolvable selection falls back to the EXISTING cascade
// =============================================================================

describe(' G1 — an unresolvable selection degrades to the cascade, never to no lane', () => {
  it('an UNPUBLISHED / unknown slug falls back to the tenant assignment', async () => {
    const { service, assignments } = buildService({ consultationMetadata: selected('slug-that-was-never-published') });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.assignmentSource).toBe('tenant');
    expect(caps.definitionSlug).toBe(ASSIGNED_SLUG);
    expect(assignments.resolve).toHaveBeenCalledWith(ARCAAI, 'consultation', null);
  });

  it('a FOREIGN tenant’s consultation row is not read across the boundary', async () => {
    const { service, definitions } = buildService({
      consultationMetadata: selected(SELECTED_SLUG),
      consultationTenantId: OTHER_TENANT,
    });

    // `getRealtimeCapabilities` refuses outright (below); the RESOLVER's own contract is that it
    // never lets another tenant's row choose this tenant's lane.
    await expect(service.getRealtimeCapabilities(ARCAAI, null, CID)).rejects.toThrow();
    expect(definitions.findPublishedBySlug).not.toHaveBeenCalledWith(ARCAAI, SELECTED_SLUG);
  });

  it('a WRONG-PALETTE slug falls back — an `stt` graph has no consultation nodes to run', async () => {
    const { service } = buildService({ consultationMetadata: selected(STT_SLUG) });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.assignmentSource).toBe('tenant');
    expect(caps.definitionSlug).toBe(ASSIGNED_SLUG);
  });

  it('an unreadable consultation row degrades a SESSION to the cascade rather than failing it', async () => {
    const { service, definitions, assignments } = buildService({ consultationReadThrows: true });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // The substrate gate fails open on an unreadable row, and so does this: a store
    // outage must cost the clinician the SELECTED graph, never the documentation.
    expect(assignments.resolve).toHaveBeenCalledWith(ARCAAI, 'consultation', null);
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, ASSIGNED_SLUG);
    await service.stop(CID, { persistSnapshot: false });
  });

  it('but the READ-OUT surfaces that outage instead of describing a lane it could not verify', async () => {
    const { service } = buildService({ consultationReadThrows: true });

    // An admin asking about one consultation gets the failure, not a confident answer to the
    // tenant-level question they did not ask.
    await expect(service.getRealtimeCapabilities(ARCAAI, null, CID)).rejects.toThrow('consultation store unreachable');
  });

  it('no consultation repository wired at all → the cascade, exactly as before', async () => {
    const { service } = buildService({ withoutConsultationRepository: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.assignmentSource).toBe('tenant');
    expect(caps.definitionSlug).toBe(ASSIGNED_SLUG);
  });
});

// =============================================================================
// (c) no selection — byte-for-byte today's behaviour
// =============================================================================

describe(' G1 — a consultation with no selection is unchanged', () => {
  it('resolves the cascade, and does not read the consultation when no id is supplied', async () => {
    const { service, consultationRepository } = buildService({ consultationMetadata: null });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    expect(caps.assignmentSource).toBe('tenant');
    expect(caps.definitionSlug).toBe(ASSIGNED_SLUG);
    expect(caps.consultationId).toBeNull();
    expect(consultationRepository.findById).not.toHaveBeenCalled();
  });

  it('a consultation with metadata but no marker of either kind resolves the cascade', async () => {
    const { service } = buildService({ consultationMetadata: { schedulingRef: 'ext-1' } });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.assignmentSource).toBe('tenant');
    expect(caps.definitionSlug).toBe(ASSIGNED_SLUG);
  });

  it('a MALFORMED selection reads as absent — an empty slug is not a selection', async () => {
    const { service } = buildService({ consultationMetadata: { [WORKFLOW_SELECTION_METADATA_KEY]: { workflowDefinitionSlug: '' } } });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.assignmentSource).toBe('tenant');
  });
});

// =============================================================================
// (d) the read-out is addressable per consultation, with the same 404 posture
// =============================================================================

describe('`GET admin/harness/live/capabilities?consultationId=` reports what THAT session would get', () => {
  it('echoes the consultation it resolved for', async () => {
    const { service } = buildService({ consultationMetadata: selected(SELECTED_SLUG) });

    const caps = await service.getRealtimeCapabilities(ARCAAI, null, CID);

    expect(caps.consultationId).toBe(CID);
    expect(caps.tenantId).toBe(ARCAAI);
  });

  it('an UNKNOWN consultation id is a 404, not a silent fall-through to the cascade', async () => {
    const { service } = buildService({ consultationMissing: true });

    await expect(service.getRealtimeCapabilities(ARCAAI, null, 'no-such-consultation')).rejects.toMatchObject({ status: 404 });
  });

  it('another tenant’s consultation id is the SAME 404 — existence is not disclosed', async () => {
    const { service } = buildService({ consultationTenantId: OTHER_TENANT, consultationMetadata: selected(SELECTED_SLUG) });

    await expect(service.getRealtimeCapabilities(ARCAAI, null, CID)).rejects.toMatchObject({ status: 404 });
  });

  it('with the graph executor OFF it still refuses an unknown consultation before describing anything', async () => {
    const { service } = buildService({ graphEnabled: false, consultationMissing: true });

    await expect(service.getRealtimeCapabilities(ARCAAI, null, CID)).rejects.toMatchObject({ status: 404 });
  });
});

// =============================================================================
// The SESSION path — the reason any of this matters
// =============================================================================

describe(' G1 — a live session freezes the SELECTED lane', () => {
  it('start() resolves the selected definition, not the tenant assignment', async () => {
    const { service, assignments, definitions } = buildService({ consultationMetadata: selected(SELECTED_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, SELECTED_SLUG);
    expect(assignments.resolve).not.toHaveBeenCalled();
    // `workflowSelection` alone does NOT stand this engine down — only a well-formed
    // `governingEngine` marker does. That is what makes the selection reachable here at all.
    expect(service.isActive(CID)).toBe(true);
    await service.stop(CID, { persistSnapshot: false });
  });

  /**
   * AMENDED by lane A2. This test previously asserted that a `governingEngine` marker
   * stands the WHOLE engine down on a live session, which made the marker path above serve only
   * the capabilities read-out. That premise was wrong once the graph executor was on: the
   * durable interpreter SKIPS every `lane: 'realtime'` node, so the stand-down left realtime NER
   * / partial summary / grammar running in neither engine. The gate is now MODE-AWARE — the two
   * tests below replace the one, and the full contract lives in
   * `live-documentation.governed-graph-mode.task858.test.ts`.
 */
  it('AMENDED (A2): in GRAPH mode a governing marker keeps the session and steers its lane', async () => {
    const { service, definitions, assignments } = buildService({ consultationMetadata: governedBy(SELECTED_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(service.isActive(CID)).toBe(true);
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, SELECTED_SLUG);
    expect(assignments.resolve).not.toHaveBeenCalled();
    await service.stop(CID, { persistSnapshot: false });
  });

  it('AMENDED (A2): with the graph executor OFF the marker still stands the whole engine down', async () => {
    const { service } = buildService({ graphEnabled: false, consultationMetadata: governedBy(SELECTED_SLUG) });

    service.start({ consultationId: CID, tenantId: ARCAAI });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // There is no lane in legacy mode, so the only thing this engine could run is the hardcoded
    // flush — which would write a second document beside the durable run's. task 13,
    // unchanged.
    expect(service.isActive(CID)).toBe(false);
  });
});
