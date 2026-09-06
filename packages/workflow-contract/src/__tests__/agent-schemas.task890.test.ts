/**
 * TASK-890 — the three AUTHORING shapes wave 2 fills in, landed once in wave 1 so four lanes can
 * build on them without editing the same three files:
 *
 * 1. `instruction.variables` is a BINDING, not a flat string (§3.1, OD-K). `{ value }` is a
 *    literal and `{ path }` resolves from the run scope BEFORE the bare-name overlay, so
 *    `{{age}}` and `{{context.patientAge}}` can be the same value (§3.3). The retired flat form
 *    (`{ age: "67" }`) is REFUSED rather than quietly accepted, because a flat string cannot
 *    express the path half and silently binding it as a literal is how a prompt loses a variable.
 * 2. `parameters.guards.enabled` — the AGENT-level guardrail default (§3.14, OD-R clause 3).
 * 3. `core.agent.guardrail` / `core.trigger.guardrail` — the node and workflow overrides, ABSENT
 *    meaning "inherit" (the tri-state-by-absence shape `mcpToolsEnabled` already uses).
 *
 * The agent's bound context schema (`contextSchemaId` + `contextSchemaVersionNumber`) also lands
 * on the config VIEW here: L8 resolves the row and freezes the derived payload schema, but the
 * shape the checks read must exist first.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTION_SCHEMAS, AGENT_PARAMETER_SCHEMAS, agentConfigProblems, type AgentConfigView } from '../agent-schemas';
import { coreNodeConfigProblems } from '../core-contract';
import { NODE_CONFIG_SCHEMAS } from '../node-config-schemas';

const textAgent = (instruction: Record<string, unknown>, parameters: Record<string, unknown> = {}): AgentConfigView => ({
  task: 'TEXT_GENERATION',
  instruction: { promptTemplateId: '11111111-1111-1111-1111-111111111111', ...instruction },
  parameters,
});

describe('instruction.variables — the binding form (OD-K)', () => {
  it('accepts a `{ value }` literal binding', () => {
    const view = textAgent({ variables: { tone: { value: 'concise' } } });
    expect(agentConfigProblems(view)).toEqual([]);
    expect(jsonSchemaValueProblems(AGENT_INSTRUCTION_SCHEMAS.TEXT_GENERATION, view.instruction, 'instruction')).toEqual([]);
  });

  it('accepts a `{ path }` scope binding', () => {
    const view = textAgent({ variables: { age: { path: 'context.patientAge' } } });
    expect(agentConfigProblems(view)).toEqual([]);
    expect(jsonSchemaValueProblems(AGENT_INSTRUCTION_SCHEMAS.TEXT_GENERATION, view.instruction, 'instruction')).toEqual([]);
  });

  it('REFUSES the retired flat-string form, and says so by name', () => {
    const view = textAgent({ variables: { age: '67' } });
    const problems = agentConfigProblems(view);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('instruction.variables.age');
    expect(problems[0]?.severity).toBe('ERROR');
    expect(problems[0]?.message).toMatch(/value|path/);
    // The schema refuses it too — the shape is machine-readable, not only hand-checked.
    expect(jsonSchemaValueProblems(AGENT_INSTRUCTION_SCHEMAS.TEXT_GENERATION, view.instruction, 'instruction').length).toBeGreaterThan(0);
  });

  it('REFUSES a binding that declares both `value` and `path`, or neither', () => {
    expect(agentConfigProblems(textAgent({ variables: { a: { value: 'x', path: 'context.y' } } }))).toHaveLength(1);
    expect(agentConfigProblems(textAgent({ variables: { a: {} } }))).toHaveLength(1);
  });

  it('REFUSES a `path` that is not a dotted identifier path', () => {
    expect(agentConfigProblems(textAgent({ variables: { a: { path: 'context.0' } } }))).toHaveLength(1);
    expect(agentConfigProblems(textAgent({ variables: { a: { path: '' } } }))).toHaveLength(1);
  });
});

describe('parameters.guards.enabled — the agent-level guardrail default (§3.14)', () => {
  it('accepts `false` beside the existing policy-key lists', () => {
    const parameters = { guards: { enabled: false, input: ['pii'], output: ['groundedness'] } };
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, parameters, 'parameters')).toEqual([]);
    expect(agentConfigProblems(textAgent({}, parameters))).toEqual([]);
  });

  it('accepts an ABSENT `enabled` — absence means ON, never "unset"', () => {
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, { guards: { input: ['pii'] } }, 'parameters')).toEqual([]);
  });

  it('REFUSES a non-boolean', () => {
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, { guards: { enabled: 'no' } }, 'parameters').length).toBeGreaterThan(0);
  });
});

describe('core.agent / core.trigger `guardrail` — the node and workflow overrides (§3.14)', () => {
  const schemaOf = (type: 'core.agent' | 'core.trigger') => NODE_CONFIG_SCHEMAS[type];

  it('core.agent accepts `guardrail: { enabled: false }`', () => {
    const config = { agentRef: { slug: 'summarizer' }, guardrail: { enabled: false } };
    expect(jsonSchemaValueProblems(schemaOf('core.agent'), config, '/nodes/0/config')).toEqual([]);
    expect(coreNodeConfigProblems({ id: 'n1', type: 'core.agent', config })).toEqual([]);
  });

  it('core.trigger accepts `guardrail: { enabled: false }` — the WORKFLOW default', () => {
    const config = { kinds: ['api'], guardrail: { enabled: false } };
    expect(jsonSchemaValueProblems(schemaOf('core.trigger'), config, '/nodes/0/config')).toEqual([]);
    expect(coreNodeConfigProblems({ id: 't1', type: 'core.trigger', config })).toEqual([]);
  });

  it('an ABSENT `guardrail` object is INHERIT, not a problem', () => {
    expect(jsonSchemaValueProblems(schemaOf('core.agent'), { agentRef: { slug: 'summarizer' } }, '/c')).toEqual([]);
    expect(jsonSchemaValueProblems(schemaOf('core.trigger'), { kinds: ['api'] }, '/c')).toEqual([]);
  });

  it('REFUSES an undeclared key or a non-boolean inside `guardrail`', () => {
    expect(jsonSchemaValueProblems(schemaOf('core.agent'), { agentRef: { slug: 'summarizer' }, guardrail: { foo: 1 } }, '/c').length).toBeGreaterThan(
      0,
    );
    expect(
      jsonSchemaValueProblems(schemaOf('core.agent'), { agentRef: { slug: 'summarizer' }, guardrail: { enabled: 'no' } }, '/c').length,
    ).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(schemaOf('core.trigger'), { kinds: ['api'], guardrail: { foo: 1 } }, '/c').length).toBeGreaterThan(0);
  });
});

describe('AgentConfigView carries the bound context schema', () => {
  it('accepts a reference pair and does not invent a problem for it', () => {
    const view: AgentConfigView = {
      ...textAgent({}),
      contextSchemaId: '22222222-2222-2222-2222-222222222222',
      contextSchemaVersionNumber: 3,
    };
    expect(agentConfigProblems(view)).toEqual([]);
  });

  it('REFUSES a version number without a schema id — half a reference is not a reference', () => {
    const view: AgentConfigView = { ...textAgent({}), contextSchemaVersionNumber: 3 };
    const problems = agentConfigProblems(view);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('contextSchemaVersionNumber');
  });
});
