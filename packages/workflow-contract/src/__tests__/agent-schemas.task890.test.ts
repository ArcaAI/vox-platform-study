/**
 * TASK-890 — the three AUTHORING shapes wave 2 fills in, landed once in wave 1 so four lanes can
 * build on them without editing the same three files:
 *
 * 1. `instruction.variables` is a BINDING, not a flat string (§3.1, OD-K). `{ value }` is a
 *    literal and `{ path }` resolves from the run scope BEFORE the bare-name overlay, so
 *    `{{age}}` and `{{context.patientAge}}` can be the same value (§3.3). The retired flat form
 *    (`{ age: "67" }`) is REFUSED rather than quietly accepted, because a flat string cannot
 *    express the path half and silently binding it as a literal is how a prompt loses a variable.
 * 2./3. The agent / node / workflow guardrail opt-out this wave added is RETIRED (OD-1); its
 *    retirement is pinned by `retired-guardrail-optout.test.ts`.
 *
 * The agent's bound context schema (`contextSchemaId` + `contextSchemaVersionNumber`) also lands
 * on the config VIEW here: L8 resolves the row and freezes the derived payload schema, but the
 * shape the checks read must exist first.
 */
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { describe, expect, it } from 'vitest';
import { AGENT_INSTRUCTION_SCHEMAS, AGENT_PARAMETER_SCHEMAS, agentConfigProblems, type AgentConfigView } from '../agent-schemas';
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

describe('parameters.guards — policy-key lists only, no opt-out switch', () => {
  it('accepts the policy-key lists', () => {
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, { guards: { input: ['pii'], output: ['groundedness'] } }, 'parameters')).toEqual([]);
  });

  it('REFUSES a fresh `guards.enabled` — the opt-out is retired; only a STORED one is stripped', () => {
    expect(jsonSchemaValueProblems(AGENT_PARAMETER_SCHEMAS.TEXT_GENERATION, { guards: { enabled: false } }, 'parameters').length).toBeGreaterThan(0);
  });
});

describe('core.agent / core.trigger declare no `guardrail` override', () => {
  it('REFUSES a fresh `guardrail` key on either node', () => {
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['core.agent'], { agentRef: { slug: 'summarizer' }, guardrail: { enabled: false } }, '/c').length).toBeGreaterThan(0);
    expect(jsonSchemaValueProblems(NODE_CONFIG_SCHEMAS['core.trigger'], { kinds: ['api'], guardrail: { enabled: false } }, '/c').length).toBeGreaterThan(0);
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
