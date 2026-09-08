/**
 * TASK-932 — the REALTIME lane honours `core.condition` branch guards.
 *
 * The defect this file pins: a seeded consultation graph splits its per-turn summary by visit
 * type (`n_ner.out -> n_visit.in`, a `core.condition`, then `n_visit.new_visit ->
 * n_summary_new.after` / `n_visit.revisit -> n_summary_revisit.after` / `n_visit.else ->
 * n_summary_new.after`), and BOTH summary nodes carry `execution: { lane: 'realtime' }`. The
 * durable interpreter skips the branch that was not taken (`_branch_skip` ->
 * `SKIPPED reason=branch_not_taken`); the realtime lane ran BOTH, which is two TEXT generations
 * per turn for one note — the 503s observed on the live stack, 2026-09-09 05:39.
 */
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { buildRealtimeLane } from '../realtime-lane';
import { runRealtimeLane } from '../realtime-executor';
import type { RealtimeCapabilities } from '../realtime-node-registry';

const CID = 'consultation-932';
const TENANT = 'tenant-932';

const REALTIME = { lane: 'realtime', cadence: 'perTurn' };

interface FixtureNode {
  nodeId: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Array<{ fromNodeId: string; fromPort: string; toPort: string }>;
  branchGuards?: Array<{ fromNodeId: string; handle: string }>;
}

/** A compiled config with one stage per array — the shape `buildRealtimeLane` reads. */
function compiled(stages: FixtureNode[][]) {
  return {
    formatVersion: 1 as const,
    definitionId: 'd',
    slug: 'arcaai-gen-consultation',
    versionNumber: 1,
    tenantId: TENANT,
    paletteKey: 'core',
    compiledAt: 'x',
    compilerVersion: '0',
    registryChecksum: 'r',
    ruleSetVersion: 1,
    stages: stages.map((nodes, stageIndex) => ({
      stageIndex,
      nodes: nodes.map((n) => ({
        nodeId: n.nodeId,
        type: n.type,
        activity: WORKFLOW_NODE_REGISTRY[n.type]?.activityName ?? 'x',
        config: n.config ?? {},
        timeoutSeconds: 10,
        retry: { maximumAttempts: 1, initialIntervalSeconds: 1, backoffCoefficient: 2 },
        inputs: n.inputs ?? [],
        onError: 'degrade' as const,
        emitsTrajectory: true as const,
        ...(n.branchGuards ? { branchGuards: n.branchGuards } : {}),
      })),
    })),
    gates: [],
    policyBindings: {
      guardrailProfile: 'STANDARD' as const,
      redactionRuleSetId: null,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: null,
      entitlementKeys: [],
    },
    caps: { maxTotalSeconds: 1, maxNodeSeconds: 1, maxAttempts: 1 },
    checksum: 'c',
  };
}

/**
 * The SEEDED shape (`seed/28-workflow-library.ts` `buildConsultationGraph`, the `condition`
 * summarizer): NER, then a visit-type condition, then two guarded realtime summary nodes.
 */
const SEEDED_STAGES: FixtureNode[][] = [
  [{ nodeId: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'whisper' }, execution: REALTIME } }],
  [
    {
      nodeId: 'n_ner',
      type: 'core.agent',
      config: { agentRef: { slug: 'medical-ner' }, execution: REALTIME },
      inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }],
    },
  ],
  [
    {
      nodeId: 'n_visit',
      type: 'core.condition',
      config: {
        branches: [
          { key: 'new_visit', label: 'New / referral visit', when: "trigger.context.visit_type == 'new-visit'" },
          { key: 'revisit', label: 'Follow-up visit', when: "trigger.context.visit_type == 'revisit'" },
        ],
      },
      inputs: [{ fromNodeId: 'n_ner', fromPort: 'out', toPort: 'in' }],
    },
  ],
  [
    {
      nodeId: 'n_summary_new',
      type: 'core.agent',
      config: { agentRef: { slug: 'gen-new-visit' }, execution: REALTIME },
      inputs: [{ fromNodeId: 'n_ner', fromPort: 'out', toPort: 'in' }],
      branchGuards: [
        { fromNodeId: 'n_visit', handle: 'else' },
        { fromNodeId: 'n_visit', handle: 'new_visit' },
      ],
    },
    {
      nodeId: 'n_summary_revisit',
      type: 'core.agent',
      config: { agentRef: { slug: 'gen-revisit' }, execution: REALTIME },
      inputs: [{ fromNodeId: 'n_ner', fromPort: 'out', toPort: 'in' }],
      branchGuards: [{ fromNodeId: 'n_visit', handle: 'revisit' }],
    },
  ],
];

const seededLane = () => buildRealtimeLane(compiled(SEEDED_STAGES))!;

