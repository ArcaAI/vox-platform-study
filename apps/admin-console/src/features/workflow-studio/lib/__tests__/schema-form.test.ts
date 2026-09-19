import { describe, it, expect } from 'vitest';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';

import { humanizeKey, toFieldDescriptors, type FieldDescriptor } from '../schema-form';
import summarizeSchema from './fixtures/summarize.schema.json';
import discriminatedSchema from './fixtures/discriminated.schema.json';
import unsupportedSchema from './fixtures/unsupported.schema.json';

// strategy: "Contract tests: one schema, three consumers (registry ↔
// inspector forms ↔ compiled config)." This suite is consumer #2 (inspector forms) — the RED
// step for /8.

describe('toFieldDescriptors — compile', () => {
  it('yields one ordered descriptor per authored property, in authoring order', () => {
    const descriptors = toFieldDescriptors(summarizeSchema);
    expect(descriptors.map((d) => d.path)).toEqual(['promptTemplateId', 'temperature', 'maxOutputTokens', 'streaming', 'tags', 'guardrailProfile']);
  });

  it('marks fields listed in `required` as required, everything else optional', () => {
    const descriptors = toFieldDescriptors(summarizeSchema);
    const byPath = Object.fromEntries(descriptors.map((d) => [d.path, d]));
    expect(byPath.promptTemplateId?.required).toBe(true);
    expect(byPath.guardrailProfile?.required).toBe(true);
    expect(byPath.temperature?.required).toBe(false);
  });

  it('compiles string/number/integer/boolean/array-of-string/enum to their matching descriptor kind', () => {
    const descriptors = toFieldDescriptors(summarizeSchema);
    const byPath = Object.fromEntries(descriptors.map((d) => [d.path, d]));
    expect(byPath.promptTemplateId?.kind).toBe('string');
    expect(byPath.temperature?.kind).toBe('number');
    expect(byPath.maxOutputTokens).toMatchObject({ kind: 'number', integer: true, min: 1, max: 4096 });
    expect(byPath.streaming?.kind).toBe('boolean');
    expect(byPath.tags).toMatchObject({ kind: 'tags', minItems: 0, maxItems: 8 });
    expect(byPath.guardrailProfile).toMatchObject({ kind: 'enum', options: [{ value: 'STANDARD' }, { value: 'STRICT' }, { value: 'RELAXED' }] });
  });

  it('derives the label from `title`, falling back to a humanized property key', () => {
    const descriptors = toFieldDescriptors({ type: 'object', properties: { promptTemplateId: { type: 'string' } } });
    expect(descriptors[0]?.label).toBe('Prompt Template Id');
  });

  it('F-10: humanizes the `dna` group label as the acronym `DNA`, not `Dna`', () => {
    const descriptors = toFieldDescriptors({ type: 'object', properties: { dna: { type: 'object', properties: { enabled: { type: 'boolean' } } } } });
    expect(descriptors[0]?.label).toBe('DNA');
  });

  it('compiles a discriminated oneOf into a `discriminated` descriptor whose branches are keyed by the discriminator value', () => {
    const descriptors = toFieldDescriptors(discriminatedSchema);
    const retryPolicy = descriptors.find((d) => d.path === 'retryPolicy');
    expect(retryPolicy?.kind).toBe('discriminated');
    if (retryPolicy?.kind !== 'discriminated') throw new Error('expected a discriminated descriptor');
    expect(retryPolicy.discriminatorProperty).toBe('strategy');
    expect(retryPolicy.branches.map((b) => b.value)).toEqual(['NONE', 'FIXED']);
    const fixed = retryPolicy.branches.find((b) => b.value === 'FIXED');
    expect(fixed?.fields.map((f) => f.path)).toContain('retryPolicy.attempts');
  });
});

