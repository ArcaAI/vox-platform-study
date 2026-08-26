/**
 * TASK-809 Tasks 5/7 — type-checked edge validation, closing D-5 ("edge validation only checks
 * `fromPort`/`toPort` are non-empty strings", `graph-model.ts:34,36,160`).
 *
 * `workflowGraphProblems` stays registry-agnostic on purpose (it is the pure SHAPE check, and
 * the whole package layering depends on it having no registry knowledge). Port typing needs the
 * registry, so it lives here and is invoked EXPLICITLY at publish time and by the canvas's
 * `isValidConnection`. It is deliberately NOT folded into `validate()`'s default rule loop:
 * every graph authored before this ticket names its ports `in`/`out` untyped, so silently
 * promoting the check into `validate()` would retroactively invalidate every saved definition.
 * Wiring it into the publish path (and migrating the seeds) is TASK-812's lane.
 */
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { WORKFLOW_NODE_REGISTRY } from '../node-registry';
import { isValidConnection, workflowEdgePortProblems, workflowPublishProblems } from '../port-validation';

function graph(nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges']): WorkflowGraph {
  return { version: 1, nodes, edges };
}

describe('workflowEdgePortProblems — an edge must resolve to declared ports on both ends', () => {
  it('accepts an edge whose port types match exactly', () => {
    expect(
      workflowEdgePortProblems(
        graph(
          [
            { id: 'asr', type: 'stt.asrEngine', config: {} },
            { id: 'out', type: 'stt.transcriptOutput', config: {} },
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
            { id: 'gen', type: 'generate.text', config: {} },
            { id: 'guard', type: 'guardrail.check', config: {} },
          ],
          [{ id: 'e1', from: 'gen', fromPort: 'out', to: 'guard', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });

  it('REFUSES an edge whose port types are incompatible', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'audio', type: 'stt.audioInput', config: {} },
          { id: 'out', type: 'stt.transcriptOutput', config: {} },
        ],
        [{ id: 'e1', from: 'audio', fromPort: 'out', to: 'out', toPort: 'in' }],
      ),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/edges/0');
    expect(problems[0]).toContain('stream<audio>');
    expect(problems[0]).toContain('transcript');
  });

  it('REFUSES an unknown output port name (D-5: a non-empty string is not a port)', () => {
    const problems = workflowEdgePortProblems(
      graph(
        [
          { id: 'asr', type: 'stt.asrEngine', config: {} },
          { id: 'out', type: 'stt.transcriptOutput', config: {} },
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
          { id: 'asr', type: 'stt.asrEngine', config: {} },
          { id: 'out', type: 'stt.transcriptOutput', config: {} },
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
          { id: 'asr', type: 'stt.asrEngine', config: {} },
          { id: 'out', type: 'stt.transcriptOutput', config: {} },
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
          { id: 'b', type: 'core.end', config: {} },
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
          { id: 'audio', type: 'stt.audioInput', config: {} },
          { id: 'out', type: 'stt.transcriptOutput', config: {} },
        ],
        [
          { id: 'e1', from: 'audio', fromPort: 'out', to: 'out', toPort: 'in' },
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
            { id: 'start', type: 'core.start', config: {} },
            { id: 'end', type: 'core.end', config: {} },
          ],
          [{ id: 'e1', from: 'start', fromPort: 'next', to: 'end', toPort: 'after' }],
        ),
      ),
    ).toEqual([]);
  });
});

describe('isValidConnection — the canvas predicate (same relation, one edge at a time)', () => {
  it('agrees with workflowEdgePortProblems on a legal connection', () => {
    expect(isValidConnection('stt.asrEngine', 'out', 'stt.transcriptOutput', 'in')).toBe(true);
  });

  it('is false for an unregistered node type', () => {
    expect(isValidConnection('not.a.node', 'out', 'core.end', 'after')).toBe(false);
  });

  it('is false for an unknown port on either end', () => {
    expect(isValidConnection('stt.asrEngine', 'nope', 'stt.transcriptOutput', 'in')).toBe(false);
    expect(isValidConnection('stt.asrEngine', 'out', 'stt.transcriptOutput', 'nope')).toBe(false);
  });

  it('never throws on arbitrary input', () => {
    expect(() => isValidConnection('', '', '', '')).not.toThrow();
    expect(isValidConnection('', '', '', '')).toBe(false);
  });
});

describe('workflowPublishProblems — the publish gate', () => {
  it('is empty for a graph whose edges all type-check', () => {
    expect(
      workflowPublishProblems(
        graph(
          [
            { id: 'asr', type: 'stt.asrEngine', config: {} },
            { id: 'out', type: 'stt.transcriptOutput', config: {} },
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
    const problems = workflowPublishProblems(graph([{ id: 'a', type: 'core.start', config: {} }], []), {
      registry: {
        'core.start': { ...WORKFLOW_NODE_REGISTRY['core.start'], lane: 'durable', idempotent: false },
      },
    });
    expect(problems.some((problem) => problem.includes('idempotent'))).toBe(true);
  });
});

describe('requires[] — guard attachment, checked PER NODE INSTANCE', () => {
  // Every node in the shipped registry declares `requires: []` (no node demands a guard
  // attachment yet — the `guard.*` node types the target catalogue names do not exist).
  // The MECHANISM is what this ticket delivers, so it is exercised against a synthetic
  // registry overlay rather than by inventing a clinical policy the owner has not set.
  const overlay = {
    'generate.text': { ...WORKFLOW_NODE_REGISTRY['generate.text'], requires: ['guardrail.check'] },
  };

  it('REFUSES a node instance whose required guard is not attached to THAT instance', () => {
    const problems = workflowPublishProblems(
      graph(
        [
          { id: 'gen_a', type: 'generate.text', config: {} },
          { id: 'gen_b', type: 'generate.text', config: {} },
          { id: 'guard', type: 'guardrail.check', config: {} },
        ],
        [{ id: 'e1', from: 'gen_a', fromPort: 'out', to: 'guard', toPort: 'in' }],
      ),
      { registry: overlay },
    );
    // `gen_a` is guarded; `gen_b` is not — per-instance, not per-type.
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('gen_b');
    expect(problems[0]).toContain('guardrail.check');
  });

  it('accepts a graph where every instance carries its required guard', () => {
    const problems = workflowPublishProblems(
      graph(
        [
          { id: 'gen_a', type: 'generate.text', config: {} },
          { id: 'gen_b', type: 'generate.text', config: {} },
          { id: 'guard_a', type: 'guardrail.check', config: {} },
          { id: 'guard_b', type: 'guardrail.check', config: {} },
        ],
        [
          { id: 'e1', from: 'gen_a', fromPort: 'out', to: 'guard_a', toPort: 'in' },
          { id: 'e2', from: 'gen_b', fromPort: 'out', to: 'guard_b', toPort: 'in' },
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
            { id: 'gen', type: 'generate.text', config: {} },
            { id: 'deliver', type: 'output.deliver', config: {} },
          ],
          [{ id: 'e1', from: 'gen', fromPort: 'out', to: 'deliver', toPort: 'in' }],
        ),
      ),
    ).toEqual([]);
  });
});