function capabilities(generated: string[]): RealtimeCapabilities {
  return {
    transcribe: vi.fn().mockResolvedValue({ transcript: 'raw', pipelineId: null }),
    extractEntities: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }] }),
    generateDocument: vi.fn(async (input) => {
      generated.push(input.agentRef && 'slug' in input.agentRef ? String(input.agentRef.slug) : 'unknown');
      return { text: `note from ${input.sourceText}`, sections: [], stats: null, repaired: false };
    }),
    proposeCorrections: vi.fn(),
    extractFindings: vi.fn(),
    // The seeded NER node names a NER agent; every other node falls back to TEXT_GENERATION.
    resolveAgent: vi.fn(async (ref) => {
      const slug = String((ref as { slug?: string }).slug);
      if (slug === 'medical-ner') return { slug, task: 'NAMED_ENTITY_RECOGNITION' as const };
      if (slug === 'whisper') return { slug, task: 'SPEECH_TO_TEXT' as const };
      return { slug, task: 'TEXT_GENERATION' as const };
    }),
  } as unknown as RealtimeCapabilities;
}

const runWith = (visitType?: string, generated: string[] = []) =>
  runRealtimeLane({
    lane: seededLane(),
    consultationId: CID,
    tenantId: TENANT,
    capabilities: capabilities(generated),
    ...(visitType === undefined ? {} : { runContext: { trigger: { context: { visit_type: visitType } }, vars: {}, nodes: {} } }),
  });

// ---------------------------------------------------------------------------
// 1 — the lane KEEPS what it needs to decide
// ---------------------------------------------------------------------------

