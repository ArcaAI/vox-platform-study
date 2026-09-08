/**
 * the realtime graph executor.
 *
 * Tasks 3, 4, 5, 6 and 10 of the ticket plan all land here, because they are all
 * properties of the same walk: declared order, disabled-node skip, per-node
 * degrade, binding-by-port, the anti-laundering invariant, and per-node
 * budget/staleness.
 */
import { describe, it, expect, vi } from 'vitest';
import { runRealtimeLane, RealtimeBindingError } from '../realtime-executor';
import { PLATFORM_REALTIME_LANE, PLATFORM_LANE_NODE_IDS, buildRealtimeLane, type RealtimeLane, type RealtimeNode } from '../realtime-lane';
import type { RealtimeCapabilities } from '../realtime-node-registry';

const CID = 'consultation-811';
const TENANT = 'tenant-811';

function capabilities(overrides: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities {
  return {
    transcribe: vi.fn().mockResolvedValue({ transcript: 'patient reports cough and takes aspirin', pipelineId: 'pipeline-1' }),
    generateDocument: vi.fn().mockResolvedValue({ text: 'Assessment: viral URI.', sections: [], stats: null, repaired: false }),
    extractEntities: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }], vitals: { systolic: 120 } }),
    ...overrides,
  };
}

const run = (lane: RealtimeLane, caps: RealtimeCapabilities, extra: Record<string, unknown> = {}) =>
  runRealtimeLane({ lane, consultationId: CID, tenantId: TENANT, capabilities: caps, ...extra });

/** A one-node lane wrapping an arbitrary node — the fixture-graph helper. */
function laneOf(nodes: RealtimeNode[][], source: RealtimeLane['source'] = 'tenant-graph'): RealtimeLane {
  return {
    source,
    definitionSlug: 'fixture',
    definitionVersionNumber: 1,
    stages: nodes.map((stageNodes, stageIndex) => ({ stageIndex, nodes: stageNodes })),
  };
}

