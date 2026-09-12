/**
 * items 2 and 6 — the tenant lane RESOLVES, and an admin can SEE that it does.
 *
 * ## Why these two items are one suite
 *
 * Item 2 lands the `WorkflowAssignment` rows. Item 6 adds the read-out that reports which realtime
 * capabilities are live for a tenant. They are tested together because item 6's read-out is the
 * only public surface on which item 2's claim is observable: `laneSnapshot` is private session
 * state, and asserting the seed file's CONTENTS would prove only that a row was authored, not that
 * the runtime resolves it.
 *
 * So every assertion below runs the REAL resolution chain —
 *
 *   `WorkflowAssignment` cascade -> `findPublishedBySlug` -> `buildRealtimeLane`
 *
 * — over the REAL committed compiled config, imported from `packages/database` BY COMPUTED PATH.
 * That import direction mirrors what `task-821-realtime-lane-seeding.test.ts` already does in
 * reverse (it reaches into `packages/applications` for `buildRealtimeLane`) and for the same
 * stated reason: neither package depends on the other, and replicating the artifact here would
 * test this file's idea of the seed rather than the seed.
 *
 * ## The two properties that were actually false
 *
 *  - **Nothing asserted that an assignment produces a TENANT lane.** `buildRealtimeLane` was
 *    covered with synthetic inputs and `task-821` covered the committed artifact's stages, but no
 *    test drove the assignment cascade or the definition lookup. A definition that failed to
 *    resolve — wrong slug, unpublished, cross-tenant — would fall back to `PLATFORM_REALTIME_LANE`
 *    SILENTLY, which is the one failure this whole activation cannot afford: it looks exactly like
 *    success (a note is still produced) while the tenant's authored graph governs nothing.
 *  - **Activation was unobservable.** The lane source, definition slug/version and per-node enabled
 *    state existed only in a log line at `start()`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_GENERATED = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed/29-arcaai-agents-and-workflows.generated.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const seed: any = await import(/* @vite-ignore */ SEED_GENERATED);
// TASK-930 §8.5 — the ArcaAI set is GENERATED from the department x visit-type table into one
// slug-keyed blob map, replacing the per-workflow `*_COMPILED_CONFIG` constants seed 23/24 exported.
const GEN_COMPILED_CONFIG = seed.ARCAAI_GENERATED['ARCAAI:arcaai-gen-consultation'].compiledConfig;
const RHEUM_COMPILED_CONFIG = seed.ARCAAI_GENERATED['ARCAAI:arcaai-rheum-consultation'].compiledConfig;

/** The ArcaAI customer tenant the seeded assignments bind. */
const ARCAAI = '50000000-0000-0000-0000-000000000001';
/** A tenant with no `consultation` assignment of any kind. */
const UNASSIGNED = 'tenant-no-assignment-852';

/**
 * The two seeded rows, as `ARCAAI_WORKFLOW_ASSIGNMENTS` declares them. Held as data here rather
 * than imported so the double below can run the CASCADE (department override beats tenant
 * default) instead of returning a canned answer — the cascade order is part of what item 2 claims.
 */
const SEEDED_ASSIGNMENTS = [
  { tenantId: ARCAAI, scope: 'TENANT' as const, scopeId: null as string | null, paletteKey: 'core', slug: 'arcaai-gen-consultation' },
  {
    tenantId: ARCAAI,
    scope: 'DEPARTMENT' as const,
    scopeId: '70000000-0000-0000-0001-000000000011' as string | null,
    paletteKey: 'core',
    slug: 'arcaai-rheum-consultation',
  },
];

const PUBLISHED_DEFINITIONS: Record<string, { slug: string; compiledConfig: unknown }> = {
  'arcaai-gen-consultation': { slug: 'arcaai-gen-consultation', compiledConfig: GEN_COMPILED_CONFIG },
  'arcaai-rheum-consultation': { slug: 'arcaai-rheum-consultation', compiledConfig: RHEUM_COMPILED_CONFIG },
};

