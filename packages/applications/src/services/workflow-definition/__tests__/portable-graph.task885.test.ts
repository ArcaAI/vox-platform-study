/**
 * TASK-885 — the pure graph rewrite that makes a workflow definition PORTABLE.
 *
 * The unit under test is the half of import/export that has no database in it: turning row ids
 * into portable keys and back. Everything asserted here is a VALUE rule — what may leave a
 * tenant, and what a bundle must never carry — so it is tested without a service, a repository
 * or a mock.
 *
 * Written RED-first: every test in this file failed against `8a177ce19`, where
 * `portable-graph.ts` did not exist.
 */
import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@arcaai/workflow-contract';
import { collectPortableReferences, collectRowReferences, toPortableGraph, toTenantGraph } from '../portable-graph';

const graph = (nodes: unknown[]): WorkflowGraph => ({ version: 1, nodes, edges: [] }) as unknown as WorkflowGraph;

describe('portable-graph — export direction', () => {
  it('collects every row reference, including one nested inside an array of policies', () => {
    const source = graph([
      { id: 'n_gen', type: 'agentic.agent', config: { promptTemplateId: 'tpl-1', promptVersionNumber: 4 } },
      { id: 'n_doc', type: 'agentic.document', config: { documentTemplateId: 'doc-1', documentVersionNumber: 2 } },
      { id: 'n_tools', type: 'agentic.tools', config: { tools: [{ mcpServerId: 'mcp-1', toolName: 'search' }] } },
      { id: 'n_guard', type: 'agentic.guardrail', config: { policies: [{ key: 'k', appliesTo: 'input', promptTemplateId: 'tpl-2' }] } },
      { id: 'n_llm', type: 'agentic.llm', config: { providerConfigRef: { routingPolicyId: 'pol-1' } } },
    ]);

    expect(collectRowReferences(source)).toEqual([
      { nodeId: 'n_gen', kind: 'promptTemplate', id: 'tpl-1' },
      { nodeId: 'n_doc', kind: 'documentTemplate', id: 'doc-1' },
      { nodeId: 'n_tools', kind: 'mcpServer', id: 'mcp-1' },
      { nodeId: 'n_guard', kind: 'promptTemplate', id: 'tpl-2' },
      { nodeId: 'n_llm', kind: 'routingPolicy', id: 'pol-1' },
    ]);
  });

  it('rewrites row ids into portable refs, drops the version pins, and reports the portable manifest', () => {
    const source = graph([
      { id: 'n_gen', type: 'agentic.agent', config: { promptTemplateId: 'tpl-1', promptVersionNumber: 4, temperature: 0.2 } },
      { id: 'n_doc', type: 'agentic.document', config: { documentTemplateId: 'doc-1', documentVersionNumber: 2 } },
    ]);

    const result = toPortableGraph(
      source,
      new Map([
        ['promptTemplate:tpl-1', 'Discharge Summary'],
        ['documentTemplate:doc-1', 'soap-note'],
      ]),
    );

    expect(result.unresolved).toEqual([]);
    expect(result.graph.nodes[0].config).toEqual({ promptTemplateRef: { name: 'Discharge Summary' }, temperature: 0.2 });
    expect(result.graph.nodes[1].config).toEqual({ documentTemplateRef: { slug: 'soap-note' } });
    expect(result.references).toEqual([
      { nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary' },
      { nodeId: 'n_doc', kind: 'documentTemplate', key: 'soap-note' },
    ]);
  });

  it('downgrades a pinned routingPolicyId to the portable taskKey the row serves', () => {
    const source = graph([{ id: 'n_llm', type: 'agentic.llm', config: { providerConfigRef: { routingPolicyId: 'pol-1' } } }]);

    const result = toPortableGraph(source, new Map([['routingPolicy:pol-1', 'text.finalize']]));

    expect(result.graph.nodes[0].config).toEqual({ providerConfigRef: { taskKey: 'text.finalize' } });
    expect(result.references).toEqual([{ nodeId: 'n_llm', kind: 'routingTask', key: 'text.finalize' }]);
  });

  it('STRIPS every evalGate — a goldenSetId names a corpus of encrypted PHI and never leaves the tenant', () => {
    const source = graph([{ id: 'n_gen', type: 'agentic.agent', config: { evalGate: { goldenSetId: 'gs-1', enabled: true }, temperature: 0.2 } }]);

    const result = toPortableGraph(source, new Map());

    expect(result.graph.nodes[0].config).toEqual({ temperature: 0.2 });
    expect(JSON.stringify(result.graph)).not.toContain('gs-1');
  });

  it('drops an agentRef version pin but keeps the slug, and reports agent + model as portable references', () => {
    const source = graph([
      { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'soap-writer', versionNumber: 7 }, overrides: {} } },
      { id: 'n_ner', type: 'agentic.ner', config: { modelSlug: 'gliner-medium', classes: ['drug'] } },
    ]);

    const result = toPortableGraph(source, new Map());

    expect(result.graph.nodes[0].config).toEqual({ agentRef: { slug: 'soap-writer' }, overrides: {} });
    expect(result.references).toEqual([
      { nodeId: 'n_agent', kind: 'agent', key: 'soap-writer' },
      { nodeId: 'n_ner', kind: 'model', key: 'gliner-medium' },
    ]);
  });

  it('reports a row reference the caller could not resolve instead of emitting the raw id', () => {
    const source = graph([{ id: 'n_gen', type: 'agentic.agent', config: { promptTemplateId: 'tpl-gone' } }]);

    const result = toPortableGraph(source, new Map());

    expect(result.unresolved).toEqual([{ nodeId: 'n_gen', kind: 'promptTemplate', id: 'tpl-gone' }]);
    expect(JSON.stringify(result.graph)).not.toContain('tpl-gone');
  });

  it('never mutates the input graph', () => {
    const source = graph([{ id: 'n_gen', type: 'agentic.agent', config: { promptTemplateId: 'tpl-1', promptVersionNumber: 4 } }]);
    const before = JSON.stringify(source);

    toPortableGraph(source, new Map([['promptTemplate:tpl-1', 'Discharge Summary']]));

    expect(JSON.stringify(source)).toBe(before);
  });
});