const node = (over: Partial<RealtimeNode> & Pick<RealtimeNode, 'nodeId' | 'type'>): RealtimeNode => ({
  config: {},
  timeoutMs: 5_000,
  maxAttempts: 1,
  inputs: [],
  onError: 'degrade',
  enabled: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Task 3 — the executor walks the compiled lane in DECLARED order
// ---------------------------------------------------------------------------

describe('task 3 — the executor walks the lane in declared order', () => {
  it('runs stage 0 before stage 1 and reports outcomes in execution order', async () => {
    const order: string[] = [];
    const caps = capabilities({
      transcribe: vi.fn(async () => {
        order.push('capture');
        return { transcript: 'raw transcript', pipelineId: null };
      }),
      extractEntities: vi.fn(async () => {
        order.push('extract');
        return { entities: [] };
      }),
      generateDocument: vi.fn(async () => {
        order.push('summarize');
        return { text: 'note', sections: [], stats: null, repaired: false };
      }),
    });

    const result = await run(PLATFORM_REALTIME_LANE, caps);

    expect(order[0]).toBe('capture');
    expect(order.slice(1).sort()).toEqual(['extract', 'summarize']);
    expect(result.outcomes.map((o) => o.nodeId)).toEqual([
      PLATFORM_LANE_NODE_IDS.capture,
      PLATFORM_LANE_NODE_IDS.extract,
      PLATFORM_LANE_NODE_IDS.summarize,
    ]);
    expect(result.outcomes.every((o) => o.status === 'succeeded')).toBe(true);
    expect(result.failed).toBe(false);
  });

  it('runs the nodes of ONE stage concurrently (DD-4) — wall clock is the slowest, not the sum', async () => {
    const started: number[] = [];
    const slow = (ms: number) => async () => {
      started.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, ms));
    };
    const caps = capabilities({
      extractEntities: vi.fn(async () => {
        await slow(60)();
        return { entities: [] };
      }),
      generateDocument: vi.fn(async () => {
        await slow(60)();
        return { text: 'note', sections: [], stats: null, repaired: false };
      }),
    });

    const startedAt = Date.now();
    await run(PLATFORM_REALTIME_LANE, caps);
    const elapsed = Date.now() - startedAt;

    // Serial would be ≥120ms. Allow generous slack for a loaded CI box while
    // still failing loudly if the two calls were serialised.
    expect(elapsed).toBeLessThan(115);
  });

  it('derives the lane from a compiled graph, dropping durable nodes and renumbering stages densely', () => {
    const lane = buildRealtimeLane({
      formatVersion: 1,
      definitionId: 'def-1',
      slug: 'tenant-soap',
      versionNumber: 3,
      tenantId: TENANT,
      paletteKey: 'core',
      compiledAt: '2026-08-28T00:00:00.000Z',
      compilerVersion: '0.1.0',
      registryChecksum: 'x',
      ruleSetVersion: 1,
      stages: [
        { stageIndex: 0, nodes: [{ nodeId: 'consent', type: 'core.action', config: { actionKey: 'consultation.consentGate' } } as never] },
        {
          stageIndex: 1,
          nodes: [
            {
              nodeId: 'cap',
              type: 'core.agent',
              activity: 'x',
              config: { agentRef: { slug: 'realtime-transcription' }, execution: { lane: 'realtime' } },
              timeoutSeconds: 5,
              retry: { maximumAttempts: 2, initialIntervalSeconds: 1, backoffCoefficient: 2 },
              inputs: [],
              onError: 'degrade',
              emitsTrajectory: true,
            },
          ],
        },
        { stageIndex: 2, nodes: [{ nodeId: 'persist', type: 'core.action', config: { actionKey: 'consultation.persistDraft' } } as never] },
      ],
      gates: [],
      policyBindings: {
        guardrailProfile: 'STANDARD',
        redactionRuleSetId: null,
        promptTemplateRefs: [],
        documentTemplateRefs: [],
        contextSchemaVersionId: null,
        entitlementKeys: [],
      },
      caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
      checksum: 'y',
    });

    expect(lane).not.toBeNull();
    expect(lane?.source).toBe('tenant-graph');
    expect(lane?.definitionSlug).toBe('tenant-soap');
    // The two durable stages are gone and the surviving stage is renumbered to 0.
    expect(lane?.stages).toHaveLength(1);
    expect(lane?.stages[0].stageIndex).toBe(0);
    expect(lane?.stages[0].nodes[0]).toMatchObject({ nodeId: 'cap', timeoutMs: 5_000, maxAttempts: 2 });
  });

  it('returns null when a graph contributes no realtime nodes — the caller then serves the platform lane', () => {
    expect(buildRealtimeLane(null)).toBeNull();
    expect(
      buildRealtimeLane({
        stages: [{ stageIndex: 0, nodes: [{ nodeId: 'persist', type: 'core.action', config: { actionKey: 'consultation.persistDraft' } } as never] }],
      } as never),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Task 4 — disabled node skipped; per-node failure degrades
// ---------------------------------------------------------------------------

describe('task 4 — disabled nodes are skipped; failures degrade, never silently', () => {
  it('skips a node authored `enabled: false` and never calls its capability', async () => {
    const caps = capabilities();
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
      [
        node({
          nodeId: 'extract',
          type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } },
          config: { enabled: false },
          enabled: false,
          inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'in' }],
        }),
      ],
    ]);

    const result = await run(lane, caps);

    expect(caps.extractEntities).not.toHaveBeenCalled();
    expect(result.outcomes[1]).toMatchObject({ nodeId: 'extract', status: 'skipped', reason: 'disabled_by_config' });
    expect(result.failed).toBe(false);
  });

  it('degrades a failing `onError: degrade` node and lets the rest of the stage finish', async () => {
    const caps = capabilities({ extractEntities: vi.fn().mockRejectedValue(new Error('nlp unavailable')) });

    const result = await run(PLATFORM_REALTIME_LANE, caps);

    const extract = result.outcomes.find((o) => o.nodeId === PLATFORM_LANE_NODE_IDS.extract);
    const summarize = result.outcomes.find((o) => o.nodeId === PLATFORM_LANE_NODE_IDS.summarize);
    expect(extract).toMatchObject({ status: 'degraded', reason: 'nlp unavailable' });
    // FAILURE ISOLATES: the note is untouched by the extraction failure.
    expect(summarize?.status).toBe('succeeded');
    expect(result.failed).toBe(false);
  });

  it('EVERY degrade emits a typed event — degradation is never silent', async () => {
    const caps = capabilities({ extractEntities: vi.fn().mockRejectedValue(new Error('nlp unavailable')) });

    const result = await run(PLATFORM_REALTIME_LANE, caps);

    expect(result.events).toEqual([
      { nodeId: PLATFORM_LANE_NODE_IDS.extract, type: 'core.agent', status: 'degraded', reason: 'nlp unavailable', laneSource: 'platform-default' },
    ]);
  });

  it('an `onError: fail` node stops the lane and marks the run failed', async () => {
    const caps = capabilities({ transcribe: vi.fn().mockRejectedValue(new Error('capture unavailable')) });

    const result = await run(PLATFORM_REALTIME_LANE, caps);

    expect(result.outcomes[0]).toMatchObject({ nodeId: PLATFORM_LANE_NODE_IDS.capture, status: 'failed' });
    expect(result.failed).toBe(true);
    // Stage 1 never ran.
    expect(result.outcomes).toHaveLength(1);
    expect(caps.generateDocument).not.toHaveBeenCalled();
  });

  it('a degraded predecessor contributes NOTHING rather than a fabricated value', async () => {
    // capture degrades -> extract's `in` is unbound -> the handler must not invent text.
    const caps = capabilities({ transcribe: vi.fn().mockRejectedValue(new Error('down')) });
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } }, onError: 'degrade' })],
      [node({ nodeId: 'extract', type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } }, inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'in' }] })],
    ]);

    const result = await run(lane, caps);

    expect(caps.extractEntities).not.toHaveBeenCalled();
    expect(result.outcomes[1]).toMatchObject({ nodeId: 'extract', status: 'succeeded' });
    expect(result.outputs.get('extract')).toEqual({ data: { entities: [] }, text: '', entities: [] });
  });
});

