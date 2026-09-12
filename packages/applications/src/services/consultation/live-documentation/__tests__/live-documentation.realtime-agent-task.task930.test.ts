/**
 * TASK-930 (G-1) — a slug-form `core.agent` on the realtime lane runs the capability its AGENT's
 * TASK implies, over the SEEDED `general-medicine-consultation` graph.
 *
 * ## The defect this suite exists for
 *
 * `RealtimeCapabilities.resolveAgent` is optional, and `LiveDocumentationService` did not
 * implement it. `CoreAgentHandler` therefore fell back to `TEXT_GENERATION` for EVERY slug-form
 * reference, which on the seeded graph means the ASR node and the NER node would each have
 * GENERATED A NOTE — three summarization calls per flush, no transcript, no entities — while
 * every read-out, trajectory and degrade reason called all three `generateDocument`. Nothing
 * failed; the lane just quietly did the wrong work.
 *
 * ## Why it is driven from the seed
 *
 * The graph is imported from `28-workflow-library.generated.ts` and the agents' tasks from
 * `25-agents.ts`, both BY COMPUTED PATH (neither package depends on the other — the same import
 * direction `live-documentation.realtime-capabilities.task852.test.ts` already uses). The
 * expected capability of each node is DERIVED from those two artifacts rather than written down
 * here, so this file cannot drift into testing its own idea of the seed: re-point `n_ner` at a
 * TEXT_GENERATION agent in the seed and the expectation moves with it.
 *
 * The request tenant is a CUSTOMER tenant, not SYSTEM: an agent is CONTENT, so a tenant runs its
 * own CLONES of the platform reference set under the same lineage slugs (`00-project-context.md`
 * §"Content is cloned; configuration cascades").
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { LiveDocSessionStatsResponse } from '../dto/live-doc-admin.dto';
import type { ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed');

/* eslint-disable @typescript-eslint/no-explicit-any */
const workflowSeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/28-workflow-library.generated.ts`);
const agentSeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/25-agents.ts`);

/** The committed compiled graph — the artifact the seeder writes, not a replica of it. */
const CONSULTATION_SLUG = 'general-medicine-consultation';
const CONSULTATION_GRAPH = workflowSeed.WORKFLOW_LIBRARY_GENERATED[`SYSTEM:${CONSULTATION_SLUG}`].compiledConfig;

/** slug → task, straight off the seeded agent catalogue (`25-agents.ts` §8.3). */
const TASK_BY_SLUG = new Map<string, string>(agentSeed.PLATFORM_AGENT_SPECS.map((spec: any) => [spec.slug, spec.task]));

/** INTERFACES §7.4 — the capability each agent task dispatches to on the realtime lane. */
const CAPABILITY_BY_TASK: Record<string, string> = {
  SPEECH_TO_TEXT: 'transcribe',
  NAMED_ENTITY_RECOGNITION: 'extractEntities',
  TEXT_GENERATION: 'generateDocument',
};

/** Every REALTIME `core.agent` of the seeded graph, with the capability its agent's task implies. */
const ALL_REALTIME_AGENT_NODES: Array<{ nodeId: string; slug: string; task: string; capability: string; cadence: string | undefined }> = (
  CONSULTATION_GRAPH.stages as any[]
)
  .flatMap((stage) => stage.nodes as any[])
  .filter((node) => node.type === 'core.agent' && node.config?.execution?.lane === 'realtime')
  .map((node) => {
    const slug = node.config.agentRef.slug as string;
    const task = TASK_BY_SLUG.get(slug);
    if (!task) throw new Error(`seed drift: the graph references agent '${slug}', which the seeded catalogue does not declare`);
    return {
      nodeId: node.nodeId as string,
      slug,
      task,
      capability: CAPABILITY_BY_TASK[task]!,
      cadence: node.config?.execution?.cadence as string | undefined,
    };
  });

/**
 * TASK-932 D-9 — the nodes a FLUSH walks, which is not every realtime node any more.
 *
 * `onStart` is the warm-start cadence: `buildRealtimeLane` partitions those nodes OUT of
 * `lane.stages` and into `lane.onStart`, because a node left in the flush lane runs once per
 * turn. This suite's subject is the per-flush dispatch, so its expectations are derived from the
 * per-turn half; {@link ON_START_NODES} is asserted separately below.
 */
const REALTIME_AGENT_NODES = ALL_REALTIME_AGENT_NODES.filter((node) => node.cadence !== 'onStart');
const ON_START_NODES = ALL_REALTIME_AGENT_NODES.filter((node) => node.cadence === 'onStart');

const TENANT = '50000000-0000-0000-0000-000000000001';
const CID = 'consultation-930-g1';
const NOTE = 'Subjective: cough for three days\nObjective:\nAssessment:\nPlan:';

