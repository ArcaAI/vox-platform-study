import { describe, it, expect } from 'vitest';
import { classifyDefinitionChange } from '../definition-diff';

function definition(kinds: Record<string, unknown>[], outputs?: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: '1.0', kinds, ...(outputs ? { outputs } : {}) };
}

const structuredKind = (fields: Record<string, unknown>, overrides: Record<string, unknown> = {}) => ({
  key: 'intake',
  label: 'Intake',
  primitive: 'STRUCTURED',
  phiClass: 'PHI',
  cardinality: 'ONE',
  lifecycle: 'PRE',
  producedBy: ['CLIENT'],
  fields,
  ...overrides,
});

describe('classifyDefinitionChange (TASK-658 AC-6)', () => {
  it('reports IDENTICAL for byte-equivalent definitions (key order ignored)', () => {
    const prev = definition([structuredKind({ type: 'object', properties: { a: { type: 'string' } } })]);
    const next = definition([structuredKind({ properties: { a: { type: 'string' } }, type: 'object' })]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('IDENTICAL');
  });

  it('ADDITIVE — a new OPTIONAL field does not require a breaking acknowledgement', () => {
    const prev = definition([structuredKind({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })]);
    const next = definition([
      structuredKind({ type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } }, required: ['a'] }),
    ]);
    const result = classifyDefinitionChange(prev, next);
    expect(result.classification).toBe('ADDITIVE');
    expect(result.breakingChanges).toEqual([]);
  });

  it('ADDITIVE — a brand-new kind', () => {
    const prev = definition([structuredKind({ type: 'object' })]);
    const next = definition([structuredKind({ type: 'object' }), { ...structuredKind({ type: 'object' }), key: 'referral' }]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('ADDITIVE');
  });

  it('BREAKING — a RENAMED field (removal + addition) requires an acknowledgement', () => {
    const prev = definition([structuredKind({ type: 'object', properties: { severity: { type: 'string' } } })]);
    const next = definition([structuredKind({ type: 'object', properties: { severityLevel: { type: 'string' } } })]);
    const result = classifyDefinitionChange(prev, next);
    expect(result.classification).toBe('BREAKING');
    expect(result.breakingChanges.join(' ')).toMatch(/severity/);
  });

  it('BREAKING — a renamed KIND key', () => {
    const prev = definition([structuredKind({ type: 'object' })]);
    const next = definition([structuredKind({ type: 'object' }, { key: 'intake_form' })]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('BREAKING');
  });

  it('BREAKING — a changed primitive', () => {
    const prev = definition([structuredKind({ type: 'object' })]);
    const next = definition([{ ...structuredKind({ type: 'object' }), primitive: 'TEXT', fields: undefined }]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('BREAKING');
  });

  it('BREAKING — a changed phiClass or cardinality', () => {
    const prev = definition([structuredKind({ type: 'object' })]);
    expect(
      classifyDefinitionChange(prev, definition([structuredKind({ type: 'object' }, { phiClass: 'NON_PHI' })])).classification,
    ).toBe('BREAKING');
    expect(
      classifyDefinitionChange(prev, definition([structuredKind({ type: 'object' }, { cardinality: 'MANY' })])).classification,
    ).toBe('BREAKING');
  });

  it('BREAKING — widening `required` on the kind itself', () => {
    const prev = definition([structuredKind({ type: 'object' }, { required: false })]);
    const next = definition([structuredKind({ type: 'object' }, { required: true })]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('BREAKING');
  });

  it('BREAKING — a newly REQUIRED property', () => {
    const prev = definition([structuredKind({ type: 'object', properties: { a: { type: 'string' } } })]);
    const next = definition([structuredKind({ type: 'object', properties: { a: { type: 'string' } }, required: ['a'] })]);
    const result = classifyDefinitionChange(prev, next);
    expect(result.classification).toBe('BREAKING');
    expect(result.breakingChanges.join(' ')).toMatch(/required/i);
  });

  it('BREAKING — a changed property type', () => {
    const prev = definition([structuredKind({ type: 'object', properties: { a: { type: 'string' } } })]);
    const next = definition([structuredKind({ type: 'object', properties: { a: { type: 'number' } } })]);
    expect(classifyDefinitionChange(prev, next).classification).toBe('BREAKING');
  });

  it('BREAKING — a removed output', () => {
    const prev = definition([structuredKind({ type: 'object' })], [{ key: 'soap_note', primitive: 'STRUCTURED' }]);
    const next = definition([structuredKind({ type: 'object' })], []);
    expect(classifyDefinitionChange(prev, next).classification).toBe('BREAKING');
  });

  it('treats a first publish (no previous definition) as ADDITIVE', () => {
    expect(classifyDefinitionChange(null, definition([structuredKind({ type: 'object' })])).classification).toBe('ADDITIVE');
  });
});
