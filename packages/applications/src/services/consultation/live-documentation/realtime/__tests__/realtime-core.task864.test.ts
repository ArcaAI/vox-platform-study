/**
 * TASK-864 A5 / TASK-893 — the realtime lane keyed by NODE CONFIG, not by node type: lane
 * ADMISSION by instance, HANDLER resolution by instance, and the outcome's capability read-back.
 */
import { describe, expect, it } from 'vitest';
import { WORKFLOW_NODE_REGISTRY } from '@arcaai/workflow-contract';
import { buildRealtimeLane, realtimeDocumentTemplateSlug } from '../realtime-lane';
import { isRealtimeNode, realtimeHandlerFor } from '../realtime-node-registry';

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

  it('a core.action inherits its catalogue entry`s lane unless the instance overrides it', () => {
    expect(isRealtimeNode('core.action', { actionKey: 'consultation.persistDraft' })).toBe(false);
    expect(isRealtimeNode('core.action', { actionKey: 'consultation.persistDraft', execution: { lane: 'realtime' } })).toBe(true);
    expect(isRealtimeNode('core.action', { actionKey: 'nope' })).toBe(false);
  });

  it('no type is realtime by itself any more — a retired legacy key answers false', () => {
    expect(isRealtimeNode('consultation.captureBinding')).toBe(false);
    expect(isRealtimeNode('core.trigger')).toBe(false);
  });
});

describe('buildRealtimeLane admits core nodes by config', () => {
  it('admits a realtime core.agent and a realtime core.action, and leaves a durable core.agent to the interpreter', () => {
    const lane = buildRealtimeLane(
      compiled([
        { nodeId: 'live', type: 'core.agent', config: { agentRef: { slug: 'a' }, execution: { lane: 'realtime' } } },
        { nodeId: 'act', type: 'core.action', config: { actionKey: 'consultation.phiHop', execution: { lane: 'realtime' } } },
        { nodeId: 'final', type: 'core.agent', config: { agentRef: { slug: 'b' }, execution: { lane: 'durable' } } },
      ]),
    );
    expect(lane?.stages.flatMap((s) => s.nodes.map((n) => n.nodeId))).toEqual(['live', 'act']);
  });

  it('yields no lane for a graph of durable core nodes only', () => {
    expect(buildRealtimeLane(compiled([{ nodeId: 'final', type: 'core.agent', config: { agentRef: { slug: 'b' } } }]))).toBeNull();
  });

  it('reads the document template slug off the node that NAMES one (TASK-891 D7), or none', () => {
    const lane = buildRealtimeLane(
      compiled([
        { nodeId: 'ner', type: 'core.agent', config: { agentRef: { slug: 'medical-ner' }, execution: { lane: 'realtime' } } },
        { nodeId: 'note', type: 'core.agent', config: { agentRef: { slug: 'summ' }, execution: { lane: 'realtime' }, documentTemplateSlug: ' soap_note ' } },
      ]),
    );
    expect(realtimeDocumentTemplateSlug(lane)).toBe('soap_note');
    expect(realtimeDocumentTemplateSlug(buildRealtimeLane(compiled([{ nodeId: 'ner', type: 'core.agent', config: { execution: { lane: 'realtime' } } }])))).toBeNull();
    expect(realtimeDocumentTemplateSlug(null)).toBeNull();
  });
});

describe('realtimeHandlerFor — handlers by instance', () => {
  it('a realtime-configured action with no realtime handler resolves to none — the executor skips it observably', () => {
    expect(realtimeHandlerFor('core.action', { actionKey: 'consultation.phiHop', execution: { lane: 'realtime' } })).toBeUndefined();
    expect(realtimeHandlerFor('core.action', { actionKey: 'nope' })).toBeUndefined();
  });

  it('a core.agent resolves by type; its dispatch is decided at run time by the resolved task', () => {
    expect(realtimeHandlerFor('core.agent', { agentRef: { slug: 'x' } })?.type).toBe('core.agent');
  });
});
