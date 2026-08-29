/**
 * TASK-811 — the realtime graph executor.
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
      paletteKey: 'consultation',
      compiledAt: '2026-08-28T00:00:00.000Z',
      compilerVersion: '0.1.0',
      registryChecksum: 'x',
      ruleSetVersion: 1,
      stages: [
        { stageIndex: 0, nodes: [{ nodeId: 'consent', type: 'consultation.consentGate' } as never] },
        {
          stageIndex: 1,
          nodes: [
            {
              nodeId: 'cap',
              type: 'consultation.captureBinding',
              activity: 'x',
              config: {},
              timeoutSeconds: 5,
              retry: { maximumAttempts: 2, initialIntervalSeconds: 1, backoffCoefficient: 2 },
              inputs: [],
              onError: 'degrade',
              emitsTrajectory: true,
            },
          ],
        },
        { stageIndex: 2, nodes: [{ nodeId: 'persist', type: 'consultation.persistDraft' } as never] },
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
        stages: [{ stageIndex: 0, nodes: [{ nodeId: 'persist', type: 'consultation.persistDraft' } as never] }],
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
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [
        node({
          nodeId: 'extract',
          type: 'consultation.extractEntities',
          config: { enabled: false },
          enabled: false,
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
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
      { nodeId: PLATFORM_LANE_NODE_IDS.extract, type: 'consultation.extractEntities', status: 'degraded', reason: 'nlp unavailable', laneSource: 'platform-default' },
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
      [node({ nodeId: 'capture', type: 'consultation.captureBinding', onError: 'degrade' })],
      [node({ nodeId: 'extract', type: 'consultation.extractEntities', inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }] })],
    ]);

    const result = await run(lane, caps);

    expect(caps.extractEntities).not.toHaveBeenCalled();
    expect(result.outcomes[1]).toMatchObject({ nodeId: 'extract', status: 'succeeded' });
    expect(result.outputs.get('extract')).toEqual({ entities: [] });
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
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [node({ nodeId: 'extract', type: 'consultation.extractEntities', inputs: [{ fromNodeId: 'capture', fromPort: 'banana', toPort: 'in' }] })],
    ]);

    await expect(run(lane, capabilities())).rejects.toBeInstanceOf(RealtimeBindingError);
  });

  it('raises on an input socket the consumer does not declare', async () => {
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [node({ nodeId: 'extract', type: 'consultation.extractEntities', inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'banana' }] })],
    ]);

    await expect(run(lane, capabilities())).rejects.toBeInstanceOf(RealtimeBindingError);
  });

  it('a control edge carries ordering and binds no payload', async () => {
    const caps = capabilities();
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [
        node({
          nodeId: 'extract',
          type: 'consultation.extractEntities',
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

describe('task 6 — anti-laundering: NER cannot receive generated text', () => {
  it('REFUSES a lane wiring a generation node into entity extraction', async () => {
    // `consultation.realtimeSummary.out` is `document`; `consultation.extractEntities.in`
    // is `transcript`. They are SIBLINGS under `text`, so document does not satisfy
    // transcript and the edge is a type error.
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [node({ nodeId: 'summarize', type: 'consultation.realtimeSummary', inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }] })],
      [node({ nodeId: 'extract', type: 'consultation.extractEntities', inputs: [{ fromNodeId: 'summarize', fromPort: 'out', toPort: 'in' }] })],
    ]);

    const caps = capabilities();
    await expect(run(lane, caps)).rejects.toThrow(/does not satisfy/);
    // And, decisively: the generated note NEVER reached the NER capability.
    expect(caps.extractEntities).not.toHaveBeenCalled();
  });

  it('still admits the legitimate widening: a transcript IS text', async () => {
    // `consultation.realtimeSummary.in` is `text`; capture produces `transcript`,
    // which widens to text. This edge must remain legal.
    const lane = laneOf([
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [node({ nodeId: 'summarize', type: 'consultation.realtimeSummary', inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }] })],
    ]);

    const result = await run(lane, capabilities());
    expect(result.outcomes[1].status).toBe('succeeded');
  });
});

// ---------------------------------------------------------------------------
// Task 10 — PER-NODE budget, retry and staleness
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
        [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
        [
          node({ nodeId: 'extract', type: 'consultation.extractEntities', inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }] }),
          node({
            nodeId: 'summarize',
            type: 'consultation.realtimeSummary',
            timeoutMs: 30,
            inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
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
      [node({ nodeId: 'capture', type: 'consultation.captureBinding' })],
      [
        node({
          nodeId: 'extract',
          type: 'consultation.extractEntities',
          maxAttempts: 2,
          inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }],
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
describe('Lane R (R3) — one flush of the owner’s realtime loop yields all three products', () => {
  const ownerLoop = (): RealtimeLane =>
    laneOf([
      [node({ nodeId: 'transcribe', type: 'agent.transcription' })],
      [
        node({ nodeId: 'ner', type: 'agent.ner', inputs: [{ fromNodeId: 'transcribe', fromPort: 'out', toPort: 'in' }] }),
        node({ nodeId: 'summarize', type: 'consultation.realtimeSummary', inputs: [{ fromNodeId: 'transcribe', fromPort: 'out', toPort: 'in' }] }),
      ],
      [
        node({
          nodeId: 'grammar',
          type: 'agent.grammar',
          config: { promptTemplateId: 'tpl-corrections', onError: 'degrade' },
          inputs: [
            { fromNodeId: 'transcribe', fromPort: 'out', toPort: 'in' },
            { fromNodeId: 'ner', fromPort: 'out', toPort: 'entities' },
          ],
        }),
      ],
    ]);

  const loopCapabilities = () =>
    capabilities({
      proposeCorrections: vi.fn().mockResolvedValue({
        proposals: [{ proposalId: 'p1', start: 0, end: 7, original: 'patient', proposed: 'Patient' }],
        textSha256: 'sha-of-transcript',
        rejectedProposals: 0,
      }),
    });

  it('produces a transcript, entities, a document and correction proposals in one run', async () => {
    const caps = loopCapabilities();
    const result = await run(ownerLoop(), caps);

    expect(result.failed).toBe(false);
    expect(result.outcomes.map((o) => o.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);

    // 1. the partial transcript the session ingested
    expect(result.outputs.get('transcribe')?.transcript).toBe('patient reports cough and takes aspirin');
    // 2. the entities the UI highlights
    expect(result.outputs.get('ner')?.entities).toEqual([{ text: 'aspirin', type: 'MEDICATION' }]);
    // 3. the partial summary
    expect(result.outputs.get('summarize')?.text).toBe('Assessment: viral URI.');
    // 4. the advisory corrections — ADVISORY, which is the property that makes them publishable
    //    alongside the raw transcript rather than over it.
    expect(result.outputs.get('grammar')?.proposals).toHaveLength(1);
    expect(result.outputs.get('grammar')?.applied).toBe(false);
  });

  it('feeds the grammar pass the RAW transcript and the SAME flush’s entities — not a second NER call', async () => {
    const caps = loopCapabilities();
    await run(ownerLoop(), caps);

    expect(caps.extractEntities).toHaveBeenCalledTimes(1);
    expect(caps.proposeCorrections).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceText: 'patient reports cough and takes aspirin',
        entities: [{ text: 'aspirin', type: 'MEDICATION' }],
        config: { promptTemplateId: 'tpl-corrections', onError: 'degrade' },
      }),
      undefined,
    );
  });

  it('REFUSES to wire the generated note into the grammar pass — corrections review what was SAID', async () => {
    // The same anti-laundering guarantee `agent.ner` carries, and for a related reason: a
    // correction proposed over the model's own prose would offer the clinician an edit to text
    // nobody spoke, anchored to offsets in a document rather than in the transcript.
    const laundered = laneOf([
      [node({ nodeId: 'transcribe', type: 'agent.transcription' })],
      [node({ nodeId: 'summarize', type: 'consultation.realtimeSummary', inputs: [{ fromNodeId: 'transcribe', fromPort: 'out', toPort: 'in' }] })],
      [node({ nodeId: 'grammar', type: 'agent.grammar', inputs: [{ fromNodeId: 'summarize', fromPort: 'out', toPort: 'in' }] })],
    ]);

    await expect(run(laundered, loopCapabilities())).rejects.toBeInstanceOf(RealtimeBindingError);
  });

  it('an unconfigured grammar prompt DEGRADES visibly instead of silently proposing nothing', async () => {
    // The prompt is CONFIG. A node with none is a misconfiguration, and the clinician-facing
    // difference between "no corrections were found" and "this node was never configured" is the
    // whole reason degrade is never silent.
    const caps = capabilities({
      proposeCorrections: vi.fn().mockRejectedValue(new Error('no_correction_prompt_bound')),
    });
    const result = await run(ownerLoop(), caps);

    const grammar = result.outcomes.find((o) => o.nodeId === 'grammar');
    expect(grammar?.status).toBe('degraded');
    expect(result.events.map((e) => e.nodeId)).toContain('grammar');
    // ...and the rest of the flush is untouched: the note still publishes.
    expect(result.outputs.get('summarize')?.text).toBe('Assessment: viral URI.');
  });
});
