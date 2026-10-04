/**
 * TASK-1036 §9.2 (OD-29 / OD-18) — the binding model, the legacy edge translation, and the
 * publish rules over bindings.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { BINDING_JSON_SCHEMA, bindingIssues, compiledBindings, edgeAncestors, edgeImpliedBindings, isBinding, type BindingIssue } from '../bindings';
import type { WorkflowGraph, WorkflowGraphEdge, WorkflowGraphNode } from '../graph-model';
import type { AgentIOResolver } from '../node-io';

const AGENTS: AgentIOResolver = {
  asr: { task: 'SPEECH_TO_TEXT' },
  ner: { task: 'NAMED_ENTITY_RECOGNITION' },
  summary: { task: 'TEXT_GENERATION' },
  finalize: {
    task: 'TEXT_GENERATION',
    outputSchema: { type: 'object', required: ['case_note'], properties: { case_note: { type: 'string' }, redactions: { type: 'array' } } },
  },
  tts: { task: 'TEXT_TO_SPEECH' },
};

function e(from: string, fromPort: string, to: string, toPort: string, id = `${from}-${fromPort}-${to}-${toPort}`): WorkflowGraphEdge {
  return { id, from, fromPort, to, toPort };
}

function agent(id: string, slug: string, extra: Record<string, unknown> = {}): WorkflowGraphNode {
  return { id, type: 'core.agent', config: { agentRef: { slug }, ...extra } };
}

/** The seeded consultation shape (`28-workflow-library.ts` `buildConsultationGraph`, agent summarizer). */
function seededShape(): WorkflowGraph {
  return {
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation', 'api'] } },
      agent('n_asr', 'asr'),
      { id: 'n_transcript', type: 'core.data', config: { mappings: [{ from: 'in.transcript.text', to: 'text' }] } },
      agent('n_ner', 'ner'),
      agent('n_summary', 'summary'),
      agent('n_finalize', 'finalize'),
      { id: 'n_review', type: 'core.humanReview', config: { reviewType: 'x' } },
      { id: 'n_output', type: 'core.output', config: { protocols: ['http'] } },
    ],
    edges: [
      e('n_trigger', 'next', 'n_asr', 'after'),
      e('n_asr', 'transcript', 'n_ner', 'in'),
      e('n_trigger', 'out', 'n_summary', 'context'),
      e('n_ner', 'out', 'n_summary', 'in'),
      e('n_summary', 'out', 'n_finalize', 'in'),
      e('n_finalize', 'out', 'n_review', 'in'),
      e('n_finalize', 'data', 'n_output', 'in'),
      e('n_review', 'next', 'n_output', 'after'),
      e('n_trigger', 'out', 'n_transcript', 'in'),
      e('n_transcript', 'text', 'n_ner', 'in'),
    ],
  };
}

function codes(issues: readonly BindingIssue[], severity?: BindingIssue['severity']): string[] {
  return issues.filter((issue) => severity === undefined || issue.severity === severity).map((issue) => `${issue.nodeId}:${issue.code}`);
}

describe('the binding shape', () => {
  it.each([
    [{ from: 'nodes.a.outputs.text' }],
    [{ from: 'consultation.patient.age', at: 'runStart' }],
    [{ value: 'en' }],
    [{ value: null }],
    [{ template: 'Hi {{context.name}}' }],
    [{ firstOf: ['nodes.a.outputs.text', 'context.note'] }],
  ])('accepts %j', (binding) => {
    expect(isBinding(binding)).toBe(true);
    expect(jsonSchemaValueProblems(BINDING_JSON_SCHEMA, binding, '')).toEqual([]);
  });

  it.each([
    [{}],
    [{ from: 'a', value: 1 }],
    [{ from: '' }],
    [{ template: 1 }],
    [{ from: 'a', at: 'later' }],
    [{ from: 'a', extra: 1 }],
    ['nodes.a.outputs.text'],
    [{ firstOf: ['nodes.a.outputs.text'] }],
    [{ firstOf: [] }],
    [{ firstOf: ['a', ''] }],
    [{ firstOf: ['a', 7] }],
    [{ firstOf: ['a', 'b'], at: 'runStart' }],
    [{ firstOf: 'a' }],
  ])('refuses %j', (binding) => {
    expect(isBinding(binding)).toBe(false);
    expect(jsonSchemaValueProblems(BINDING_JSON_SCHEMA, binding, '').length).toBeGreaterThan(0);
  });
});

