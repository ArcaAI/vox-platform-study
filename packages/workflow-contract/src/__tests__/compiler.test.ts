import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';

function baseCtx(overrides: Partial<CompilerContext> = {}): CompilerContext {
  return {
    definitionId: '018f1e0a-0000-7000-8000-000000000001',
    slug: 'summarization-default',
    versionNumber: 1,
    tenantId: '00000000-0000-0000-0000-000000000000',
    paletteKey: 'summarization',
    compilerVersion: '0.1.0',
    registryChecksum: 'reg-checksum-abc',
    ruleSetVersion: 1,
    caps: { maxTotalSeconds: 3600, maxNodeSeconds: 600, maxAttempts: 5 },
    policyBindings: {
      guardrailProfile: 'STANDARD',
      redactionRuleSetId: null,
      promptTemplateRefs: [],
      documentTemplateRefs: [],
      contextSchemaVersionId: null,
      entitlementKeys: [],
    },
    compiledAt: '2026-08-16T00:00:00.000Z',
    nodeInfo: (type: string) => {
      if (type === 'core.start' || type === 'core.end') return { activity: 'noop', classes: ['terminal'] };
      if (type === 'consent.gate') return { activity: 'record_gate_decision', classes: ['gate'] };
      return { activity: 'generate', classes: [] };
    },
    ...overrides,
  };
}

function graph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_start', type: 'core.start', config: {} },
      { id: 'n_gate', type: 'consent.gate', config: { gateType: 'hitl', onTimeout: 'TIMED_OUT' } },
      { id: 'n_a1', type: 'summarization.generate', config: { onError: 'fail' } },
      { id: 'n_end', type: 'core.end', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_start', fromPort: 'out', to: 'n_gate', toPort: 'in' },
      { id: 'e2', from: 'n_gate', fromPort: 'out', to: 'n_a1', toPort: 'text' },
      { id: 'e3', from: 'n_a1', fromPort: 'out', to: 'n_end', toPort: 'in' },
    ],
  };
}

describe('compile', () => {
  it('produces a config with gates lifted out of stages', () => {
    const result = compile(graph(), baseCtx());
    expect('config' in result).toBe(true);
    const { config } = result as { config: { gates: unknown[]; stages: Array<{ nodes: Array<{ nodeId: string }> }> } };
    expect(config.gates).toHaveLength(1);
    const stageNodeIds = config.stages.flatMap((s) => s.nodes.map((n) => n.nodeId));
    expect(stageNodeIds).not.toContain('n_gate');
    expect(stageNodeIds).toContain('n_a1');
  });

  it('clamps timeout and retry to caps', () => {
    const g = graph();
    g.nodes[2]!.config = { onError: 'fail', timeoutSeconds: 99999, retry: { maximumAttempts: 999 } };
    const result = compile(g, baseCtx()) as { config: { stages: Array<{ nodes: Array<{ nodeId: string; timeoutSeconds: number; retry: { maximumAttempts: number } }> }> } };
    const node = result.config.stages.flatMap((s) => s.nodes).find((n) => n.nodeId === 'n_a1')!;
    expect(node.timeoutSeconds).toBeLessThanOrEqual(600);
    expect(node.retry.maximumAttempts).toBeLessThanOrEqual(5);
  });

  it('every activity node has emitsTrajectory: true', () => {
    const result = compile(graph(), baseCtx()) as { config: { stages: Array<{ nodes: Array<{ emitsTrajectory: boolean }> }> } };
    for (const stage of result.config.stages) {
      for (const node of stage.nodes) expect(node.emitsTrajectory).toBe(true);
    }
  });

  it('is byte-identical across repeated compiles of the same graph', () => {
    const checksums = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      const result = compile(graph(), baseCtx()) as { config: { checksum: string } };
      checksums.add(result.config.checksum);
    }
    expect(checksums.size).toBe(1);
  });

  it('is invariant to node/edge array shuffling', () => {
    const g = graph();
    const shuffled: WorkflowGraph = {
      version: 1,
      nodes: [...g.nodes].reverse(),
      edges: [...g.edges].reverse(),
    };
    const a = compile(g, baseCtx()) as { config: { checksum: string } };
    const b = compile(shuffled, baseCtx()) as { config: { checksum: string } };
    expect(a.config.checksum).toBe(b.config.checksum);
  });

  it('returns findings instead of throwing for a cyclic graph', () => {
    const g: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'a', type: 'x', config: {} },
        { id: 'b', type: 'x', config: {} },
      ],
      edges: [
        { id: 'e1', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' },
        { id: 'e2', from: 'b', fromPort: 'out', to: 'a', toPort: 'in' },
      ],
    };
    const result = compile(g, baseCtx());
    expect('findings' in result).toBe(true);
  });

  it('never throws on a malformed graph', () => {
    expect(() => compile({ version: 1, nodes: [], edges: [] }, baseCtx())).not.toThrow();
  });
});
