/**
 * TASK-946 D2 — a REVISIT must not be documented with the new-visit note shape.
 *
 * ## The defect, from the 2026-09-10 trial
 *
 * ```
 * 16:06:56  Froze the live document template for this session
 *           slug: arcaai-bren-soap-new-visit   requestedSlug: arcaai-bren-soap-new-visit
 * ```
 *
 * …on a consultation whose `parentConsultationId` was set, and whose OWN run evaluated the
 * visit branch correctly (`n_summary_revisit` ran). The shape and the summariser disagreed
 * because `realtimeDocumentTemplateSlug` was FIRST-MATCH over stage order, and every seeded
 * ArcaAI graph declares `n_summary_new` before `n_summary_revisit`
 * (`seed/28-workflow-library.ts`).
 *
 * The lane already carried the decision: `RealtimeLane.conditions` holds the branches and each
 * guarded node holds its `branchGuards`. This suite pins that the slug now comes from a
 * REACHABLE node, under exactly the reachability rule the executor's `branchSkip` applies.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { buildRealtimeLane, realtimeDocumentTemplateSlug } from '../realtime-lane';
import { resolveBranchHandles } from '../realtime-executor';

const TENANT = 'tenant-946';
const REALTIME = { lane: 'realtime', cadence: 'perTurn' };
const NEW_VISIT_SLUG = 'arcaai-bren-soap-new-visit';
const REVISIT_SLUG = 'arcaai-bren-soap-revisit';

interface FixtureNode {
  nodeId: string;
  type: string;
  config?: Record<string, unknown>;
  inputs?: Array<{ fromNodeId: string; fromPort: string; toPort: string }>;
  branchGuards?: Array<{ fromNodeId: string; handle: string }>;
}

function compiled(stages: FixtureNode[][]) {
  return {
    formatVersion: 1 as const,
    definitionId: 'd',
    slug: 'arcaai-bren-consultation',
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
 * The SEEDED ArcaAI shape: a visit-type `core.condition` and two guarded summary nodes, the
 * new-visit one FIRST in stage order — which is the whole reason first-match was wrong.
 * `n_summary_new` carries BOTH the `new_visit` and the `else` handle, exactly as the seed's
 * three edges compile.
 */
const SEEDED_STAGES: FixtureNode[][] = [
  [{ nodeId: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'whisper' }, execution: REALTIME } }],
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
      inputs: [{ fromNodeId: 'n_asr', fromPort: 'transcript', toPort: 'in' }],
    },
  ],
  [
    {
      nodeId: 'n_summary_new',
      type: 'core.agent',
      config: { agentRef: { slug: 'gen-new-visit' }, execution: REALTIME, documentTemplateSlug: NEW_VISIT_SLUG },
      branchGuards: [
        { fromNodeId: 'n_visit', handle: 'new_visit' },
        { fromNodeId: 'n_visit', handle: 'else' },
      ],
    },
    {
      nodeId: 'n_summary_revisit',
      type: 'core.agent',
      config: { agentRef: { slug: 'gen-revisit' }, execution: REALTIME, documentTemplateSlug: REVISIT_SLUG },
      branchGuards: [{ fromNodeId: 'n_visit', handle: 'revisit' }],
    },
  ],
];

const seededLane = () => buildRealtimeLane(compiled(SEEDED_STAGES))!;

/** The run context shape `realtimeRunContext` publishes: `{ trigger: { context } }`. */
const runContext = (visitType: string) => ({ trigger: { context: { visit_type: visitType } } });

describe('TASK-946 D2 — the frozen template follows the visit branch', () => {
  it('a REVISIT resolves the revisit shape, though the new-visit node comes first in stage order', () => {
    const lane = seededLane();
    const handles = resolveBranchHandles(lane, runContext('revisit'));

    expect(handles).toEqual([{ nodeId: 'n_visit', handle: 'revisit', matched: true, errors: [] }]);
    expect(realtimeDocumentTemplateSlug(lane, handles)).toBe(REVISIT_SLUG);
  });

  it('a NEW VISIT resolves the new-visit shape', () => {
    const lane = seededLane();
    const handles = resolveBranchHandles(lane, runContext('new-visit'));

    expect(handles[0].handle).toBe('new_visit');
    expect(realtimeDocumentTemplateSlug(lane, handles)).toBe(NEW_VISIT_SLUG);
  });

  it('an unevaluable guard falls to `else`, which the seed points at the new-visit node', () => {
    const lane = seededLane();
    // No `trigger` root at all — every expression errors, exactly as the durable activity's
    // fall-through behaves, and the recorded errors are what tells the two apart.
    const handles = resolveBranchHandles(lane, {});

    expect(handles[0].handle).toBe('else');
    expect(handles[0].matched).toBe(false);
    expect(handles[0].errors.length).toBeGreaterThan(0);
    expect(realtimeDocumentTemplateSlug(lane, handles)).toBe(NEW_VISIT_SLUG);
  });

  it('an UNGUARDED lane keeps first-match, with and without an evaluation', () => {
    const lane = buildRealtimeLane(
      compiled([
        [
          {
            nodeId: 'summarize',
            type: 'core.agent',
            config: { agentRef: { task: 'TEXT_GENERATION' }, execution: REALTIME, documentTemplateSlug: NEW_VISIT_SLUG },
          },
        ],
      ]),
    )!;

    expect(lane.conditions).toEqual([]);
    expect(realtimeDocumentTemplateSlug(lane)).toBe(NEW_VISIT_SLUG);
    expect(realtimeDocumentTemplateSlug(lane, resolveBranchHandles(lane, runContext('revisit')))).toBe(NEW_VISIT_SLUG);
  });

  it('with NO evaluation supplied a branched lane keeps the previous first-match answer', () => {
    // The pre-946 contract, preserved for any caller that has no run context to offer.
    expect(realtimeDocumentTemplateSlug(seededLane())).toBe(NEW_VISIT_SLUG);
  });

  it('a guard naming a producer the lane cannot decide does NOT block the node', () => {
    // The executor's own rule: only DECIDABLE guards vote (a `core.classify` / `core.humanReview`
    // producer is left out of the vote), because refusing to name a shape is worse than naming one.
    const lane = buildRealtimeLane(
      compiled([
        [
          {
            nodeId: 'summarize',
            type: 'core.agent',
            config: { agentRef: { task: 'TEXT_GENERATION' }, execution: REALTIME, documentTemplateSlug: REVISIT_SLUG },
            branchGuards: [{ fromNodeId: 'n_triage', handle: 'urgent' }],
          },
        ],
      ]),
    )!;

    expect(realtimeDocumentTemplateSlug(lane, [{ nodeId: 'n_visit', handle: 'revisit', matched: true, errors: [] }])).toBe(REVISIT_SLUG);
  });
});