// ---------------------------------------------------------------------------
// Task 5 — inputs resolve by DECLARED PORT (retiring `delta || transcript`)
// ---------------------------------------------------------------------------

describe('task 5 — step inputs resolve by declared port', () => {
  it("threads the producer's declared `outputKey`, not its port NAME", async () => {
    // `consultation.captureBinding.out` is named `out` but declares
    // `outputKey: 'transcript'`. Nothing in this platform emits a key called "out".
    const caps = capabilities();
    await run(PLATFORM_REALTIME_LANE, caps);

    expect(caps.extractEntities).toHaveBeenCalledWith({ sourceText: 'patient reports cough and takes aspirin', tenantId: TENANT }, undefined);
  });

  it('raises on a port the producer does not declare — a contract violation, not a node outcome', async () => {
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
      [node({ nodeId: 'extract', type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } }, inputs: [{ fromNodeId: 'capture', fromPort: 'banana', toPort: 'in' }] })],
    ]);

    await expect(run(lane, capabilities())).rejects.toBeInstanceOf(RealtimeBindingError);
  });

  it('raises on an input socket the consumer does not declare', async () => {
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
      [node({ nodeId: 'extract', type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } }, inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'banana' }] })],
    ]);

    await expect(run(lane, capabilities())).rejects.toBeInstanceOf(RealtimeBindingError);
  });

  it('a control edge carries ordering and binds no payload', async () => {
    const caps = capabilities();
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
      [
        node({
          nodeId: 'extract',
          type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } },
          inputs: [{ fromNodeId: 'capture', fromPort: 'next', toPort: 'after' }],
        }),
      ],
    ]);

    const result = await run(lane, caps);

    expect(caps.extractEntities).not.toHaveBeenCalled(); // no transcript bound
    expect(result.outcomes[1].status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Task 6 — THE INVARIANT: NER can never receive generated text
// ---------------------------------------------------------------------------

describe('task 10 — budget and staleness are per node, not per flush', () => {
  it('a slow node blows only its OWN budget; its stage-mate still succeeds', async () => {
    const caps = capabilities({
      generateDocument: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return { text: 'late note', sections: [], stats: null, repaired: false };
      }),
    });
    const lane = laneOf(
      [
        [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
        [
          node({ nodeId: 'extract', type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } }, inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'in' }] }),
          node({
            nodeId: 'summarize',
            type: 'core.agent', config: { agentRef: { task: 'TEXT_GENERATION' } },
            timeoutMs: 30,
            inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'in' }],
          }),
        ],
      ],
      'platform-default',
    );

    const result = await run(lane, caps);

    expect(result.outcomes.find((o) => o.nodeId === 'summarize')).toMatchObject({ status: 'timed-out', reason: 'budget_exceeded_30ms' });
    // A slow discharge summary does not stall the SOAP note.
    expect(result.outcomes.find((o) => o.nodeId === 'extract')?.status).toBe('succeeded');
    expect(result.events.map((e) => e.status)).toEqual(['timed-out']);
  });

  it('retries up to the node’s OWN maxAttempts before degrading', async () => {
    const extractEntities = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }] });
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'core.agent', config: { agentRef: { task: 'SPEECH_TO_TEXT' } } })],
      [
        node({
          nodeId: 'extract',
          type: 'core.agent', config: { agentRef: { task: 'NAMED_ENTITY_RECOGNITION' } },
          maxAttempts: 2,
          inputs: [{ fromNodeId: 'capture', fromPort: 'transcript', toPort: 'in' }],
        }),
      ],
    ]);

    const result = await run(lane, capabilities({ extractEntities }));

    expect(extractEntities).toHaveBeenCalledTimes(2);
    expect(result.outcomes[1]).toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('a LATE response never overwrites fresher content — it is discarded as stale', async () => {
    let superseded = false;
    const caps = capabilities({
      generateDocument: vi.fn(async () => {
        superseded = true; // a newer flush claimed the session while this was in flight
        return { text: 'stale note', sections: [], stats: null, repaired: false };
      }),
    });

    const result = await run(PLATFORM_REALTIME_LANE, caps, { isStale: () => superseded });

    const summarize = result.outcomes.find((o) => o.nodeId === PLATFORM_LANE_NODE_IDS.summarize);
    expect(summarize).toMatchObject({ status: 'stale', reason: 'superseded_after_completion' });
    // Its output is NOT published — nothing downstream can read it.
    expect(result.outputs.has(PLATFORM_LANE_NODE_IDS.summarize)).toBe(false);
    expect(result.events.some((e) => e.status === 'stale')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Lane R (R3) — the loop the OWNER described, end to end through the executor
// ---------------------------------------------------------------------------

/**
 * The acceptance bar for this lane is what a clinician SEES during a live session, and the
 * executor is where the three things are produced. This walks one flush of the owner's loop —
 * transcription → entity extraction → partial summarization → grammar/spelling — and asserts
 * that each stage's product is really carried on the run's outputs, in the target catalogue's
 * node names (the vocabulary a tenant graph is authored in).
 *
 * The names matter as much as the values: everything here is `agent.*`, so this is also the
 * regression for the projection defect where a catalogue-authored graph ran and published
 * nothing.
 */