describe('portable-graph — import direction', () => {
  const bundleGraph = graph([
    { id: 'n_gen', type: 'agentic.agent', config: { promptTemplateRef: { name: 'Discharge Summary' } } },
    { id: 'n_doc', type: 'agentic.document', config: { documentTemplateRef: { slug: 'soap-note' } } },
    { id: 'n_tools', type: 'agentic.tools', config: { tools: [{ mcpServerRef: { name: 'Formulary' }, toolName: 'search' }] } },
    { id: 'n_llm', type: 'agentic.llm', config: { providerConfigRef: { taskKey: 'text.finalize' } } },
    { id: 'n_agent', type: 'core.agent', config: { agentRef: { slug: 'soap-writer' } } },
    { id: 'n_ner', type: 'agentic.ner', config: { modelSlug: 'gliner-medium' } },
  ]);

  it('collects every portable reference the bundle makes, including the verify-only kinds', () => {
    expect(collectPortableReferences(bundleGraph)).toEqual([
      { nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary' },
      { nodeId: 'n_doc', kind: 'documentTemplate', key: 'soap-note' },
      { nodeId: 'n_tools', kind: 'mcpServer', key: 'Formulary' },
      { nodeId: 'n_llm', kind: 'routingTask', key: 'text.finalize' },
      { nodeId: 'n_agent', kind: 'agent', key: 'soap-writer' },
      { nodeId: 'n_ner', kind: 'model', key: 'gliner-medium' },
    ]);
  });

  it('resolves the rewritten kinds back into this tenant’s row ids and leaves the portable kinds alone', () => {
    const result = toTenantGraph(
      bundleGraph,
      new Map([
        ['promptTemplate:Discharge Summary', 'tpl-target-1'],
        ['documentTemplate:soap-note', 'doc-target-1'],
        ['mcpServer:Formulary', 'mcp-target-1'],
      ]),
    );

    expect(result.unresolved).toEqual([]);
    expect(result.graph.nodes[0].config).toEqual({ promptTemplateId: 'tpl-target-1' });
    expect(result.graph.nodes[1].config).toEqual({ documentTemplateId: 'doc-target-1' });
    expect(result.graph.nodes[2].config).toEqual({ tools: [{ mcpServerId: 'mcp-target-1', toolName: 'search' }] });
    expect(result.graph.nodes[3].config).toEqual({ providerConfigRef: { taskKey: 'text.finalize' } });
    expect(result.graph.nodes[4].config).toEqual({ agentRef: { slug: 'soap-writer' } });
  });

  it('names every reference this tenant cannot resolve rather than importing a dangling row id', () => {
    const result = toTenantGraph(bundleGraph, new Map([['documentTemplate:soap-note', 'doc-target-1']]));

    expect(result.unresolved).toEqual([
      { nodeId: 'n_gen', kind: 'promptTemplate', key: 'Discharge Summary' },
      { nodeId: 'n_tools', kind: 'mcpServer', key: 'Formulary' },
    ]);
  });
});
