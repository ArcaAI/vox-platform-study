/**
 * TASK-852 items 2 and 6 — the tenant lane RESOLVES, and an admin can SEE that it does.
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
const SEED_GENERATED = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed/23-arcaai-workflow-authoring.generated.ts');

/* eslint-disable @typescript-eslint/no-explicit-any */
const seed: any = await import(/* @vite-ignore */ SEED_GENERATED);
const GEN_COMPILED_CONFIG = seed.GEN_COMPILED_CONFIG;
const RHEUM_COMPILED_CONFIG = seed.RHEUM_COMPILED_CONFIG;

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
  { tenantId: ARCAAI, scope: 'TENANT' as const, scopeId: null as string | null, paletteKey: 'consultation', slug: 'arcaai-consultation-soap' },
  {
    tenantId: ARCAAI,
    scope: 'DEPARTMENT' as const,
    scopeId: '70000000-0000-0000-0001-000000000011' as string | null,
    paletteKey: 'consultation',
    slug: 'arcaai-rheum-consultation-soap',
  },
];

const PUBLISHED_DEFINITIONS: Record<string, { slug: string; compiledConfig: unknown }> = {
  'arcaai-consultation-soap': { slug: 'arcaai-consultation-soap', compiledConfig: GEN_COMPILED_CONFIG },
  'arcaai-rheum-consultation-soap': { slug: 'arcaai-rheum-consultation-soap', compiledConfig: RHEUM_COMPILED_CONFIG },
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
  liveLlm: null,
  frozenAt: '2026-08-28T00:00:00.000Z',
});

interface BuildOpts {
  graphEnabled?: boolean;
  /** Omit the two lane-resolution hops entirely (production DI may not supply them). */
  withoutLaneHops?: boolean;
  /** Make the assignment cascade throw. */
  assignmentThrows?: boolean;
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
    { getEffective: vi.fn().mockResolvedValue({ model: { sourceUri: 'blaze999/Medical-NER' } }) } as never,
    { run: vi.fn((cb: () => unknown) => cb()), set: vi.fn(), get: vi.fn() } as never,
    { resolveForSession: vi.fn().mockResolvedValue(snapshot()) } as never,
    undefined, // textRequestEnrichment
    undefined, // documentTemplateService
    { findById: vi.fn(async () => ({ id: 'c1', metadata: null })) } as never,
    (opts.withoutLaneHops ? undefined : assignments) as never,
    (opts.withoutLaneHops ? undefined : definitions) as never,
  );

  return { service, assignments, definitions };
}

// =============================================================================
// Item 2 — the seeded assignment RESOLVES to a tenant lane
// =============================================================================

describe('TASK-852 item 2 — the ArcaAI assignment resolves to a TENANT lane, not the platform fallback', () => {
  it('reports `tenant-graph` with the assigned slug and version — the whole point of landing the rows', async () => {
    const { service, assignments, definitions } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    // The failure this asserts against is SILENT: a lane that fell back to the platform default
    // still produces a note, so only the source distinguishes "authoring governs the live plane"
    // from "authoring governs nothing".
    expect(caps.laneSource).toBe('tenant-graph');
    expect(caps.definitionSlug).toBe('arcaai-consultation-soap');
    expect(caps.definitionVersionNumber).toBe(1);
    expect(caps.assignmentSource).toBe('tenant');

    // And it got there by WALKING the chain, not by reading a constant.
    expect(assignments.resolve).toHaveBeenCalledWith(ARCAAI, 'consultation', null);
    expect(definitions.findPublishedBySlug).toHaveBeenCalledWith(ARCAAI, 'arcaai-consultation-soap');
  });

  it('carries the five realtime node types the seeded graph authors, and no durable ones', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI);

    expect(caps.nodes.map((n) => n.type).sort()).toEqual([
      'agent.grammar',
      'agent.important_findings',
      'consultation.captureBinding',
      'consultation.extractEntities',
      'consultation.realtimeSummary',
    ]);
    // `consultation.persistDraft` is `lane: 'durable'` and must never appear here — it is the node
    // whose presence in BOTH engines would mean two writers on one clinical document.
    expect(caps.nodes.some((n) => n.type === 'consultation.persistDraft')).toBe(false);
  });

  it('a DEPARTMENT override wins over the tenant default, so the cascade is real', async () => {
    const { service } = buildService({ graphEnabled: true });

    const caps = await service.getRealtimeCapabilities(ARCAAI, '70000000-0000-0000-0001-000000000011');

    expect(caps.assignmentSource).toBe('department');
    expect(caps.definitionSlug).toBe('arcaai-rheum-consultation-soap');
    expect(caps.laneSource).toBe('tenant-graph');
  });
});

// =============================================================================
// Item 6 — the read-out is honest in every direction
// =============================================================================

describe('TASK-852 item 6 — the read-out reports REAL state, including when there is none', () => {
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
    expect(caps.nodes.map((n) => n.type).sort()).toEqual([
      'consultation.captureBinding',
      'consultation.extractEntities',
      'consultation.realtimeSummary',
    ]);
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
    const byType = Object.fromEntries(caps.nodes.map((n) => [n.type, n]));

    // Nothing in the seeded graph authors `enabled: false`, so every node is live.
    expect(caps.nodes.every((n) => n.enabled)).toBe(true);

    // `captureBinding` is registry-class `mandatory`: items 3-4 deliberately withheld `enabled`
    // from its config schema. A read-out that showed it as togglable would advertise a switch the
    // publish-time validator rejects.
    expect(byType['consultation.captureBinding'].togglable).toBe(false);
    expect(byType['consultation.realtimeSummary'].togglable).toBe(true);
    expect(byType['agent.important_findings'].togglable).toBe(true);
    expect(byType['agent.grammar'].togglable).toBe(true);
  });

  it('honours an authored `enabled: false` — the item 3/4 toggle, seen from the read-out', async () => {
    const { service, definitions } = buildService({ graphEnabled: true });
    // Author the toggle the way a tenant would: on the node's own config in the compiled graph.
    const withDisabledFindings = JSON.parse(JSON.stringify(GEN_COMPILED_CONFIG));
    for (const stage of withDisabledFindings.stages) {
      for (const node of stage.nodes) {
        if (node.type === 'agent.important_findings') node.config = { ...node.config, enabled: false };
      }
    }
    definitions.findPublishedBySlug = vi.fn(async () => ({ slug: 'arcaai-consultation-soap', compiledConfig: withDisabledFindings }));

    const caps = await service.getRealtimeCapabilities(ARCAAI);
    const findings = caps.nodes.find((n) => n.type === 'agent.important_findings');

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