/** `department override -> tenant default -> platform default`, over the SEEDED rows. */
function assignmentServiceDouble() {
  return {
    resolve: vi.fn(async (tenantId: string, paletteKey: string, departmentId?: string | null): Promise<ResolvedWorkflowAssignment> => {
      const scoped = SEEDED_ASSIGNMENTS.filter((a) => a.tenantId === tenantId && a.paletteKey === paletteKey);
      const dept = departmentId ? scoped.find((a) => a.scope === 'DEPARTMENT' && a.scopeId === departmentId) : undefined;
      if (dept) return { workflowDefinitionSlug: dept.slug, source: 'department' };
      const tenant = scoped.find((a) => a.scope === 'TENANT');
      if (tenant) return { workflowDefinitionSlug: tenant.slug, source: 'tenant' };
      return { workflowDefinitionSlug: null, source: 'platform-default' };
    }),
  };
}

/** Only a PUBLISHED definition of the CALLER's tenant resolves — the real repository's contract. */
function definitionRepositoryDouble() {
  return {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) => {
      if (tenantId !== ARCAAI) return null;
      return PUBLISHED_DEFINITIONS[slug] ?? null;
    }),
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

/**
 * TASK-930 (G-1) — the tasks of the agents the seeded ArcaAI graphs reference, as
 * `25-agents.ts` / `29-arcaai-agents-and-workflows.ts` declare them. Held as data here (the
 * seed-driven proof lives in `live-documentation.realtime-agent-task.task930.test.ts`) so this
 * suite keeps testing the READ-OUT rather than the catalogue.
 */
const SEEDED_AGENT_TASKS: Record<string, string> = {
  'realtime-transcription': 'SPEECH_TO_TEXT',
  'medical-ner': 'NAMED_ENTITY_RECOGNITION',
  'arcaai-gen-summary-new-visit': 'TEXT_GENERATION',
  'arcaai-gen-summary-revisit': 'TEXT_GENERATION',
  'arcaai-rheum-summary-new-visit': 'TEXT_GENERATION',
  'arcaai-rheum-summary-revisit': 'TEXT_GENERATION',
  'casenote-finalization': 'TEXT_GENERATION',
};

/** Only a PUBLISHED agent of the CALLER's tenant resolves — `AgentResolverService`'s contract. */
function agentResolverDouble() {
  return {
    resolve: vi.fn(async ({ tenantId, agentSlug }: { tenantId: string; agentSlug?: string | null }) => {
      const task = agentSlug ? SEEDED_AGENT_TASKS[agentSlug] : undefined;
      if (tenantId !== ARCAAI || !agentSlug || !task) throw new Error('Agent not found');
      return { slug: agentSlug, versionNumber: 1, task, compiledConfig: { outputSchema: {}, parameters: {} } };
    }),
  };
}

interface BuildOpts {
  graphEnabled?: boolean;
  /** Omit the two lane-resolution hops entirely (production DI may not supply them). */
  withoutLaneHops?: boolean;
  /** Make the assignment cascade throw. */
  assignmentThrows?: boolean;
  /** Omit the agent resolver, as a composition that predates TASK-930 would. */
  withoutAgentResolver?: boolean;
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

  const assignments = assignmentServiceDouble();
  if (opts.assignmentThrows) {
    assignments.resolve = vi.fn(async () => {
      throw new Error('assignment store unreachable');
    });
  }
  const definitions = definitionRepositoryDouble();
  const agentResolver = agentResolverDouble();

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
    { findById: vi.fn(async () => ({ id: 'c1', metadata: null })) } as never,
    (opts.withoutLaneHops ? undefined : assignments) as never,
    (opts.withoutLaneHops ? undefined : definitions) as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    undefined, // textAgents
    undefined, // entitlements
    undefined, // usageLedger
    (opts.withoutAgentResolver ? undefined : agentResolver) as never,
  );

  return { service, assignments, definitions, agentResolver };
}

// =============================================================================
// Item 2 — the seeded assignment RESOLVES to a tenant lane
// =============================================================================

