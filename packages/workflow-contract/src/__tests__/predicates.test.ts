import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import type { WorkflowEvaluationContext } from '../predicates/context';
import { evaluatePredicate, predicateConfigProblems, WORKFLOW_RULE_PREDICATE_TYPES } from '../predicates';

function ctx(classes: Record<string, readonly string[]> = {}): WorkflowEvaluationContext {
  return {
    paletteKey: 'summarization',
    registry: {
      classesOf: (type: string) => classes[type] ?? [],
      paletteOf: () => 'summarization',
    },
  };
}

function graph(nodes: Array<[string, string]>, edges: Array<[string, string]>): WorkflowGraph {
  return {
    version: 1,
    nodes: nodes.map(([id, type]) => ({ id, type, config: {} })),
    edges: edges.map(([from, to], i) => ({ id: `e${i}`, from, fromPort: 'out', to, toPort: 'in' })),
  };
}

describe('WORKFLOW_RULE_PREDICATE_TYPES', () => {
  it('is the closed catalogue of 11 kinds', () => {
    expect(WORKFLOW_RULE_PREDICATE_TYPES.length).toBe(11);
  });
});

describe('ACYCLIC', () => {
  it('is clean on a DAG', () => {
    const g = graph([['a', 't'], ['b', 't']], [['a', 'b']]);
    expect(evaluatePredicate('ACYCLIC', g, ctx(), {}, 'WF-S-001')).toEqual([]);
  });

  it('reports a cycle as a graph-level ERROR finding', () => {
    const g = graph([['a', 't'], ['b', 't']], [['a', 'b'], ['b', 'a']]);
    const findings = evaluatePredicate('ACYCLIC', g, ctx(), {}, 'WF-S-001');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ ruleId: 'WF-S-001', severity: 'ERROR', nodeId: null });
  });
});

describe('SINGLE_ENTRY', () => {
  it('requires exactly one node of the entry type', () => {
    const g = graph([['s1', 'core.start'], ['s2', 'core.start']], []);
    const findings = evaluatePredicate('SINGLE_ENTRY', g, ctx(), { entryType: 'core.start' }, 'WF-S-002');
    expect(findings).toHaveLength(1);
  });

  it('is clean with exactly one entry', () => {
    const g = graph([['s1', 'core.start']], []);
    expect(evaluatePredicate('SINGLE_ENTRY', g, ctx(), { entryType: 'core.start' }, 'WF-S-002')).toEqual([]);
  });

  it('reports zero entries', () => {
    const g = graph([['a', 'other']], []);
    const findings = evaluatePredicate('SINGLE_ENTRY', g, ctx(), { entryType: 'core.start' }, 'WF-S-002');
    expect(findings).toHaveLength(1);
  });
});

describe('REACHABLE_FROM_ENTRY', () => {
  it('flags an orphan node', () => {
    const g = graph([['s', 'core.start'], ['a', 'x'], ['orphan', 'x']], [['s', 'a']]);
    const findings = evaluatePredicate('REACHABLE_FROM_ENTRY', g, ctx(), { entryType: 'core.start' }, 'WF-S-003');
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeId).toBe('orphan');
  });
});

describe('REACHES_TERMINAL', () => {
  it('flags a dead end', () => {
    const g = graph([['s', 'core.start'], ['t', 'core.end'], ['dead', 'x']], [['s', 't'], ['s', 'dead']]);
    const findings = evaluatePredicate('REACHES_TERMINAL', g, ctx(), { terminalType: 'core.end' }, 'WF-S-004');
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeId).toBe('dead');
  });
});

describe('BOUND', () => {
  it('flags a graph over the node-count bound', () => {
    const g = graph([['a', 'x'], ['b', 'x'], ['c', 'x']], []);
    const findings = evaluatePredicate('BOUND', g, ctx(), { maxNodes: 2 }, 'WF-S-005');
    expect(findings).toHaveLength(1);
  });
});

describe('FORBIDDEN_NODE_TYPE', () => {
  it('flags every node of the forbidden type', () => {
    const g = graph([['a', 'sign'], ['b', 'ok']], []);
    const findings = evaluatePredicate('FORBIDDEN_NODE_TYPE', g, ctx(), { nodeType: 'sign' }, 'WF-S-006');
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeId).toBe('a');
  });

  it('matches by node class', () => {
    const g = graph([['a', 'sign.v2']], []);
    const findings = evaluatePredicate(
      'FORBIDDEN_NODE_TYPE',
      g,
      ctx({ 'sign.v2': ['signing'] }),
      { nodeClass: 'signing' },
      'WF-S-006',
    );
    expect(findings).toHaveLength(1);
  });
});

describe('REQUIRED_NODE_TYPE', () => {
  it('flags an under-count', () => {
    const g = graph([['a', 'x']], []);
    const findings = evaluatePredicate('REQUIRED_NODE_TYPE', g, ctx(), { nodeType: 'gate', minCount: 1 }, 'WF-I-003');
    expect(findings).toHaveLength(1);
    expect(findings[0].nodeId).toBeNull();
  });
});