const snapshot = (): FrozenLiveAgentSnapshot => ({
  resolvedFrom: 'agent',
  agentId: 'agent-1',
  agentName: 'Agent',
  promptTemplateId: 'tmpl-1',
  promptVersionNumber: 1,
  stableUserPrefix: 'PREFIX.',
  systemPrompt: 'SYSTEM.',
  toolPlan: DEFAULT_LIVE_TOOL_PLAN,
  frozenAt: '2026-09-08T00:00:00.000Z',
});

function cacheMock() {
  const stats: LiveDocSessionStatsResponse[] = [];
  return {
    stats,
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    setex: vi.fn(async (key: string, _ttl: number, raw: string) => {
      if (key.startsWith('live-doc:stats:')) stats.push(JSON.parse(raw) as LiveDocSessionStatsResponse);
    }),
    publish: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(undefined),
    eval: vi.fn().mockResolvedValue(1),
    sadd: vi.fn().mockResolvedValue(1),
    srem: vi.fn().mockResolvedValue(1),
    smembers: vi.fn().mockResolvedValue([]),
    expire: vi.fn().mockResolvedValue(true),
  };
}

/**
 * The tenant's own clones of the seeded agents. Only a PUBLISHED agent of the CALLER's tenant
 * resolves — an unknown / unpublished / cross-tenant slug is one 404, which is
 * `AgentResolverService`'s contract and the posture this lane must inherit.
 */
function agentResolverDouble(unresolvable: string[] = []) {
  return {
    resolve: vi.fn(async ({ tenantId, agentSlug }: { tenantId: string; agentSlug?: string | null }) => {
      const task = agentSlug && !unresolvable.includes(agentSlug) ? TASK_BY_SLUG.get(agentSlug) : undefined;
      if (tenantId !== TENANT || !agentSlug || !task) throw new NotFoundException('Agent not found');
      return { slug: agentSlug, versionNumber: 1, task, compiledConfig: { outputSchema: {}, parameters: {} } };
    }),
  };
}

/**
 * The TEXT_GENERATION half a `generateDocument` node needs (TASK-876). Present so the summary
 * node actually RUNS: this suite is about which capability each node dispatches to, and a summary
 * node that degraded for want of a text resolver would prove nothing about the ASR and NER ones.
 */
const textSpec = (): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: {
    kind: 'primary',
    agent: { slug: 'general-medicine-summarization', versionId: 'a1', versionNumber: 1, tenantId: TENANT, source: 'explicit' },
    modelSlug: 'lms-gemma-4-e2b-it-qat',
    provider: 'lm-studio',
    model: 'gemma-4-e2b-it-qat',
    resolvedPrompt: { source: 'inline', content: 'SUMMARIZE.' },
    instruction: { systemPrompt: 'SUMMARIZE.' },
    parameters: { generation: { temperature: 0.2, maxTokens: 2048 }, responseFormat: 'text' },
    tools: [],
    fundingTier: 'platform',
  },
  fallback: { autoSwitch: false, chain: [] },
});

function buildService(opts: { unresolvable?: string[]; withoutAgentResolver?: boolean } = {}) {
  const cache = cacheMock();
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [{ text: 'cough', label: 'SIGN_SYMPTOM', score: 0.9 }] } };
    if (url.includes('/generate')) return { data: { summary: NOTE, stats: { provider: 'echo', model: 'echo' } } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
  const configService = { get: vi.fn().mockImplementation((k: string) => env[k]) };
  const effectiveSettings = {
    resolveEffective: vi.fn(async (key: string) =>
      key === CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY ? { value: true, sourceScope: 'tenant' } : { value: undefined, sourceScope: 'code-default' },
    ),
  };
  const assignments = {
    resolve: vi.fn(async (): Promise<ResolvedWorkflowAssignment> => ({ workflowDefinitionSlug: CONSULTATION_SLUG, source: 'tenant' })),
  };
  const definitions = {
    findPublishedBySlug: vi.fn(async (tenantId: string, slug: string) =>
      tenantId === TENANT && slug === CONSULTATION_SLUG ? { slug, compiledConfig: CONSULTATION_GRAPH } : null,
    ),
  };
  const agentResolver = agentResolverDouble(opts.unresolvable ?? []);

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    configService as never,
    cache as never,
    { subscribeToChannel: vi.fn(), unsubscribeFromChannel: vi.fn() } as never,
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
    { findById: vi.fn(async () => ({ id: CID, tenantId: TENANT, metadata: null })) } as never,
    assignments as never,
    definitions as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    { resolve: vi.fn(async () => textSpec()) } as never, // textAgents
    undefined, // entitlements
    undefined, // usageLedger
    (opts.withoutAgentResolver ? undefined : agentResolver) as never,
  );

  return { service, post, cache, agentResolver };
}

const urls = (post: ReturnType<typeof vi.fn>) => post.mock.calls.map((call) => String(call[0]));
const countOf = (post: ReturnType<typeof vi.fn>, fragment: string) => urls(post).filter((url) => url.includes(fragment)).length;