describe(' item 2 — the ArcaAI assignment resolves to a TENANT lane, not the platform fallback', () => {
  it('reports `tenant-graph` with the assigned slug and version — the whole point of landing the rows', async () => {
    const { service, assignments, definitions } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    // The failure this asserts against is SILENT: a lane that fell back to the platform default
    // still produces a note, so only the source distinguishes "authoring governs the live plane"
    // from "authoring governs nothing".
    expect(caps.laneSource).toBe('tenant-graph');
    expect(caps.definitionSlug).toBe('arcaai-gen-consultation');
    expect(caps.definitionVersionNumber).toBe(1);
    expect(caps.assignmentSource).toBe('tenant');

    // And it got there by WALKING the chain, not by reading a constant.
    expect(assignments.resolve).toHaveBeenCalledWith(ARCAAI, 'core', null);
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, 'arcaai-gen-consultation');
  });

  it('carries the realtime nodes the seeded graph authors, and no durable ones', async () => {
    const { service, agentResolver } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    // TASK-893 — every realtime node is a `core.agent` now, so the TYPE no longer distinguishes
    // them and the read-out's discriminators are the node id and the CAPABILITY it runs.
    expect(caps.nodes.map((n) => n.nodeId).sort()).toEqual(['n_asr', 'n_ner', 'n_summary_new', 'n_summary_revisit']);
    expect([...new Set(caps.nodes.map((n) => n.type))]).toEqual(['core.agent']);
    // TASK-930 (G-1) — the capability is derived from the node's `agentRef`, and a SLUG-form ref
    // needs the HOST to resolve the agent's task. Until this ticket `resolveAgent` was
    // unimplemented, so every node read (and RAN) as `generateDocument` — the ASR node would have
    // generated a note instead of transcribing, and the NER node instead of extracting. The
    // read-out now reports what the lane actually dispatches.
    const byNode = Object.fromEntries(caps.nodes.map((n) => [n.nodeId, n.canonicalType]));
    expect(byNode).toEqual({
      n_asr: 'transcribe',
      n_ner: 'extractEntities',
      n_summary_new: 'generateDocument',
      n_summary_revisit: 'generateDocument',
    });
    // …and it got there by RESOLVING each referenced agent for THIS tenant, not by reading the slug.
    expect(agentResolver.resolve).toHaveBeenCalledWith({ tenantId: ARCAAI, agentSlug: 'realtime-transcription', primaryBinding: 'mark' });
    expect(agentResolver.resolve).toHaveBeenCalledWith({ tenantId: ARCAAI, agentSlug: 'medical-ner', primaryBinding: 'mark' });
    // `n_finalize` is `execution.lane: 'durable'` and must never appear here — a node running on
    // BOTH engines would mean two writers on one clinical document.
    expect(caps.nodes.some((n) => n.nodeId === 'n_finalize')).toBe(false);
  });

  it('falls back to `generateDocument` when no agent resolver is wired — the pre-TASK-930 answer, and never a throw', async () => {
    const { service } = buildService({ graphEnabled: true, withoutAgentResolver: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    // The read-out DESCRIBES what would run. Without a resolver `CoreAgentHandler` falls back to
    // TEXT_GENERATION, so reporting anything else here would describe a lane that does not exist.
    expect([...new Set(caps.nodes.map((n) => n.canonicalType))]).toEqual(['generateDocument']);
  });

  it('a DEPARTMENT override wins over the tenant default, so the cascade is real', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI, '70000000-0000-0000-0001-000000000011');

    expect(caps.assignmentSource).toBe('department');
    expect(caps.definitionSlug).toBe('arcaai-rheum-consultation');
    expect(caps.laneSource).toBe('tenant-graph');
  });
});

// =============================================================================
// Item 6 — the read-out is honest in every direction
// =============================================================================

