/**
 * Tasks 5/7 — type-checked edge validation, closing D-5 ("edge validation only checks
 * `fromPort`/`toPort` are non-empty strings", `graph-model.ts:34,36,160`).
 *
 * `workflowGraphProblems` stays registry-agnostic on purpose (it is the pure SHAPE check, and
 * the whole package layering depends on it having no registry knowledge). Port typing needs the
 * registry, so it lives here and is invoked EXPLICITLY at publish time and by the canvas's
 * `isValidConnection`. It is deliberately NOT folded into `validate()`'s default rule loop:
 * every graph authored before this ticket names its ports `in`/`out` untyped, so silently
 * promoting the check into `validate()` would retroactively invalidate every saved definition.
 * Wiring it into the publish path (and migrating the seeds) is lane.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { isValidConnection, workflowEdgePortProblems } from '../port-validation';
import { publishProblems as workflowPublishProblems } from './publish-problems.helper';

function graph(nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph {
  return { version: 1, nodes, edges };
}

/** `core.data`'s one required field. The port-typing assertions never read it, but the publish
 *  gate validates every node's config, so a bare `{}` would fail on the schema rather than on
 *  the port relation the test is actually about. */
const DATA_CONFIG = { mappings: [{ from: 'in.value', to: 'value' }] } as const;

describe('workflowEdgePortProblems — an edge must resolve to declared ports on both ends', () => {
  it('accepts an edge whose port types match exactly', () => {
    expect(
      workflowEdgePortProblems(
        graph(
          [
            { id: 'asr', type: 'core.data', config: DATA_CONFIG },
            { id: 'out', type: 'core.data', config: DATA_CONFIG },
          ],
          [{ id: 'e1', from: 'asr', fromPort: 'out', to: 'out', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });

  it('accepts an edge that WIDENS — a document satisfies a text input (a guardrail may read generated prose)', () => {
    expect(
      workflowEdgePortProblems(
        graph(
          [
            { id: 'gen', type: 'core.action', config: { actionKey: 'consultation.sensors', action: { onError: 'degrade' } } },
            { id: 'guard', type: 'core.action', config: { actionKey: 'guard.moderation', action: { guardrailType: 'groundedness', failOn: 'unsafe_or_unknown', onFail: 'mark' } } },
          ],
          [{ id: 'e1', from: 'gen', fromPort: 'document', to: 'guard', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });

  it('REFUSES an edge whose port types are incompatible', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'audio', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'out', type: 'core.data', config: DATA_CONFIG },
        ],
        [{ id: 'e1', from: 'audio', fromPort: 'audio', to: 'out', toPort: 'in' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/edges/0');
    expect(problems[0]).toContain('audio');
    expect(problems[0]).toContain('object');
  });

  it('REFUSES an unknown output port name (D-5: a non-empty string is not a port)', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'asr', type: 'core.data', config: DATA_CONFIG },
          { id: 'out', type: 'core.data', config: DATA_CONFIG },
        ],
        [{ id: 'e1', from: 'asr', fromPort: 'not_a_port', to: 'out', toPort: 'in' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('fromPort');
    expect(problems[0]).toContain('not_a_port');
  });

  it('REFUSES an unknown input port name', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'asr', type: 'core.data', config: DATA_CONFIG },
          { id: 'out', type: 'core.data', config: DATA_CONFIG },
        ],
        [{ id: 'e1', from: 'asr', fromPort: 'out', to: 'out', toPort: 'not_a_port' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('toPort');
  });

  it('REFUSES an edge that points OUT of an input port or INTO an output port', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'asr', type: 'core.data', config: DATA_CONFIG },
          { id: 'out', type: 'core.data', config: DATA_CONFIG },
        ],
        // `in` is an INPUT port on stt.asrEngine — it cannot be an edge source.
        [{ id: 'e1', from: 'asr', fromPort: 'in', to: 'out', toPort: 'in' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('fromPort');
  });

  it('reports an unregistered node type rather than silently skipping the edge', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'a', type: 'not.a.node', config: {} },
          { id: 'b', type: 'core.output', config: {} },
        ],
        [{ id: 'e1', from: 'a', fromPort: 'next', to: 'b', toPort: 'after' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('not.a.node');
  });

  it('is total — a structurally broken graph yields problems, never a throw', () => {
    expect(() => workflowEdgePortProblems({ version: 1, nodes: [], edges: [{ id: 'e', from: 'x', fromPort: 'out', to: 'y', toPort: 'in' }] })).not.toThrow();
  });

  it('reports EVERY bad edge in one pass, not just the first', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'audio', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'out', type: 'core.data', config: DATA_CONFIG },
        ],
        [
          { id: 'e1', from: 'audio', fromPort: 'audio', to: 'out', toPort: 'in' },
          { id: 'e2', from: 'audio', fromPort: 'nope', to: 'out', toPort: 'in' },
        ],
      ),
    );
    expect(problems).toHaveLength(2);
  });

  it('accepts a pure ordering edge between control ports', () => {
    expect(
      workflowEdgePortProblems(
        graph(
          [
            { id: 'start', type: 'core.trigger', config: {} },
            { id: 'end', type: 'core.output', config: {} },
          ],
          [{ id: 'e1', from: 'start', fromPort: 'next', to: 'end', toPort: 'after' }],
        ),
      ),
    ).toEqual([]);
  });
});

