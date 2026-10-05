/**
 * TASK-1036 — the publish gate reports the data-contract rules: bindings (§9.2), the consultation
 * scope (§9.3) and the workflow settings (§3.5), each catalogued (`DATA_CONTRACT_RULES`).
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import type { WorkflowGraph } from '../graph-model';
import { WORKFLOW_PUBLISH_FINDING_CODES, publishFindings, type PublishAgentView, type PublishContext } from '../publish-findings';
import { DATA_CONTRACT_RULES } from '../rule-catalogue';

const VIEW: PublishAgentView = { declaredVariables: [], contextPayloadSchema: null };
const AGENTS: Record<string, PublishAgentView> = {
  gen: { ...VIEW, task: 'TEXT_GENERATION' },
  asr: { ...VIEW, task: 'SPEECH_TO_TEXT' },
  tts: { ...VIEW, task: 'TEXT_TO_SPEECH' },
};

function ctx(extra: Partial<PublishContext> = {}): PublishContext {
  return { schemaValueProblems: jsonSchemaValueProblems, agents: AGENTS, ...extra };
}

function graph(nodes: WorkflowGraph['nodes'], edges: WorkflowGraph['edges'], settings?: unknown): WorkflowGraph {
  return { version: 1, nodes, edges, ...(settings === undefined ? {} : { settings }) } as WorkflowGraph;
}

const TRIGGER = { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['api'] } };
const OUTPUT = { id: 'n_output', type: 'core.output', config: { protocols: ['http'] } };

function dataContractFindings(g: WorkflowGraph, c: PublishContext = ctx()) {
  const codes = new Set(DATA_CONTRACT_RULES.map((rule) => rule.code));
  return publishFindings(g, c).filter((finding) => codes.has(finding.code ?? ''));
}

describe('bindings reach the publish gate', () => {
  it('an ERROR binding issue is a blocking finding, with the node, the pointer and the code', () => {
    const g = graph(
      [
        TRIGGER,
        { id: 'n_gen', type: 'core.agent', config: { agentRef: { slug: 'gen' }, inputs: { message: { from: 'nodes.n_output.outputs.x' } } } },
        OUTPUT,
      ],
      [
        { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_gen', toPort: 'after' },
        { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_output', toPort: 'in' },
      ],
    );
    const found = dataContractFindings(g);
    expect(found).toEqual([
      expect.objectContaining({ ruleId: 'WF-PUB', code: 'BINDING_NOT_ANCESTOR', severity: 'ERROR', nodeId: 'n_gen', path: '/inputs/message/from' }),
    ]);
  });

  it('INFO (a convertible type) never becomes a finding', () => {
    const g = graph(
      [TRIGGER, { id: 'n_gen', type: 'core.agent', config: { agentRef: { slug: 'gen' }, inputs: { message: { value: 42 } } } }, OUTPUT],
      [
        { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_gen', toPort: 'after' },
        { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_output', toPort: 'in' },
      ],
    );
    expect(dataContractFindings(g)).toEqual([]);
  });

  it('a legacy fan-in is a WARNING, not a refusal', () => {
    const g = graph(
      [
        TRIGGER,
        { id: 'n_a', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
        { id: 'n_b', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
        { id: 'n_c', type: 'core.agent', config: { agentRef: { slug: 'gen' } } },
        OUTPUT,
      ],
      [
        { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_a', toPort: 'context' },
        { id: 'e2', from: 'n_trigger', fromPort: 'out', to: 'n_b', toPort: 'context' },
        { id: 'e3', from: 'n_a', fromPort: 'out', to: 'n_c', toPort: 'in' },
        { id: 'e4', from: 'n_b', fromPort: 'out', to: 'n_c', toPort: 'in' },
        { id: 'e5', from: 'n_c', fromPort: 'out', to: 'n_output', toPort: 'in' },
      ],
    );
    expect(dataContractFindings(g).map((finding) => [finding.code, finding.severity])).toEqual([['INPUT_MULTIPLE_PRODUCERS', 'WARNING']]);
  });

  it('`consultation.*` and `run.*` are declared prompt roots: no PROMPT_VARIABLE_UNDECLARED for them', () => {
    const g = graph(
      [
        { id: 'n_trigger', type: 'core.trigger', config: { kinds: ['consultation'] } },
        {
          id: 'n_gen',
          type: 'core.agent',
          config: { agentRef: { slug: 'gen' }, overrides: { promptVariables: { age: '{{consultation.patient.age}}', id: '{{run.id}}' } } },
        },
        OUTPUT,
      ],
      [
        { id: 'e1', from: 'n_trigger', fromPort: 'out', to: 'n_gen', toPort: 'context' },
        { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_output', toPort: 'in' },
      ],
    );
    expect(publishFindings(g, ctx()).filter((finding) => finding.severity === 'ERROR')).toEqual([]);
  });
});

describe('workflow settings reach the publish gate', () => {
  const nodes = [TRIGGER, { id: 'n_asr', type: 'core.agent', config: { agentRef: { slug: 'asr' } } }, OUTPUT];
  const edges = [
    { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_asr', toPort: 'after' },
    { id: 'e2', from: 'n_asr', fromPort: 'next', to: 'n_output', toPort: 'after' },
  ];

  it('a malformed settings block is SETTINGS_INVALID', () => {
    const found = dataContractFindings(graph(nodes, edges, { connections: ['ftp'], sources: [] }));
    expect(found.map((finding) => finding.code)).toEqual(['SETTINGS_INVALID']);
    expect(found[0]?.path).toBe('/settings/connections/0');
  });

  it('declared settings that miss an implied connection are an ERROR under its WF-SET rule id', () => {
    const found = dataContractFindings(graph(nodes, edges, { connections: ['sse'], sources: [] }));
    expect(found.map((finding) => [finding.ruleId, finding.code, finding.severity])).toEqual([
      ['WF-SET-001', 'SETTINGS_SSE_REQUIRES_API', 'ERROR'],
      ['WF-SET-003', 'SETTINGS_LIVE_AUDIO_REQUIRES_SOCKET', 'ERROR'],
    ]);
    expect(found[1]?.nodeId).toBe('n_asr');
  });

  it('settings derived from the legacy keys report the same implication as a WARNING (one release)', () => {
    const found = dataContractFindings(graph(nodes, edges));
    expect(found.map((finding) => [finding.ruleId, finding.severity])).toEqual([['WF-SET-003', 'WARNING']]);
  });

  it('the Input shape`s kinds are read from the resolved definition', () => {
    const definition = { schemaVersion: '1.0', kinds: [{ key: 'attachment', primitive: 'DOCUMENT' }] };
    const found = dataContractFindings(
      graph([TRIGGER, OUTPUT], [{ id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_output', toPort: 'after' }], {
        connections: ['webhook'],
        sources: [],
      }),
      ctx({ contextSchemaDefinition: definition }),
    );
    expect(found.map((finding) => finding.code)).toEqual(['SETTINGS_UPLOAD_REQUIRES_API']);
  });

  it('a consultation read without the consultation source is refused', () => {
    const g = graph(
      [
        TRIGGER,
        { id: 'n_gen', type: 'core.agent', config: { agentRef: { slug: 'gen' }, inputs: { message: { from: 'consultation.transcript.text' } } } },
        OUTPUT,
      ],
      [
        { id: 'e1', from: 'n_trigger', fromPort: 'next', to: 'n_gen', toPort: 'after' },
        { id: 'e2', from: 'n_gen', fromPort: 'out', to: 'n_output', toPort: 'in' },
      ],
      { connections: ['api'], sources: [] },
    );
    expect(dataContractFindings(g).map((finding) => finding.code)).toEqual(['CONSULTATION_SCOPE_UNAVAILABLE']);
  });
});

describe('DATA_CONTRACT_RULES — the catalogue', () => {
  it('catalogues every new code exactly once, each with a title and a fix', () => {
    const codes = DATA_CONTRACT_RULES.map((rule) => rule.code);
    expect(new Set(codes).size).toBe(codes.length);
    expect([...codes].sort()).toEqual(
      [
        'AGENT_NOTHING_BOUND',
        'BINDING_NOT_ANCESTOR',
        'BINDING_TYPE_CONVERTED',
        'BINDING_TYPE_MISMATCH',
        'BINDING_UNKNOWN_INPUT',
        'BINDING_UNKNOWN_PATH',
        'CONSULTATION_SCOPE_UNAVAILABLE',
        'INPUT_MULTIPLE_PRODUCERS',
        'REQUIRED_INPUT_UNBOUND',
        'SETTINGS_INVALID',
        'SETTINGS_LIVE_AUDIO_REQUIRES_SOCKET',
        // TASK-1042 OD-7 — WF-SET-005.
        'SETTINGS_LIVE_AUDIO_UNREAD',
        'SETTINGS_SOCKET_REQUIRES_API',
        'SETTINGS_SSE_REQUIRES_API',
        'SETTINGS_UPLOAD_REQUIRES_API',
      ].sort(),
    );
    for (const rule of DATA_CONTRACT_RULES) {
      expect(rule.title.length, rule.code).toBeGreaterThan(10);
      expect(rule.fix.length, rule.code).toBeGreaterThan(10);
    }
    expect(
      DATA_CONTRACT_RULES.filter((rule) => rule.ruleId.startsWith('WF-SET-'))
        .map((rule) => rule.ruleId)
        .sort(),
    ).toEqual(['WF-SET-001', 'WF-SET-002', 'WF-SET-003', 'WF-SET-004', 'WF-SET-005']);
  });

  it('every code a publish finding can carry is in the publish code vocabulary (INFO excepted)', () => {
    for (const rule of DATA_CONTRACT_RULES) {
      if (rule.severity === 'INFO') continue;
      expect(WORKFLOW_PUBLISH_FINDING_CODES as readonly string[], rule.code).toContain(rule.code);
    }
  });
});