describe('edgeAncestors', () => {
  it('is every node with an edge path INTO the node, any edge kind, excluding the node', () => {
    const graph = seededShape();
    expect([...edgeAncestors(graph, 'n_summary')].sort()).toEqual(['n_asr', 'n_ner', 'n_transcript', 'n_trigger']);
    expect([...edgeAncestors(graph, 'n_trigger')]).toEqual([]);
  });
});

describe('legacy translation — edges become bindings with the SAME data flow', () => {
  it('ASR.transcript -> NER.in becomes NER `text` from the transcript; the transcript reshape wins when both produce (last-write-wins by producer id today)', () => {
    expect(edgeImpliedBindings(seededShape(), 'n_ner', AGENTS)).toEqual({
      text: { firstOf: ['nodes.n_transcript.outputs.text', 'nodes.n_asr.outputs.transcript'] },
    });
  });

  it('NER.out -> summary.in becomes `message` from the NER pass-through text; trigger.out -> context', () => {
    expect(edgeImpliedBindings(seededShape(), 'n_summary', AGENTS)).toEqual({
      message: { from: 'nodes.n_ner.outputs.text' },
      context: { from: 'nodes.n_trigger.outputs.context' },
    });
  });

  it('finalize.data -> output.in becomes output `in` from the finalizer`s structured data', () => {
    expect(edgeImpliedBindings(seededShape(), 'n_output', AGENTS)).toEqual({ in: { from: 'nodes.n_finalize.outputs.data' } });
    expect(edgeImpliedBindings(seededShape(), 'n_review', AGENTS)).toEqual({ in: { from: 'nodes.n_finalize.outputs.text' } });
  });

  it('ordering edges and branch handles carry no data', () => {
    expect(edgeImpliedBindings(seededShape(), 'n_asr', AGENTS)).toEqual({});
    const routed: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
        { id: 'n_visit', type: 'core.condition', config: { branches: [{ key: 'new_visit', when: 'true' }] } },
        agent('n_a', 'summary'),
      ],
      edges: [e('n_trigger', 'out', 'n_visit', 'in'), e('n_visit', 'new_visit', 'n_a', 'after'), e('n_visit', 'else', 'n_a', 'after')],
    };
    expect(edgeImpliedBindings(routed, 'n_a', AGENTS)).toEqual({});
  });

  it('the TTS and NER `in` port is the agent`s `text` input; an unknown task falls back to `message`', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [agent('n_gen', 'summary'), agent('n_tts', 'tts'), agent('n_x', 'unknown-agent')],
      edges: [e('n_gen', 'out', 'n_tts', 'in'), e('n_gen', 'out', 'n_x', 'in')],
    };
    expect(edgeImpliedBindings(graph, 'n_tts', AGENTS)).toEqual({ text: { from: 'nodes.n_gen.outputs.text' } });
    expect(edgeImpliedBindings(graph, 'n_x', AGENTS)).toEqual({ message: { from: 'nodes.n_gen.outputs.text' } });
  });

  it('compiledBindings: authored inputs win over edge-implied ones; nodes with nothing bound are absent', () => {
    const graph = seededShape();
    (graph.nodes[4] as WorkflowGraphNode).config = {
      agentRef: { slug: 'summary' },
      inputs: { message: { from: 'nodes.n_ner.outputs.text' }, context: { value: { note: 'fixed' } } },
    };
    const compiled = compiledBindings(graph, AGENTS);
    expect(compiled.n_summary).toEqual({ message: { from: 'nodes.n_ner.outputs.text' }, context: { value: { note: 'fixed' } } });
    expect(compiled.n_asr).toBeUndefined();
    expect(compiled.n_trigger).toBeUndefined();
  });
});

describe('bindingIssues — legacy graphs', () => {
  it('a fully legacy graph raises NO error; a legacy fan-in is a WARNING (D-E, OD-18)', () => {
    const issues = bindingIssues(seededShape(), { agents: AGENTS });
    expect(codes(issues, 'ERROR')).toEqual([]);
    expect(codes(issues, 'WARNING')).toEqual(['n_ner:INPUT_MULTIPLE_PRODUCERS']);
  });
});

