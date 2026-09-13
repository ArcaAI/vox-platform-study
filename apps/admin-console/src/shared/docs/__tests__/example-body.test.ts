/**
 * TASK-971 lane B — the example body every integration lane prints.
 *
 * The panel used to invent `{ text: '…' }` for every agent and `{ input: {} }` for every
 * workflow, while the real input shape was already in hand (`agent.inputSchema`; the schema
 * route's `components["Workflow_<slug>_Input"]`). A developer who copies a placeholder and gets
 * a 400 back learns nothing about their own contract, so the derivation has to be honest in both
 * directions: derive what the schema states, and return `null` — never `{}` — when it states
 * nothing usable, so the caller can fall back to a documented minimum instead of printing an
 * empty object as if it were the answer.
 */
import { describe, expect, it } from 'vitest';
import { agentContextExample, exampleBodyFromJsonSchema } from '../example-body';

describe('exampleBodyFromJsonSchema — an unusable schema is null, never {}', () => {
  it.each([
    ['undefined', undefined],
    ['null', null],
    ['an empty object', {}],
    ['an object schema with no properties', { type: 'object' }],
    ['an object schema with empty properties', { type: 'object', properties: {} }],
    ['a non-object schema', { type: 'string' }],
    ['a top-level array schema', { type: 'array', items: { type: 'string' } }],
    ['properties that is not an object', { type: 'object', properties: 'nope' }],
  ])('%s → null', (_label, schema) => {
    expect(exampleBodyFromJsonSchema(schema as Record<string, unknown> | null | undefined)).toBeNull();
  });
});

describe('exampleBodyFromJsonSchema — what the schema states', () => {
  it('honours `required`: the example is the minimal accepted body, not every property', () => {
    const body = exampleBodyFromJsonSchema({
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string' },
        temperature: { type: 'number' },
      },
    });

    expect(body).toEqual({ text: '…' });
  });

  it('with no `required` at all, every property is shown — an empty example would teach nothing', () => {
    const body = exampleBodyFromJsonSchema({
      type: 'object',
      properties: { note: { type: 'string' }, redact: { type: 'boolean' } },
    });

    expect(body).toEqual({ note: '…', redact: false });
  });

  it('prefers `default`, then `enum`, over a type placeholder', () => {
    const body = exampleBodyFromJsonSchema({
      type: 'object',
      required: ['tone', 'locale', 'plain'],
      properties: {
        tone: { type: 'string', enum: ['clinical', 'plain'] },
        locale: { type: 'string', default: 'en-GB', enum: ['en-GB', 'ml-IN'] },
        plain: { type: 'string' },
      },
    });

    expect(body).toEqual({ tone: 'clinical', locale: 'en-GB', plain: '…' });
  });

  it('covers every scalar type, and a union type takes its first non-null member', () => {
    const body = exampleBodyFromJsonSchema({
      type: 'object',
      properties: {
        s: { type: 'string' },
        n: { type: 'number' },
        i: { type: 'integer' },
        b: { type: 'boolean' },
        nul: { type: 'null' },
        union: { type: ['null', 'integer'] },
        unknown: {},
      },
    });

    expect(body).toEqual({ s: '…', n: 0, i: 0, b: false, nul: null, union: 0, unknown: null });
  });

  it('recurses into nested objects and arrays', () => {
    const body = exampleBodyFromJsonSchema({
      type: 'object',
      required: ['patient', 'codes', 'attachments'],
      properties: {
        patient: {
          type: 'object',
          required: ['mrn'],
          properties: { mrn: { type: 'string' }, age: { type: 'integer' } },
        },
        codes: { type: 'array', items: { type: 'string' } },
        attachments: { type: 'array' },
      },
    });

    expect(body).toEqual({ patient: { mrn: '…' }, codes: ['…'], attachments: [] });
  });

  it('is deterministic — the same schema always yields the same example', () => {
    const schema = { type: 'object', required: ['a', 'b'], properties: { a: { type: 'string' }, b: { type: 'integer' } } };
    expect(exampleBodyFromJsonSchema(schema)).toEqual(exampleBodyFromJsonSchema(schema));
    expect(JSON.stringify(exampleBodyFromJsonSchema(schema))).toBe(JSON.stringify(exampleBodyFromJsonSchema(schema)));
  });

  it('terminates on a self-referential schema rather than recursing forever', () => {
    const node: Record<string, unknown> = { type: 'object', required: ['label'], properties: { label: { type: 'string' } } };
    (node.properties as Record<string, unknown>).child = node;

    const body = exampleBodyFromJsonSchema(node);
    expect(body).not.toBeNull();
    expect(JSON.stringify(body)).toContain('label');
  });
});

// ---------------------------------------------------------------------------
// TASK-971 FU-1 — the context an agent's INSTRUCTION requires
// ---------------------------------------------------------------------------

/**
 * Verified live against the seeded `general-medicine-summarization` on 2026-09-13: its example
 * derived from `inputSchema` alone was refused with
 * "instruction references `trigger.context.language`, which this invocation does not supply".
 *
 * `inputSchema` says what the agent is called WITH; the instruction's BINDINGS say what it is
 * called ABOUT, and they are a separate declaration on `compiledConfig.instruction.variables`:
 * `{ path: 'trigger.…' }` is caller-supplied, `{ value: … }` is already bound. On this lane
 * `trigger` IS the request's `context` object, so a `trigger.context.language` binding is
 * `context: { context: { language } }`.
 */
describe('agentContextExample', () => {
  const bindings = {
    language: { path: 'trigger.context.language' },
    safe_age: { path: 'trigger.context.safe_age' },
    revisit_headings: { value: 'A | B | C' },
  };

  it('builds the nested context a trigger-path binding requires', () => {
    expect(agentContextExample({ instruction: { variables: bindings } })).toEqual({
      context: { language: '…', safe_age: '…' },
    });
  });

  it('ignores bindings that already carry a value — the caller must not supply those', () => {
    const context = agentContextExample({ instruction: { variables: { revisit_headings: { value: 'A | B | C' } } } });
    expect(context).toBeNull();
  });

  it('prefers the bound context schema, and still covers a path the schema does not declare', () => {
    const context = agentContextExample({
      instruction: { variables: bindings },
      contextSchema: {
        payloadSchema: {
          type: 'object',
          required: ['context'],
          properties: {
            context: { type: 'object', required: ['language'], properties: { language: { type: 'string', enum: ['en', 'ml'] } } },
          },
        },
      },
    });

    // `language` comes from the schema (so it carries the enum value), `safe_age` from the binding.
    expect(context).toEqual({ context: { language: 'en', safe_age: '…' } });
  });

  it('returns null when the agent binds nothing from the trigger', () => {
    expect(agentContextExample({ instruction: { variables: {} } })).toBeNull();
    expect(agentContextExample(null)).toBeNull();
    expect(agentContextExample({})).toBeNull();
  });

  it('ignores a binding that is not rooted at `trigger.`', () => {
    expect(agentContextExample({ instruction: { variables: { x: { path: 'input.text' } } } })).toBeNull();
  });
});
