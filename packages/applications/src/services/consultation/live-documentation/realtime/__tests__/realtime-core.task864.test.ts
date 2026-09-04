/**
 * TASK-864 A5 — the realtime lane keyed by NODE CONFIG, not only by node type.
 *
 * The `core` vocabulary moved `lane`/`trigger` from the registry descriptor onto the node's own
 * `execution` config, so one `core.agent` type serves both runtimes. These tests pin the three
 * things that makes true: lane ADMISSION by instance, HANDLER resolution by instance (a
 * `core.action` runs its delegate's handler under the delegate's ports), and the flush
 * projection's canonical read-back.
 */
import { describe, expect, it, vi } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { buildRealtimeLane } from '../realtime-lane';
import { canonicalRealtimeNodeType, isRealtimeNode, realtimeHandlerFor, type RealtimeCapabilities } from '../realtime-node-registry';

const capabilities = (over: Partial<RealtimeCapabilities> = {}): RealtimeCapabilities => ({
  transcribe: vi.fn().mockResolvedValue({ transcript: 'raw transcript', pipelineId: null }),
  generateDocument: vi.fn().mockResolvedValue({ text: 'note', sections: [], stats: null, repaired: false }),
  extractEntities: vi.fn().mockResolvedValue({ entities: [{ text: 'aspirin', type: 'MEDICATION' }], vitals: undefined }),
  proposeCorrections: vi.fn().mockResolvedValue({ proposals: [], textSha256: 'x', rejectedProposals: 0 }),
  extractFindings: vi.fn().mockResolvedValue({ findings: [] }),
  ...over,
});

function compiled(nodes: Array<{ nodeId: string; type: string; config?: Record<string, unknown>; inputs?: Array<{ fromNodeId: string; fromPort: string; toPort: string }> }>) {
  return {
    formatVersion: 1 as const,
    definitionId: 'd',
    slug: 'core-live',
    versionNumber: 1,
    tenantId: 't',
    paletteKey: 'core',
    compiledAt: 'x',
    compilerVersion: '0',
    registryChecksum: 'r',
    ruleSetVersion: 1,
    stages: [
      {
        stageIndex: 0,
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
        })),
      },
    ],
    gates: [],
    policyBindings: { guardrailProfile: 'STANDARD' as const, redactionRuleSetId: null, promptTemplateRefs: [], documentTemplateRefs: [], contextSchemaVersionId: null, entitlementKeys: [] },
    caps: { maxTotalSeconds: 1, maxNodeSeconds: 1, maxAttempts: 1 },
    checksum: 'c',
  };
}

describe('isRealtimeNode — lane by instance', () => {
  it('a core.agent joins the lane only when its own execution.lane says so', () => {
    expect(isRealtimeNode('core.agent', { execution: { lane: 'realtime' } })).toBe(true);
    expect(isRealtimeNode('core.agent', { execution: { lane: 'durable' } })).toBe(false);
    expect(isRealtimeNode('core.agent', {})).toBe(false);
  });

  it('a core.action inherits its delegate`s lane unless the instance overrides it', () => {
    expect(isRealtimeNode('core.action', { actionKey: 'agent.ner' })).toBe(true);
    expect(isRealtimeNode('core.action', { actionKey: 'consultation.phiHop' })).toBe(false);
    expect(isRealtimeNode('core.action', { actionKey: 'consultation.phiHop', execution: { lane: 'realtime' } })).toBe(true);
    expect(isRealtimeNode('core.action', { actionKey: 'agent.ner', execution: { lane: 'durable' } })).toBe(false);
  });

  it('every legacy type resolves exactly as its descriptor says', () => {
    for (const descriptor of Object.values(WORKFLOW_NODE_REGISTRY)) {
      if (descriptor.key.startsWith('core.')) continue;
      expect(isRealtimeNode(descriptor.key)).toBe(descriptor.lane === 'realtime');
    }
  });
});

describe('buildRealtimeLane admits core nodes by config', () => {
  it('admits a realtime core.agent and a realtime core.action, and leaves a durable core.agent to the interpreter', () => {
    const lane = buildRealtimeLane(
      compiled([
        { nodeId: 'capture', type: 'core.action', config: { actionKey: 'consultation.captureBinding' } },
        { nodeId: 'live', type: 'core.agent', config: { agentRef: { slug: 'platform-summarization' }, execution: { lane: 'realtime', cadence: 'perTurn' } }, inputs: [{ fromNodeId: 'capture', fromPort: 'out', toPort: 'in' }] },
        { nodeId: 'final', type: 'core.agent', config: { agentRef: { slug: 'platform-summarization' } } },
      ]),
    );
    expect(lane).not.toBeNull();
    expect(lane!.stages.flatMap((s) => s.nodes.map((n) => n.nodeId))).toEqual(['capture', 'live']);
  });

  it('yields no lane for a graph of durable core nodes only', () => {
    expect(buildRealtimeLane(compiled([{ nodeId: 'a', type: 'core.agent', config: { agentRef: { slug: 'x' } } }]))).toBeNull();
  });
});

describe('realtimeHandlerFor — handlers by instance', () => {
  it('a core.action runs its delegate`s handler under the delegate`s ports, with the action`s own config', async () => {
    const caps = capabilities();
    const handler = realtimeHandlerFor('core.action', { actionKey: 'consultation.extractEntities', action: { requiresFinalized: false } });
    expect(handler).toBeDefined();
    expect(handler!.inputs).toBe(WORKFLOW_NODE_REGISTRY['consultation.extractEntities'].inputs);
    const output = await handler!.run({ bound: { in: 'patient takes aspirin' }, config: { actionKey: 'consultation.extractEntities', action: {} }, tenantId: 't', consultationId: 'c', capabilities: caps });
    expect(caps.extractEntities).toHaveBeenCalledTimes(1);
    expect(output.entities).toEqual([{ text: 'aspirin', type: 'MEDICATION' }]);
  });

  it('an action whose delegate has no realtime handler resolves to none — the executor skips it', () => {
    expect(realtimeHandlerFor('core.action', { actionKey: 'consultation.phiHop' })).toBeUndefined();
    expect(realtimeHandlerFor('core.action', { actionKey: 'nope' })).toBeUndefined();
  });

  it('a core.agent generates the running note through the same capability the summary node uses, forwarding its config', async () => {
    const caps = capabilities();
    const config = { agentRef: { slug: 'platform-summarization' }, execution: { lane: 'realtime' } };
    const output = await realtimeHandlerFor('core.agent')!.run({ bound: { in: 'said so far' }, config, tenantId: 't', consultationId: 'c', capabilities: caps });
    expect(caps.generateDocument).toHaveBeenCalledWith({ sourceText: 'said so far', tenantId: 't', config }, undefined);
    expect(output.text).toBe('note');
  });
});

describe('canonicalRealtimeNodeType reads a core instance back as the capability it is', () => {
  it('maps an action onto its delegate (through the existing alias table) and a live agent onto the summary', () => {
    expect(canonicalRealtimeNodeType('core.action', { actionKey: 'agent.ner' })).toBe('consultation.extractEntities');
    expect(canonicalRealtimeNodeType('core.action', { actionKey: 'consultation.captureBinding' })).toBe('consultation.captureBinding');
    expect(canonicalRealtimeNodeType('core.agent', {})).toBe('consultation.realtimeSummary');
    expect(canonicalRealtimeNodeType('agent.ner')).toBe('consultation.extractEntities');
  });
});