describe('bindingIssues — authored inputs', () => {
  function withInputs(nodeId: string, inputs: Record<string, unknown>, graph = seededShape()): WorkflowGraph {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId) as WorkflowGraphNode;
    node.config = { ...node.config, inputs };
    return graph;
  }

  it('a correct binding raises nothing', () => {
    const graph = withInputs('n_finalize', { message: { from: 'nodes.n_summary.outputs.text' } });
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'ERROR')).toEqual([]);
  });

  it('BINDING_NOT_ANCESTOR: a `from` node must run before this one', () => {
    const graph = withInputs('n_summary', { message: { from: 'nodes.n_finalize.outputs.text' } });
    const issues = bindingIssues(graph, { agents: AGENTS });
    expect(codes(issues, 'ERROR')).toContain('n_summary:BINDING_NOT_ANCESTOR');
    expect(issues.find((issue) => issue.code === 'BINDING_NOT_ANCESTOR')?.path).toBe('/inputs/message/from');
  });

  it('BINDING_TYPE_MISMATCH: audio cannot feed a text input; a convertible type is INFO only', () => {
    const graph = withInputs('n_finalize', { message: { from: 'nodes.n_asr.outputs.segments' } });
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'INFO')).toEqual(['n_finalize:BINDING_TYPE_CONVERTED']);

    const audio: WorkflowGraph = {
      version: 1,
      nodes: [agent('n_tts', 'tts'), agent('n_gen', 'summary', { inputs: { message: { from: 'nodes.n_tts.outputs.audio' } } })],
      edges: [e('n_tts', 'next', 'n_gen', 'after')],
    };
    expect(codes(bindingIssues(audio, { agents: AGENTS }), 'ERROR')).toEqual(['n_gen:BINDING_TYPE_MISMATCH']);
  });

  it('REQUIRED_INPUT_UNBOUND: a required input with neither a binding nor a data edge', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
        agent('n_gen', 'summary', { inputs: { context: { from: 'nodes.n_trigger.outputs.context' } } }),
      ],
      edges: [e('n_trigger', 'next', 'n_gen', 'after')],
    };
    const issues = bindingIssues(graph, { agents: AGENTS });
    expect(codes(issues, 'ERROR')).toEqual(['n_gen:REQUIRED_INPUT_UNBOUND']);
    expect(issues[0]?.input).toBe('message');
  });

  it('INPUT_MULTIPLE_PRODUCERS: on a node that declares inputs, two data edges into one unbound input is an ERROR', () => {
    // n_ner has two data edges into `in` (-> `text`); declaring any input moves it to the new model.
    const graph = withInputs('n_ner', {});
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'ERROR')).toEqual(['n_ner:INPUT_MULTIPLE_PRODUCERS']);
  });

  it('an authored binding SUPERSEDES the data an edge implies for that input — the edge is then ordering only (OD-29)', () => {
    const graph = withInputs('n_ner', { text: { from: 'nodes.n_asr.outputs.transcript' } });
    expect(codes(bindingIssues(graph, { agents: AGENTS }))).toEqual([]);
    expect(compiledBindings(graph, AGENTS).n_ner).toEqual({ text: { from: 'nodes.n_asr.outputs.transcript' } });
  });

  it('BINDING_UNKNOWN_PATH: an unknown root, node, output field, consultation field, variable or run field', () => {
    const cases: Array<[string, string]> = [
      ['trigger.context.x', 'not a binding root'],
      ['nodes.n_nope.outputs.text', 'no step'],
      ['nodes.n_summary.text', '`outputs`'],
      ['nodes.n_summary.outputs.entities', 'does not output'],
      ['consultation.patient.shoeSize', 'read schema'],
      ['vars.undeclared', 'no `core.variable`'],
      ['run.secret', 'run field'],
    ];
    for (const [path, needle] of cases) {
      const issues = bindingIssues(withInputs('n_finalize', { message: { from: path } }), { agents: AGENTS, sources: ['consultation'] });
      const unknown = issues.find((issue) => issue.code === 'BINDING_UNKNOWN_PATH');
      expect(unknown, path).toBeDefined();
      expect(unknown?.message, path).toContain(needle);
    }
  });

  it('a structured agent output can be drilled into through its schema', () => {
    const ok = withInputs('n_output', { in: { from: 'nodes.n_finalize.outputs.data.case_note' } });
    expect(codes(bindingIssues(ok, { agents: AGENTS }), 'ERROR')).toEqual([]);
    const bad = withInputs('n_output', { in: { from: 'nodes.n_finalize.outputs.data.nope' } });
    expect(codes(bindingIssues(bad, { agents: AGENTS }), 'ERROR')).toEqual(['n_output:BINDING_UNKNOWN_PATH']);
  });

  it('context paths are checked against the bound payload schema (when it is known)', () => {
    const payload = {
      type: 'object',
      additionalProperties: false,
      properties: { patient: { type: 'object', additionalProperties: false, properties: { age: { type: 'integer' } } } },
    };
    const ok = withInputs('n_finalize', { message: { from: 'context.patient.age' } });
    expect(codes(bindingIssues(ok, { agents: AGENTS, contextPayloadSchema: payload }), 'ERROR')).toEqual([]);
    const bad = withInputs('n_finalize', { message: { from: 'context.patient.weight' } });
    expect(codes(bindingIssues(bad, { agents: AGENTS, contextPayloadSchema: payload }), 'ERROR')).toEqual(['n_finalize:BINDING_UNKNOWN_PATH']);
    expect(codes(bindingIssues(bad, { agents: AGENTS }), 'ERROR')).toEqual([]);
  });

  it('templates are checked placeholder by placeholder, and render as text', () => {
    const ok = withInputs('n_finalize', { message: { template: 'Summary: {{nodes.n_summary.outputs.text}} at {{run.startedAt}}' } });
    expect(codes(bindingIssues(ok, { agents: AGENTS }), 'ERROR')).toEqual([]);
    const bad = withInputs('n_finalize', { message: { template: 'Later: {{nodes.n_output.outputs.x}}' } });
    expect(codes(bindingIssues(bad, { agents: AGENTS }), 'ERROR')).toEqual(['n_finalize:BINDING_NOT_ANCESTOR']);
    const tts: WorkflowGraph = { version: 1, nodes: [agent('n_asr', 'asr', { inputs: { audio: { template: 'x' } } })], edges: [] };
    expect(codes(bindingIssues(tts, { agents: AGENTS }), 'ERROR')).toEqual(['n_asr:BINDING_TYPE_MISMATCH']);
  });

  it('BINDING_UNKNOWN_INPUT: an input the node does not declare', () => {
    const graph = withInputs('n_finalize', { message: { from: 'nodes.n_summary.outputs.text' }, prompt: { value: 'x' } });
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'ERROR')).toEqual(['n_finalize:BINDING_UNKNOWN_INPUT']);
  });

  it('a literal value is type-checked too', () => {
    const graph = withInputs('n_finalize', { message: { value: 42 } });
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'INFO')).toEqual(['n_finalize:BINDING_TYPE_CONVERTED']);
  });
});

