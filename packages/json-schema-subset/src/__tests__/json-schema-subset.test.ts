import { describe, it, expect } from 'vitest';
import { authorableJsonSchemaProblems, jsonSchemaValueProblems } from '../json-schema-subset';

describe('authorableJsonSchemaProblems — the constrained draft 2020-12 subset', () => {
  it('accepts a plain object schema', () => {
    expect(
      authorableJsonSchemaProblems({
        type: 'object',
        properties: { severity: { type: 'string', enum: ['mild', 'severe'] } },
        required: ['severity'],
      }),
    ).toEqual([]);
  });

  it('rejects `if` / `then` / `else` at the top level', () => {
    const problems = authorableJsonSchemaProblems({
      type: 'object',
      if: { properties: { a: { const: 1 } } },
      then: { required: ['b'] },
    });
    expect(problems.join(' ')).toMatch(/is not authorable/i);
  });

  it('rejects `if` nested deep inside a property', () => {
    const problems = authorableJsonSchemaProblems({
      type: 'object',
      properties: {
        outer: { type: 'object', properties: { inner: { type: 'object', if: { const: 1 } } } },
      },
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/properties\/outer\/properties\/inner/);
  });

  it('rejects `oneOf` without an explicit discriminator', () => {
    const problems = authorableJsonSchemaProblems({
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, a: { type: 'string' } } },
        { type: 'object', properties: { kind: { const: 'b' }, b: { type: 'number' } } },
      ],
    });
    expect(problems.join(' ')).toMatch(/discriminator/i);
  });

  it('accepts `oneOf` WITH an explicit discriminator', () => {
    expect(
      authorableJsonSchemaProblems({
        discriminator: { propertyName: 'kind' },
        oneOf: [
          { type: 'object', properties: { kind: { const: 'a' }, a: { type: 'string' } } },
          { type: 'object', properties: { kind: { const: 'b' }, b: { type: 'number' } } },
        ],
      }),
    ).toEqual([]);
  });

  it('rejects a discriminator whose propertyName is not a non-empty string', () => {
    const problems = authorableJsonSchemaProblems({
      discriminator: { propertyName: '' },
      oneOf: [{ type: 'object' }, { type: 'object' }],
    });
    expect(problems.join(' ')).toMatch(/propertyName/i);
  });

  it('rejects an unbounded nesting depth', () => {
    let schema: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i += 1) {
      schema = { type: 'object', properties: { nested: schema } };
    }
    expect(authorableJsonSchemaProblems(schema).join(' ')).toMatch(/depth/i);
  });

  it('rejects a non-object schema', () => {
    expect(authorableJsonSchemaProblems('nope' as unknown).join(' ')).toMatch(/object/i);
  });
});

describe('jsonSchemaValueProblems — payload validation against the subset', () => {
  const schema = {
    type: 'object',
    properties: {
      severity: { type: 'string', enum: ['mild', 'severe'] },
      score: { type: 'integer', minimum: 0, maximum: 10 },
      tags: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      note: { type: 'string', maxLength: 5 },
    },
    required: ['severity'],
    additionalProperties: false,
  };

  it('accepts a conforming payload', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', score: 3, tags: ['a'] })).toEqual([]);
  });

  it('reports a missing required property', () => {
    expect(jsonSchemaValueProblems(schema, { score: 3 }).join(' ')).toMatch(/severity/);
  });

  it('reports a value outside an enum', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'catastrophic' }).join(' ')).toMatch(/enum/i);
  });

  it('reports a wrong type', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', score: 'three' }).join(' ')).toMatch(/integer/);
  });

  it('reports a numeric bound violation', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', score: 99 }).join(' ')).toMatch(/maximum/i);
  });

  it('reports a string length violation', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', note: 'far too long' }).join(' ')).toMatch(/maxLength/i);
  });

  it('reports an array length violation', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', tags: ['a', 'b', 'c', 'd'] }).join(' ')).toMatch(/maxItems/i);
  });

  it('rejects an undeclared property when additionalProperties is false', () => {
    expect(jsonSchemaValueProblems(schema, { severity: 'mild', smuggled: 1 }).join(' ')).toMatch(/smuggled/);
  });

  it('routes a discriminated oneOf to the matching branch and reports only that branch', () => {
    const union = {
      discriminator: { propertyName: 'kind' },
      oneOf: [
        { type: 'object', properties: { kind: { const: 'a' }, a: { type: 'string' } }, required: ['a'] },
        { type: 'object', properties: { kind: { const: 'b' }, b: { type: 'number' } }, required: ['b'] },
      ],
    };
    expect(jsonSchemaValueProblems(union, { kind: 'b', b: 1 })).toEqual([]);
    const problems = jsonSchemaValueProblems(union, { kind: 'b', b: 'not a number' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/\/b/);
  });

  it('treats an empty schema as accept-anything', () => {
    expect(jsonSchemaValueProblems({}, { anything: true })).toEqual([]);
  });
});