describe('isValidConnection — the canvas predicate (same relation, one edge at a time)', () => {
  it('agrees with workflowEdgePortProblems on a legal connection', () => {
    expect(isValidConnection('core.data', 'out', 'core.data', 'in')).toBe(true);
  });

  it('is false for an unregistered node type', () => {
    expect(isValidConnection('not.a.node', 'out', 'core.output', 'after')).toBe(false);
  });

  it('is false for an unknown port on either end', () => {
    expect(isValidConnection('core.data', 'nope', 'core.data', 'in')).toBe(false);
    expect(isValidConnection('core.data', 'out', 'core.data', 'nope')).toBe(false);
  });

  it('never throws on arbitrary input', () => {
    expect(() => isValidConnection('', '', '', '')).not.toThrow();
    expect(isValidConnection('', '', '', '')).toBe(false);
  });
});

describe('the publish gate (now `publishFindings`, via the string adapter)', () => {
  it('is empty for a graph whose edges all type-check', () => {
    expect(
      workflowPublishProblems(
        graph(
          [
            { id: 'asr', type: 'core.data', config: DATA_CONFIG },
            { id: 'out', type: 'core.data', config: DATA_CONFIG },
          ],
          [{ id: 'e1', from: 'asr', fromPort: 'out', to: 'out', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });

  it('surfaces edge type errors', () => {
    const problems = workflowPublishProblems(
      graph(
        [
          { id: 'synth', type: 'consultation.synthesize', config: {} },
          { id: 'ner', type: 'consultation.extractEntities', config: {} },
        ],
        [{ id: 'e1', from: 'synth', fromPort: 'out', to: 'ner', toPort: 'in' }],
      ),
    );
    expect(problems.length).toBeGreaterThan(0);
  });

  it('surfaces a descriptor-contract violation for a node type used by the graph', () => {
    const problems = workflowPublishProblems(graph([{ id: 'a', type: 'core.data', config: DATA_CONFIG }], []), {
      registry: {
        'core.data': { ...WORKFLOW_NODE_REGISTRY['core.data'], lane: 'durable', idempotent: false },
      },
    });
    expect(problems.some((problem) => problem.includes('idempotent'))).toBe(true);
  });
});

describe('requires[] — guard attachment, checked PER NODE INSTANCE', () => {
  // Every node in the shipped registry declares `requires: []` (no node demands a guard
  // attachment). The MECHANISM is what this ticket delivers, so it is exercised against a
  // synthetic registry overlay rather than by inventing a clinical policy the owner has not set.
  const overlay = {
    'core.agent': { ...WORKFLOW_NODE_REGISTRY['core.agent'], requires: ['core.data'] },
  };

  it('REFUSES a node instance whose required guard is not attached to THAT instance', () => {
    const problems = workflowPublishProblems(
      graph(
        [
          { id: 'gen_a', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'gen_b', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'guard', type: 'core.data', config: DATA_CONFIG },
        ],
        [{ id: 'e1', from: 'gen_a', fromPort: 'data', to: 'guard', toPort: 'in' }],
      ),
      { registry: overlay },
    );
    // `gen_a` is guarded; `gen_b` is not — per-instance, not per-type.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gen_b');
    expect(problems[0]).toContain('core.data');
  });

  it('accepts a graph where every instance carries its required guard', () => {
    const problems = workflowPublishProblems(
      graph(
        [
          { id: 'gen_a', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'gen_b', type: 'core.agent', config: { agentRef: { slug: 'demo-agent' } } },
          { id: 'guard_a', type: 'core.data', config: DATA_CONFIG },
          { id: 'guard_b', type: 'core.data', config: DATA_CONFIG },
        ],
        [
          { id: 'e1', from: 'gen_a', fromPort: 'data', to: 'guard_a', toPort: 'in' },
          { id: 'e2', from: 'gen_b', fromPort: 'data', to: 'guard_b', toPort: 'in' },
        ],
      ),
      { registry: overlay },
    );
    expect(problems).toEqual([]);
  });

  it('imposes nothing when the descriptor requires nothing (every node today)', () => {
    expect(
      workflowPublishProblems(
        graph(
          [
            { id: 'gen', type: 'core.data', config: DATA_CONFIG },
            { id: 'deliver', type: 'core.output', config: {} },
          ],
          [{ id: 'e1', from: 'gen', fromPort: 'out', to: 'deliver', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });
});