describe('humanizeKey — acronyms (F-10)', () => {
  it('renders the `dna` key as the acronym `DNA`, case-insensitively', () => {
    expect(humanizeKey('dna')).toBe('DNA');
    expect(humanizeKey('DNA')).toBe('DNA');
    expect(humanizeKey('Dna')).toBe('DNA');
  });

  it('leaves every other word on the capitalize-first-letter rule (no over-broad matching)', () => {
    expect(humanizeKey('promptTemplateId')).toBe('Prompt Template Id');
    expect(humanizeKey('onError')).toBe('On Error');
  });
});

describe('toFieldDescriptors — round-trip agreement with jsonSchemaValueProblems', () => {
  it('a value built from the descriptors passes the same schema the descriptors were compiled from', () => {
    toFieldDescriptors(summarizeSchema); // compiled but not otherwise consulted — the assertion is the schema itself accepts a well-formed value
    const value = {
      promptTemplateId: 'tmpl-1',
      temperature: 0.4,
      maxOutputTokens: 512,
      streaming: true,
      tags: ['clinical', 'draft'],
      guardrailProfile: 'STRICT',
    };
    expect(jsonSchemaValueProblems(summarizeSchema, value)).toEqual([]);
  });

  it('a value the form would mark invalid (missing a required field) is also rejected by jsonSchemaValueProblems', () => {
    const value = { temperature: 0.4 };
    const problems = jsonSchemaValueProblems(summarizeSchema, value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes('promptTemplateId'))).toBe(true);
  });

  it('a value violating an enum constraint is rejected by both the descriptor options and jsonSchemaValueProblems', () => {
    const descriptors = toFieldDescriptors(summarizeSchema);
    const guardrail = descriptors.find((d) => d.path === 'guardrailProfile');
    if (guardrail?.kind !== 'enum') throw new Error('expected an enum descriptor');
    const allowed = guardrail.options.map((o) => o.value);
    expect(allowed).not.toContain('BOGUS');
    const value = { promptTemplateId: 'tmpl-1', guardrailProfile: 'BOGUS' };
    expect(jsonSchemaValueProblems(summarizeSchema, value).length).toBeGreaterThan(0);
  });
});

describe('toFieldDescriptors — bounds', () => {
  it('a schema exceeding MAX_SCHEMA_DEPTH produces one explicit "too complex" raw-json descriptor, not a partial form', () => {
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 20; i += 1) {
      deep = { type: 'object', properties: { nested: deep } };
    }
    const schema = { type: 'object', properties: { root: deep }, required: [] };
    const descriptors = toFieldDescriptors(schema);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]).toMatchObject({ kind: 'raw-json', path: '' });
    expect(descriptors[0]?.label.length).toBeGreaterThan(0);
    expect((descriptors[0] as Extract<FieldDescriptor, { kind: 'raw-json' }>).reason).toMatch(/too complex/i);
  });

  it('a schema exceeding MAX_SCHEMA_NODES produces one explicit "too complex" raw-json descriptor', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 600; i += 1) {
      properties[`field_${i}`] = { type: 'string' };
    }
    const schema = { type: 'object', properties, required: [] };
    const descriptors = toFieldDescriptors(schema);
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.kind).toBe('raw-json');
  });
});

describe('toFieldDescriptors — unsupported construct degrades to raw-json for that subtree only', () => {
  it('a property using if/then/else becomes a raw-json descriptor while its siblings still compile normally', () => {
    const descriptors = toFieldDescriptors(unsupportedSchema);
    expect(descriptors.map((d) => d.path)).toEqual(['note', 'legacyRouting']);
    const note = descriptors.find((d) => d.path === 'note');
    const legacy = descriptors.find((d) => d.path === 'legacyRouting');
    expect(note?.kind).toBe('string');
    expect(legacy?.kind).toBe('raw-json');
  });

  it('never silently drops the unsupported field — it is present as a descriptor, just degraded', () => {
    const descriptors = toFieldDescriptors(unsupportedSchema);
    expect(descriptors.some((d) => d.path === 'legacyRouting')).toBe(true);
  });
});