describe('REQUIRED_PATH_THROUGH', () => {
  it('flags a bypass around a gate', () => {
    const g = graph(
      [['s', 'core.start'], ['gate', 'gate'], ['t', 'core.end']],
      [['s', 'gate'], ['gate', 't'], ['s', 't']],
    );
    const findings = evaluatePredicate(
      'REQUIRED_PATH_THROUGH',
      g,
      ctx(),
      { fromType: 'core.start', toType: 'core.end', throughType: 'gate' },
      'WF-S-007',
    );
    expect(findings).toHaveLength(1);
  });

  it('is clean when every path is gated', () => {
    const g = graph([['s', 'core.start'], ['gate', 'gate'], ['t', 'core.end']], [['s', 'gate'], ['gate', 't']]);
    const findings = evaluatePredicate(
      'REQUIRED_PATH_THROUGH',
      g,
      ctx(),
      { fromType: 'core.start', toType: 'core.end', throughType: 'gate' },
      'WF-S-007',
    );
    expect(findings).toEqual([]);
  });
});

describe('FORBIDDEN_PATH', () => {
  it('flags any route between two classes', () => {
    const g = graph([['phi', 'phi.read'], ['dna', 'style.write']], [['phi', 'dna']]);
    const findings = evaluatePredicate(
      'FORBIDDEN_PATH',
      g,
      ctx({ 'phi.read': ['phiBearing'], 'style.write': ['styleDna'] }),
      { fromClass: 'phiBearing', toClass: 'styleDna' },
      'WF-I-006',
    );
    expect(findings).toHaveLength(1);
  });
});

describe('ORDERED_BEFORE', () => {
  it('flags an inversion — an after-node reaching a before-node', () => {
    const g = graph(
      [['gen', 'summarization.generate'], ['gate', 'consent.gate']],
      [['gen', 'gate']],
    );
    const findings = evaluatePredicate(
      'ORDERED_BEFORE',
      g,
      ctx({ 'consent.gate': ['consentGate'], 'summarization.generate': ['generation'] }),
      { beforeClass: 'consentGate', afterClass: 'generation' },
      'WF-I-007',
    );
    expect(findings).toHaveLength(1);
  });

  it('is clean when the gate precedes generation', () => {
    const g = graph(
      [['gate', 'consent.gate'], ['gen', 'summarization.generate']],
      [['gate', 'gen']],
    );
    const findings = evaluatePredicate(
      'ORDERED_BEFORE',
      g,
      ctx({ 'consent.gate': ['consentGate'], 'summarization.generate': ['generation'] }),
      { beforeClass: 'consentGate', afterClass: 'generation' },
      'WF-I-007',
    );
    expect(findings).toEqual([]);
  });
});

describe('CONFIG_PREDICATE', () => {
  it('flags a missing required field (present)', () => {
    const g: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'a', type: 'summarization.generate', config: {} }],
      edges: [],
    };
    const findings = evaluatePredicate(
      'CONFIG_PREDICATE',
      g,
      ctx(),
      { appliesTo: { nodeType: 'summarization.generate' }, field: 'onError', op: 'present' },
      'WF-I-002',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].path).toBe('/onError');
  });

  it('evaluates lte on a nested field', () => {
    const g: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'a', type: 'x', config: { retry: { maximumAttempts: 9 } } }],
      edges: [],
    };
    const findings = evaluatePredicate(
      'CONFIG_PREDICATE',
      g,
      ctx(),
      { appliesTo: { nodeType: 'x' }, field: 'retry.maximumAttempts', op: 'lte', value: 5 },
      'WF-I-010',
    );
    expect(findings).toHaveLength(1);
  });

  it('is clean when the value satisfies the comparison', () => {
    const g: WorkflowGraph = {
      version: 1,
      nodes: [{ id: 'a', type: 'x', config: { retry: { maximumAttempts: 3 } } }],
      edges: [],
    };
    const findings = evaluatePredicate(
      'CONFIG_PREDICATE',
      g,
      ctx(),
      { appliesTo: { nodeType: 'x' }, field: 'retry.maximumAttempts', op: 'lte', value: 5 },
      'WF-I-010',
    );
    expect(findings).toEqual([]);
  });
});

describe('totality', () => {
  it('never throws on a malformed config for any predicate kind', () => {
    const g = graph([['a', 'x']], []);
    for (const type of WORKFLOW_RULE_PREDICATE_TYPES) {
      expect(() => evaluatePredicate(type, g, ctx(), { garbage: [1, 2, {}] }, 'WF-X-000')).not.toThrow();
      expect(() => predicateConfigProblems(type, { garbage: true })).not.toThrow();
    }
  });

  it('reports a malformed predicateConfig as its own problem', () => {
    expect(predicateConfigProblems('BOUND', { maxNodes: 'not-a-number' })).not.toEqual([]);
  });
});