describe('buildRealtimeLane keeps the branch guards and the conditions they name', () => {
  it('carries each guarded node`s branchGuards verbatim', () => {
    const lane = seededLane();
    const summaries = lane.stages.flatMap((stage) => stage.nodes).filter((node) => node.nodeId.startsWith('n_summary'));

    expect(summaries.find((n) => n.nodeId === 'n_summary_new')?.branchGuards).toEqual([
      { fromNodeId: 'n_visit', handle: 'else' },
      { fromNodeId: 'n_visit', handle: 'new_visit' },
    ]);
    expect(summaries.find((n) => n.nodeId === 'n_summary_revisit')?.branchGuards).toEqual([{ fromNodeId: 'n_visit', handle: 'revisit' }]);
  });

  it('keeps the referenced core.condition — with its branches — even though the lane never executes it', () => {
    const lane = seededLane();
    expect(lane.conditions).toEqual([
      {
        nodeId: 'n_visit',
        branches: [
          { key: 'new_visit', when: "trigger.context.visit_type == 'new-visit'" },
          { key: 'revisit', when: "trigger.context.visit_type == 'revisit'" },
        ],
      },
    ]);
    // The condition node itself is DURABLE and is not an executable lane node.
    expect(lane.stages.flatMap((s) => s.nodes).map((n) => n.nodeId)).toEqual(['n_asr', 'n_ner', 'n_summary_new', 'n_summary_revisit']);
  });

  it('leaves an unguarded lane with no guards and no conditions (byte-identical for graphs with no condition)', () => {
    const lane = buildRealtimeLane(
      compiled([[{ nodeId: 'n_summary', type: 'core.agent', config: { agentRef: { slug: 'gen' }, execution: REALTIME } }]]),
    )!;
    expect(lane.conditions).toEqual([]);
    expect(lane.stages[0]!.nodes[0]!.branchGuards).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2 — ONE summary node per flush
// ---------------------------------------------------------------------------

describe('runRealtimeLane runs only the branch the condition took', () => {
  it('a NEW visit runs n_summary_new and skips n_summary_revisit as branch_not_taken', async () => {
    const generated: string[] = [];
    const run = await runWith('new-visit', generated);

    const byId = new Map(run.outcomes.map((o) => [o.nodeId, o]));
    expect(byId.get('n_summary_new')?.status).toBe('succeeded');
    expect(byId.get('n_summary_revisit')?.status).toBe('skipped');
    expect(byId.get('n_summary_revisit')?.reason).toBe('branch_not_taken');
    expect(generated).toEqual(['gen-new-visit']);
    expect(run.branchEvaluations).toEqual([{ nodeId: 'n_visit', handle: 'new_visit', matched: true, errors: [] }]);
  });

  it('a REVISIT runs n_summary_revisit and skips n_summary_new', async () => {
    const generated: string[] = [];
    const run = await runWith('revisit', generated);

    const byId = new Map(run.outcomes.map((o) => [o.nodeId, o]));
    expect(byId.get('n_summary_revisit')?.status).toBe('succeeded');
    expect(byId.get('n_summary_new')?.status).toBe('skipped');
    expect(byId.get('n_summary_new')?.reason).toBe('branch_not_taken');
    expect(generated).toEqual(['gen-revisit']);
  });

  it('a MISSING visit type takes `else` (n_summary_new) and records the evaluation error', async () => {
    const generated: string[] = [];
    const run = await runWith(undefined, generated);

    const byId = new Map(run.outcomes.map((o) => [o.nodeId, o]));
    expect(byId.get('n_summary_new')?.status).toBe('succeeded');
    expect(byId.get('n_summary_revisit')?.status).toBe('skipped');
    expect(generated).toEqual(['gen-new-visit']);

    const [evaluation] = run.branchEvaluations;
    expect(evaluation?.handle).toBe('else');
    expect(evaluation?.matched).toBe(false);
    expect(evaluation?.errors.map((e) => e.branch)).toEqual(['new_visit', 'revisit']);
  });

  it('an UNRECOGNISED visit type takes `else` with no error — every branch simply evaluated false', async () => {
    const run = await runWith('third-visit');
    expect(run.branchEvaluations[0]).toEqual({ nodeId: 'n_visit', handle: 'else', matched: false, errors: [] });
    expect(run.outcomes.find((o) => o.nodeId === 'n_summary_new')?.status).toBe('succeeded');
  });

  it('leaves the UNGUARDED node untouched and still resolves n_ner.out -> n_summary.in for the taken node', async () => {
    const generated: string[] = [];
    const run = await runWith('revisit', generated);

    const ner = run.outcomes.find((o) => o.nodeId === 'n_ner');
    expect(ner?.status).toBe('succeeded');
    expect(ner?.capability).toBe('extractEntities');
    // `n_ner`'s passthrough `text` reached the taken summary node through the declared port.
    expect(run.outputs.get('n_summary_revisit')?.text).toBe('note from raw');
  });

  it('routing is NOT degradation — a branch_not_taken skip emits no degrade event', async () => {
    const run = await runWith('new-visit');
    expect(run.events).toEqual([]);
    expect(run.failed).toBe(false);
  });

  it('runs BOTH nodes when neither is guarded — a graph with no condition is unaffected', async () => {
    const generated: string[] = [];
    const stages: FixtureNode[][] = [
      [
        { nodeId: 'a', type: 'core.agent', config: { agentRef: { slug: 'gen-a' }, execution: REALTIME } },
        { nodeId: 'b', type: 'core.agent', config: { agentRef: { slug: 'gen-b' }, execution: REALTIME } },
      ],
    ];
    const run = await runRealtimeLane({
      lane: buildRealtimeLane(compiled(stages))!,
      consultationId: CID,
      tenantId: TENANT,
      capabilities: capabilities(generated),
    });
    expect(run.outcomes.every((o) => o.status === 'succeeded')).toBe(true);
    expect(generated.sort()).toEqual(['gen-a', 'gen-b']);
  });

  it('does not block on a guard whose producer this lane cannot evaluate (a human review the durable lane owns)', async () => {
    const generated: string[] = [];
    const stages: FixtureNode[][] = [
      [{ nodeId: 'n_review', type: 'core.humanReview', config: {} }],
      [
        {
          nodeId: 'n_summary',
          type: 'core.agent',
          config: { agentRef: { slug: 'gen' }, execution: REALTIME },
          branchGuards: [{ fromNodeId: 'n_review', handle: 'approved' }],
        },
      ],
    ];
    const run = await runRealtimeLane({
      lane: buildRealtimeLane(compiled(stages))!,
      consultationId: CID,
      tenantId: TENANT,
      capabilities: capabilities(generated),
      runContext: { trigger: { context: {} }, vars: {}, nodes: {} },
    });
    expect(run.outcomes[0]?.status).toBe('succeeded');
    expect(generated).toEqual(['gen']);
  });

  it('propagates the skip: a node whose only producer was branch-skipped is skipped too', async () => {
    const stages: FixtureNode[][] = [
      ...SEEDED_STAGES,
      [
        {
          nodeId: 'n_after_revisit',
          type: 'core.agent',
          config: { agentRef: { slug: 'gen-after' }, execution: REALTIME },
          inputs: [{ fromNodeId: 'n_summary_revisit', fromPort: 'out', toPort: 'in' }],
        },
      ],
    ];
    const run = await runRealtimeLane({
      lane: buildRealtimeLane(compiled(stages))!,
      consultationId: CID,
      tenantId: TENANT,
      capabilities: capabilities([]),
      runContext: { trigger: { context: { visit_type: 'new-visit' } }, vars: {}, nodes: {} },
    });
    const byId = new Map(run.outcomes.map((o) => [o.nodeId, o]));
    expect(byId.get('n_summary_revisit')?.status).toBe('skipped');
    expect(byId.get('n_after_revisit')?.status).toBe('skipped');
    expect(byId.get('n_after_revisit')?.reason).toBe('branch_not_taken');
  });
});