describe('CONSULTATION_SCOPE_UNAVAILABLE', () => {
  const graph = (): WorkflowGraph => ({
    version: 1,
    nodes: [
      { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
      agent('n_gen', 'summary', { inputs: { message: { from: 'consultation.transcript.text' } } }),
    ],
    edges: [e('n_trigger', 'next', 'n_gen', 'after')],
  });

  it('is an ERROR when a node reads consultation.* and the workflow is not consultation-bound', () => {
    expect(codes(bindingIssues(graph(), { agents: AGENTS }), 'ERROR')).toEqual(['n_gen:CONSULTATION_SCOPE_UNAVAILABLE']);
  });

  it('is clean when `sources` includes consultation (legacy trigger kinds count)', () => {
    const bound = graph();
    (bound.nodes[0] as WorkflowGraphNode).config = { kinds: ['consultation'] };
    expect(codes(bindingIssues(bound, { agents: AGENTS }), 'ERROR')).toEqual([]);
    expect(codes(bindingIssues(graph(), { agents: AGENTS, sources: ['consultation'] }), 'ERROR')).toEqual([]);
  });

  it('also covers a consultation.* read in a prompt-variable template', () => {
    const viaTemplate: WorkflowGraph = {
      version: 1,
      nodes: [agent('n_gen', 'summary', { overrides: { promptVariables: { age: '{{consultation.patient.age}}' } } })],
      edges: [],
    };
    expect(codes(bindingIssues(viaTemplate, { agents: AGENTS }), 'ERROR')).toEqual(['n_gen:CONSULTATION_SCOPE_UNAVAILABLE']);
  });
});

describe('prompt-variable templates: `nodes.*` is no longer a wildcard (D-G)', () => {
  it('an unknown step, a step that runs later, or an undeclared output field is refused; the legacy `nodes.<id>.<key>` form is admitted', () => {
    const build = (value: string): WorkflowGraph => ({
      version: 1,
      nodes: [agent('n_a', 'summary'), agent('n_b', 'summary', { overrides: { promptVariables: { v: value } } }), agent('n_c', 'summary')],
      edges: [e('n_a', 'out', 'n_b', 'in'), e('n_b', 'out', 'n_c', 'in')],
    });
    expect(codes(bindingIssues(build('{{nodes.n_zz.text}}'), { agents: AGENTS }), 'ERROR')).toEqual(['n_b:BINDING_UNKNOWN_PATH']);
    expect(codes(bindingIssues(build('{{nodes.n_c.outputs.text}}'), { agents: AGENTS }), 'ERROR')).toEqual(['n_b:BINDING_NOT_ANCESTOR']);
    expect(codes(bindingIssues(build('{{nodes.n_a.outputs.nope}}'), { agents: AGENTS }), 'ERROR')).toEqual(['n_b:BINDING_UNKNOWN_PATH']);
    expect(codes(bindingIssues(build('{{nodes.n_a.outputs.text}}'), { agents: AGENTS }), 'ERROR')).toEqual([]);
    expect(codes(bindingIssues(build('{{nodes.n_a.text}}'), { agents: AGENTS }), 'ERROR')).toEqual([]);
  });
});

describe('authored `firstOf` — a deliberate ordered coalesce is not fan-in (OD-18 amended)', () => {
  function withInputs(nodeId: string, inputs: Record<string, unknown>, graph = seededShape()): WorkflowGraph {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId) as WorkflowGraphNode;
    node.config = { ...node.config, inputs };
    return graph;
  }

  it('is accepted when every path is an ancestor of a fitting type, and compiles verbatim', () => {
    // The REVERSE of the legacy translation's order, so the authored binding is visibly the one compiled.
    const firstOf = { firstOf: ['nodes.n_asr.outputs.transcript', 'nodes.n_transcript.outputs.text'] };
    const graph = withInputs('n_ner', { text: firstOf });
    expect(codes(bindingIssues(graph, { agents: AGENTS }))).toEqual([]);
    expect(compiledBindings(graph, AGENTS).n_ner).toEqual({ text: firstOf });
  });

  it('checks each path for ancestry, pointing at the offending entry', () => {
    const graph = withInputs('n_ner', { text: { firstOf: ['nodes.n_asr.outputs.transcript', 'nodes.n_finalize.outputs.text'] } });
    const issues = bindingIssues(graph, { agents: AGENTS });
    expect(codes(issues, 'ERROR')).toEqual(['n_ner:BINDING_NOT_ANCESTOR']);
    expect(issues.find((issue) => issue.code === 'BINDING_NOT_ANCESTOR')?.path).toBe('/inputs/text/firstOf/1');
  });

  it('checks each path for type, and for being a known path at all', () => {
    const mismatch = withInputs('n_ner', { text: { firstOf: ['nodes.n_asr.outputs.transcript', 'nodes.n_trigger.outputs.context'] } });
    expect(codes(bindingIssues(mismatch, { agents: AGENTS }), 'INFO')).toEqual(['n_ner:BINDING_TYPE_CONVERTED']);
    const audio: WorkflowGraph = {
      version: 1,
      nodes: [
        agent('n_tts', 'tts'),
        agent('n_gen', 'summary'),
        agent('n_x', 'summary', { inputs: { message: { firstOf: ['nodes.n_gen.outputs.text', 'nodes.n_tts.outputs.audio'] } } }),
      ],
      edges: [e('n_tts', 'next', 'n_gen', 'after'), e('n_gen', 'next', 'n_x', 'after')],
    };
    const issues = bindingIssues(audio, { agents: AGENTS });
    expect(codes(issues, 'ERROR')).toEqual(['n_x:BINDING_TYPE_MISMATCH']);
    expect(issues[0]?.path).toBe('/inputs/message/firstOf/1');
    const unknown = withInputs('n_ner', { text: { firstOf: ['nodes.n_asr.outputs.transcript', 'nope.x'] } });
    expect(codes(bindingIssues(unknown, { agents: AGENTS }), 'ERROR')).toEqual(['n_ner:BINDING_UNKNOWN_PATH']);
  });

  it('a consultation.* path inside firstOf is a declared read, and needs the consultation source', () => {
    const graph: WorkflowGraph = {
      version: 1,
      nodes: [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } },
        agent('n_gen', 'summary', { inputs: { message: { firstOf: ['context.note', 'consultation.transcript.text'] } } }),
      ],
      edges: [e('n_trigger', 'next', 'n_gen', 'after')],
    };
    expect(codes(bindingIssues(graph, { agents: AGENTS }), 'ERROR')).toEqual(['n_gen:CONSULTATION_SCOPE_UNAVAILABLE']);
    expect(codes(bindingIssues(graph, { agents: AGENTS, sources: ['consultation'] }), 'ERROR')).toEqual([]);
  });

  it('INPUT_MULTIPLE_PRODUCERS on an authored node still errors, and suggests binding as firstOf', () => {
    const issues = bindingIssues(withInputs('n_ner', {}), { agents: AGENTS });
    const fanIn = issues.find((issue) => issue.code === 'INPUT_MULTIPLE_PRODUCERS');
    expect(fanIn?.severity).toBe('ERROR');
    expect(fanIn?.message).toContain('firstOf');
  });
});
