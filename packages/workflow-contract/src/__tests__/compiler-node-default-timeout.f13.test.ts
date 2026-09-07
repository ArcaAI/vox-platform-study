import { describe, expect, it } from 'vitest';
import { compile } from '../compiler';
import type { CompilerContext } from '../compiler';
import type { WorkflowGraph } from '../graph-model';
import { nodeInfo, WORKFLOW_NODE_REGISTRY } from '../node-registry';

/**
 * F13 — a node the author left untimed gets the budget its own TYPE declares.
 *
 * The compiler stamped one flat 60 s on every untimed node while the registry already declared
 * a per-type `defaultTimeoutSeconds` (`core.agent`: 300, `core.humanReview`: 3600, …). 60 s is
 * BELOW the harness's own per-call text budget (`HARNESS_TEXT_TIMEOUT_S`, 120 s —
 * `apps/harness/src/harness/core/config.py`), so a local-model `core.agent` was cancelled
 * mid-generation and reported a bare `activity_error` unless the author knew to set
 * `timeoutSeconds` by hand. The number is not restated here: it is the registry's, mirrored
 * once in `apps/harness/.../interpreter/registry.py` and held there by
 * `test_node_registry_parity.py`.
 */

function ctx(overrides: Partial<CompilerContext> = {}): CompilerContext {
  return {
    definitionId: '018f1e0a-0000-7000-8000-000000000001',
    slug: 'f13-defaults',
    versionNumber: 1,
    tenantId: '00000000-0000-0000-0000-000000000000',
    paletteKey: 'core',
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
    nodeInfo,
    ...overrides,
  };
}

function graph(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
      { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'a' } } },
      { id: 'n_classify', type: 'core.classify', config: { modelSlug: 'm', classes: [{ key: 'k', label: 'K' }] } },
      { id: 'n_out', type: 'core.output', config: {} },
    ],
    edges: [
      { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_agent', toPort: 'in' },
      { id: 'e2', from: 'n_agent', fromPort: 'out', to: 'n_classify', toPort: 'in' },
      { id: 'e3', from: 'n_classify', fromPort: 'out', to: 'n_out', toPort: 'in' },
    ],
  };
}

function compiledNodes(result: unknown): Map<string, number> {
  const { config } = result as { config: { stages: Array<{ nodes: Array<{ nodeId: string; timeoutSeconds: number }> }> } };
  return new Map(config.stages.flatMap((s) => s.nodes).map((n) => [n.nodeId, n.timeoutSeconds]));
}

describe('compiled per-node timeout default', () => {
  it('an untimed node takes its registry-declared budget, not one flat number', () => {
    const timeouts = compiledNodes(compile(graph(), ctx()));

    expect(timeouts.get('n_agent')).toBe(WORKFLOW_NODE_REGISTRY['core.agent']!.defaultTimeoutSeconds);
    expect(timeouts.get('n_classify')).toBe(WORKFLOW_NODE_REGISTRY['core.classify']!.defaultTimeoutSeconds);
  });

  it("core.agent's default covers the harness's own 120 s text budget", () => {
    // The defect this test exists for: 60 < 120, so a local-model generation was cancelled
    // while the text client was still legitimately waiting on it.
    expect(compiledNodes(compile(graph(), ctx())).get('n_agent')!).toBeGreaterThan(120);
  });

  it('an authored timeoutSeconds still wins, and is still clamped', () => {
    const g = graph();
    g.nodes[1]!.config = { agentRef: { slug: 'a' }, timeoutSeconds: 45 };
    expect(compiledNodes(compile(g, ctx())).get('n_agent')).toBe(45);

    g.nodes[1]!.config = { agentRef: { slug: 'a' }, timeoutSeconds: 99999 };
    expect(compiledNodes(compile(g, ctx())).get('n_agent')).toBe(600);
  });

  it('a context whose nodeInfo declares no default keeps the legacy 60 s', () => {
    const timeouts = compiledNodes(
      compile(graph(), ctx({ nodeInfo: (type: string) => ({ activity: nodeInfo(type)!.activity, classes: [...nodeInfo(type)!.classes] }) })),
    );

    expect(timeouts.get('n_agent')).toBe(60);
  });
});