describe(' item 6 — the read-out reports REAL state, including when there is none', () => {
  it('a tenant with NO assignment gets the platform lane, named as such — not a tenant lane it does not have', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(UNASSIGNED);

    expect(caps.graphExecutorEnabled).toBe(true);
    expect(caps.laneSource).toBe('platform-default');
    expect(caps.definitionSlug).toBeNull();
    expect(caps.definitionVersionNumber).toBeNull();
    expect(caps.assignmentSource).toBe('platform-default');
    // The platform lane genuinely runs, so reporting its nodes is the honest answer — an empty
    // list here would claim nothing executes, which is false.
    expect(caps.nodes.map((n) => n.nodeId).sort()).toEqual(['capture', 'extract', 'summarize']);
    expect([...new Set(caps.nodes.map((n) => n.type))]).toEqual(['core.agent']);
  });

  it('with the kill-switch OFF there is NO lane, and it says so rather than describing one', async () => {
    const { service } = buildService({ graphEnabled: false });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    // This is the state the whole ticket exists to change, so the read-out has to be able to
    // express it. Describing a lane here would tell an admin the graph governs a consultation
    // when the LEGACY engine is what actually runs.
    expect(caps.graphExecutorEnabled).toBe(false);
    expect(caps.laneSource).toBeNull();
    expect(caps.nodes).toEqual([]);
    expect(caps.definitionSlug).toBeNull();
  });

  it('reports per-node enabled state and which nodes may be toggled at all', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);
    const byNode = Object.fromEntries(caps.nodes.map((n) => [n.nodeId, n]));

    // Nothing in the seeded graph authors `enabled: false`, so every node is live.
    expect(caps.nodes.every((n) => n.enabled)).toBe(true);

    // `togglable` is DERIVED from the node's config schema, which is why this line changed with
    // TASK-890 D-1 rather than being re-decided here: items 3-4 withheld `enabled` from every
    // registry-class `mandatory` type, and the owner then decided the guardrail opt-out extends
    // to those nodes (§3.14a). `consultation.captureBinding` therefore OFFERS the toggle now, and
    // the read-out reporting it is correct — it advertises exactly what the publish-time
    // validator accepts, which is the property this assertion has always been about. The two
    // GRAPH BOUNDARIES (`core.trigger`, `core.output`) are what still withhold it, and neither
    // appears in a realtime lane's node list.
    expect(byNode['n_asr'].togglable).toBe(true);
    expect(byNode['n_ner'].togglable).toBe(true);
    expect(byNode['n_summary_new'].togglable).toBe(true);
    expect(byNode['n_summary_revisit'].togglable).toBe(true);
  });

  it('honours an authored `enabled: false` — the item 3/4 toggle, seen from the read-out', async () => {
    const { service, definitions } = buildService({ graphEnabled: true });
    // Author the toggle the way a tenant would: on the node's own config in the compiled graph.
    const withDisabledFindings = JSON.parse(JSON.stringify(GEN_COMPILED_CONFIG));
    for (const stage of withDisabledFindings.stages) {
      for (const node of stage.nodes) {
        if (node.nodeId === 'n_ner') node.config = { ...node.config, enabled: false };
      }
    }
    definitions.findPublishedBySlug = vi.fn(async () => ({ slug: 'arcaai-gen-consultation', compiledConfig: withDisabledFindings }));

    const caps = await service.getRealtimeCapabilities(ARCAAI);
    const findings = caps.nodes.find((n) => n.nodeId === 'n_ner');

    expect(findings?.enabled).toBe(false);
    // Still LISTED. A disabled node that vanished from the read-out would be indistinguishable
    // from one the tenant never authored, and an admin could not turn it back on.
    expect(findings).toBeDefined();
  });

  it('degrades to the platform lane when the assignment store is unreachable — never throws', async () => {
    const { service } = buildService({ graphEnabled: true, assignmentThrows: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    expect(caps.laneSource).toBe('platform-default');
    expect(caps.definitionSlug).toBeNull();
  });

  it('reports the platform lane when the lane-resolution hops are not wired at all', async () => {
    const { service } = buildService({ graphEnabled: true, withoutLaneHops: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    expect(caps.laneSource).toBe('platform-default');
    expect(caps.nodes).toHaveLength(3);
  });

  it('is tenant-scoped: the same call for another tenant cannot read ArcaAI’s graph', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(UNASSIGNED);

    expect(caps.tenantId).toBe(UNASSIGNED);
    expect(caps.definitionSlug).toBeNull();
  });
});