/** ONE flush. The call counts are snapshotted BEFORE `stop()`, whose forced drain re-walks the lane. */
async function runOneFlush(service: LiveDocumentationService, post: ReturnType<typeof vi.fn>) {
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  const calls = { classify: countOf(post, '/classify/tokens'), generate: countOf(post, '/generate') };
  await service.stop(CID, { persistSnapshot: false });
  return { payload, calls };
}

describe('TASK-930 G-1 — the seeded consultation graph dispatches on the AGENT’s task', () => {
  it('the seed itself declares more than one task, so the derivation below is not a tautology', () => {
    expect(REALTIME_AGENT_NODES.map((node) => node.nodeId)).toEqual(['n_asr', 'n_ner', 'n_summary']);
    expect(new Set(REALTIME_AGENT_NODES.map((node) => node.capability)).size).toBeGreaterThan(1);
  });

  it('TASK-932 — the seed also declares a WARM START, and it is not one of the per-flush nodes', () => {
    // If this list is ever empty the two assertions below stop meaning anything, so it is checked
    // rather than assumed: the point of the partition is that `n_presummary` EXISTS and is
    // still absent from the flush lane.
    expect(ON_START_NODES.map((node) => node.nodeId)).toEqual(['n_presummary']);
    expect(ON_START_NODES[0]!.slug).toBe('case-notes-pre-summary');
    expect(REALTIME_AGENT_NODES.map((node) => node.nodeId)).not.toContain('n_presummary');
  });

  it('TASK-932 — the per-flush capability read-out describes the FLUSH lane, warm start excluded', async () => {
    const { service } = buildService();

    const caps = await service.getRealtimeCapabilities(TENANT);

    // `getRealtimeCapabilities` reports what a flush does. The warm start runs once, at session
    // open, so listing it here would tell an operator the lane makes an extra generation call on
    // every turn — which is exactly the thing the partition prevents.
    expect(caps.nodes.map((node) => node.nodeId).sort()).toEqual(REALTIME_AGENT_NODES.map((node) => node.nodeId).sort());
    expect(caps.nodes.map((node) => node.nodeId)).not.toContain('n_presummary');
  });

  it('the read-out reports each node’s capability as its seeded agent’s task implies', async () => {
    const { service, agentResolver } = buildService();

    const caps = await service.getRealtimeCapabilities(TENANT);
    const byNode = Object.fromEntries(caps.nodes.map((node) => [node.nodeId, node.canonicalType]));

    expect(caps.definitionSlug).toBe(CONSULTATION_SLUG);
    for (const node of REALTIME_AGENT_NODES) {
      expect(byNode[node.nodeId], `${node.nodeId} runs the ${node.slug} agent (${node.task})`).toBe(node.capability);
      // TASK-958 F11 — a read-out spends nothing, so an unusable credential binding must
      // not hide the agent: `mark` returns it without a `providerOverride`.
      expect(agentResolver.resolve).toHaveBeenCalledWith({ tenantId: TENANT, agentSlug: node.slug, primaryBinding: 'mark' });
    }
  });

  it('a flush TRANSCRIBES on the ASR node and EXTRACTS on the NER node — it does not generate three notes', async () => {
    const { service, post } = buildService();

    const { calls } = await runOneFlush(service, post);

    // Before this ticket: 3 `/generate` calls (one per `core.agent`) and 0 `/classify/tokens` —
    // the ASR and NER nodes each summarised the transcript instead of doing their own work.
    //
    // TASK-932: still ONE generation per flush with the warm start on the graph. A warm-start node
    // left in the flush lane would make this 2 — a second LLM call against the same 20 s live
    // budget, every turn.
    expect(calls).toEqual({ classify: 1, generate: 1 });
  });

  it('without the resolver every node generates — the defect this ticket fixed, pinned so it cannot return quietly', async () => {
    const { service, post } = buildService({ withoutAgentResolver: true });

    const { calls } = await runOneFlush(service, post);

    // THREE summarization calls for one flush and not a single entity extraction: the ASR node and
    // the NER node both took `CoreAgentHandler`'s documented TEXT_GENERATION fallback. This is the
    // RED the fix turns into `{ classify: 1, generate: 1 }` above.
    expect(calls).toEqual({ classify: 0, generate: REALTIME_AGENT_NODES.length });
  });

  it('an unresolvable slug DEGRADES the node with a named reason — it never silently generates', async () => {
    const { service, post, cache } = buildService({ unresolvable: ['medical-ner'] });

    const { calls } = await runOneFlush(service, post);

    const degrades = cache.stats.at(-1)?.nodeDegrades ?? [];
    const ner = degrades.find((degrade) => degrade.nodeId === 'n_ner');
    expect(ner, 'the unresolvable NER node degraded without naming itself').toBeDefined();
    expect(ner!.reason).toBeTruthy();
    // The whole point: a node whose agent will not resolve produces NOTHING, rather than falling
    // through to TEXT_GENERATION and writing a second note into the clinical document.
    expect(calls.classify).toBe(0);
    expect(calls.generate).toBeLessThanOrEqual(1);
  });
});
