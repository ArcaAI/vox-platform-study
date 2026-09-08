/**
 * TASK-932 — the REALTIME lane honours the seeded graph's visit-type `core.condition`.
 *
 * ## The defect, from the live stack (2026-09-09 05:39)
 *
 * `ARCAAI:arcaai-gen-consultation` splits its per-turn summary by visit type: `n_ner.out ->
 * n_visit.in` (a `core.condition` over `trigger.context.visit_type`), `n_visit.new_visit ->
 * n_summary_new`, `n_visit.revisit -> n_summary_revisit`, `n_visit.else -> n_summary_new`. Both
 * summary nodes are `execution: { lane: 'realtime', cadence: 'perTurn' }`.
 *
 * The durable interpreter skips the branch that was not taken (`_branch_skip` ->
 * `SKIPPED reason=branch_not_taken`). The realtime lane had no notion of a branch and ran BOTH,
 * so every flush made TWO text generations for ONE note — which, beside the warm start and the
 * guardrail judge, is what saturated the single local LM Studio into `503`s:
 *
 *     Realtime lane node degraded … nodeId n_summary_new      … 503
 *     Realtime lane node degraded … nodeId n_summary_revisit  … 503
 *
 * ## What this suite pins, and why from the seed
 *
 * The graph is imported from `29-arcaai-agents-and-workflows.generated.ts` BY COMPUTED PATH (the
 * same import direction `live-documentation.realtime-agent-task.task930.test.ts` already uses —
 * neither package depends on the other), so this file cannot drift into testing its own idea of
 * the graph. Re-author the split in the seed and these expectations move with it.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import { LiveDocumentationService } from '../live-documentation.service';
import { CONSULTATION_REALTIME_GRAPH_EXECUTOR_KEY } from '../../consultation-gates.constants';
import { DEFAULT_LIVE_TOOL_PLAN, type FrozenLiveAgentSnapshot } from '../live-agent.port';
import type { ResolvedTextGenerationSpec } from '../../../agent/text-generation-spec';
import type { ResolvedWorkflowAssignment } from '../../../workflow-assignment/IWorkflowAssignmentService';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED_DIR = path.resolve(HERE, '../../../../../../database/src/prisma/db_main/seed');

/* eslint-disable @typescript-eslint/no-explicit-any */
const arcaaiSeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/29-arcaai-agents-and-workflows.generated.ts`);
const platformAgentSeed: any = await import(/* @vite-ignore */ `${SEED_DIR}/25-agents.ts`);

const CONSULTATION_SLUG = 'arcaai-gen-consultation';
const CONSULTATION_GRAPH = arcaaiSeed.ARCAAI_GENERATED[`ARCAAI:${CONSULTATION_SLUG}`].compiledConfig;

/** slug -> task for the PLATFORM agents the graph reuses (ASR, NER). Everything else generates. */
const PLATFORM_TASK_BY_SLUG = new Map<string, string>(platformAgentSeed.PLATFORM_AGENT_SPECS.map((spec: any) => [spec.slug, spec.task]));

const NODES: any[] = (CONSULTATION_GRAPH.stages as any[]).flatMap((stage) => stage.nodes);
const nodeById = (nodeId: string) => NODES.find((node) => node.nodeId === nodeId);
const slugOf = (nodeId: string): string => nodeById(nodeId).config.agentRef.slug as string;

const NEW_VISIT_SLUG = slugOf('n_summary_new');
const REVISIT_SLUG = slugOf('n_summary_revisit');

const TENANT = '50000000-0000-0000-0000-000000000002';
const CID = 'consultation-932-branch';
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

const textSpec = (): ResolvedTextGenerationSpec => ({
  schemaVersion: 1,
  agent: {} as never,
  primary: {
    kind: 'primary',
    agent: { slug: NEW_VISIT_SLUG, versionId: 'a1', versionNumber: 1, tenantId: TENANT, source: 'explicit' },
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

/** `parentConsultationId` is the ONLY input: it is what `VisitTypeService` derives the visit from. */
function buildService(consultation: { parentConsultationId?: string | null } | null) {
  const cache = cacheMock();
  const post = vi.fn(async (url: string) => {
    if (url.includes('/classify/tokens')) return { data: { entities: [{ text: 'cough', label: 'SIGN_SYMPTOM', score: 0.9 }] } };
    if (url.includes('/generate')) return { data: { summary: NOTE, stats: { provider: 'echo', model: 'echo' } } };
    return { data: {} };
  });
  const env: Record<string, unknown> = { LIVE_DOC_MIN_INTERVAL_MS: '0' };
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
  // Which nodes RAN is read off this double: `CoreAgentHandler` resolves the agent of every node
  // it dispatches, and a branch-skipped node never reaches its handler.
  const agentResolver = {
    resolve: vi.fn(async ({ tenantId, agentSlug }: { tenantId: string; agentSlug?: string | null }) => {
      if (tenantId !== TENANT || !agentSlug) throw new NotFoundException('Agent not found');
      return {
        slug: agentSlug,
        versionNumber: 1,
        task: PLATFORM_TASK_BY_SLUG.get(agentSlug) ?? 'TEXT_GENERATION',
        compiledConfig: { outputSchema: {}, parameters: {} },
      };
    }),
  };

  const service = new LiveDocumentationService(
    { axiosRef: { post }, post } as never,
    { get: vi.fn().mockImplementation((k: string) => env[k]) } as never,
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
    { findById: vi.fn(async () => (consultation === null ? null : { id: CID, tenantId: TENANT, metadata: null, ...consultation })) } as never,
    assignments as never,
    definitions as never,
    undefined, // documentSectionRepository
    undefined, // promptTemplateRepository
    undefined, // liveAssist
    { resolve: vi.fn(async () => textSpec()) } as never, // textAgents
    undefined, // entitlements
    undefined, // usageLedger
    agentResolver as never,
  );

  return { service, post, agentResolver };
}

const generateCount = (post: ReturnType<typeof vi.fn>) => post.mock.calls.filter((call) => String(call[0]).includes('/generate')).length;
const resolvedSlugs = (agentResolver: { resolve: ReturnType<typeof vi.fn> }) =>
  agentResolver.resolve.mock.calls.map((call) => String((call[0] as { agentSlug?: string }).agentSlug));

async function runOneFlush(consultation: { parentConsultationId?: string | null } | null) {
  const { service, post, agentResolver } = buildService(consultation);
  service.start({ consultationId: CID, tenantId: TENANT });
  await new Promise((resolve) => setImmediate(resolve));
  service.ingestSegment(CID, { text: 'Patient reports cough for three days.', isFinal: true, segmentId: 's1' });
  const payload = await service.flush(CID);
  const observed = { generates: generateCount(post), slugs: resolvedSlugs(agentResolver) };
  await service.stop(CID, { persistSnapshot: false });
  return { payload, ...observed };
}

describe('TASK-932 — the seeded visit-type condition routes the realtime summary', () => {
  it('the seed really does split the summary, so the expectations below are not a tautology', () => {
    expect(nodeById('n_visit').type).toBe('core.condition');
    expect(nodeById('n_summary_new').branchGuards).toEqual([
      { fromNodeId: 'n_visit', handle: 'else' },
      { fromNodeId: 'n_visit', handle: 'new_visit' },
    ]);
    expect(nodeById('n_summary_revisit').branchGuards).toEqual([{ fromNodeId: 'n_visit', handle: 'revisit' }]);
    // BOTH are per-turn realtime nodes — which is exactly why an unguarded walk generated twice.
    for (const nodeId of ['n_summary_new', 'n_summary_revisit']) {
      expect(nodeById(nodeId).config.execution).toEqual({ lane: 'realtime', cadence: 'perTurn' });
    }
    expect(NEW_VISIT_SLUG).not.toBe(REVISIT_SLUG);
  });

  it('a NEW visit (no parent consultation) generates ONCE, on the new-visit agent', async () => {
    const { generates, slugs, payload } = await runOneFlush({ parentConsultationId: null });

    // Before this ticket: 2. One TEXT generation per turn is the whole point.
    expect(generates).toBe(1);
    expect(slugs).toContain(NEW_VISIT_SLUG);
    expect(slugs).not.toContain(REVISIT_SLUG);
    expect(payload?.runningSummary).toBeTruthy();
  });

  it('a REVISIT (the consultation has a parent) generates ONCE, on the revisit agent', async () => {
    const { generates, slugs, payload } = await runOneFlush({ parentConsultationId: 'consultation-previous' });

    expect(generates).toBe(1);
    expect(slugs).toContain(REVISIT_SLUG);
    expect(slugs).not.toContain(NEW_VISIT_SLUG);
    // The projection must read the node that RAN. `n_summary_new` is `skipped` and carries no
    // sections, and it is FIRST in the stage — taking the first match would publish an empty
    // note while the revisit branch succeeded beside it.
    expect(payload?.runningSummary).toBeTruthy();
    expect(payload?.textFailed).toBeFalsy();
  });

  it('an unreadable consultation falls through to `else` — one generation, the new-visit branch', async () => {
    const { generates, slugs } = await runOneFlush(null);

    expect(generates).toBe(1);
    expect(slugs).toContain(NEW_VISIT_SLUG);
    expect(slugs).not.toContain(REVISIT_SLUG);
  });
});
