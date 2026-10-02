/**
 * `schemaVariablePaths` — the ONE derivation of the prompt paths a context schema offers, shared
 * by the publish gate and the console's completion list.
 */
import { describe, expect, it } from 'vitest';
import { schemaVariablePaths } from '../index';

const definition = {
  schemaVersion: '1.0',
  kinds: [
    {
      key: 'patient',
      label: 'Patient',
      primitive: 'STRUCTURED',
      phiClass: 'PHI',
      cardinality: 'ONE',
      lifecycle: 'PRE',
      producedBy: 'CLIENT',
      required: true,
      description: 'The patient.',
      fields: {
        type: 'object',
        required: ['age'],
        properties: {
          age: { type: 'integer', description: 'Age in years.' },
          name: { type: ['string', 'null'] },
          legacy_id: { type: 'string', deprecated: true },
          tags: { type: 'array', items: { type: 'string' } },
          anything: {},
        },
      },
    },
    {
      key: 'case_note',
      label: 'Case note',
      primitive: 'TEXT',
      phiClass: 'NON_PHI',
      cardinality: 'MANY',
      lifecycle: 'ANY',
      producedBy: 'CLIENT',
      deprecated: { since: '2026-01-01' },
    },
  ],
  outputs: [{ key: 'note', label: 'Note', primitive: 'TEXT' }],
};

describe('schemaVariablePaths', () => {
  it('lists kinds and the declared fields of STRUCTURED kinds, sorted, ignoring outputs', () => {
    expect(schemaVariablePaths(definition, 'trigger')).toEqual([
      { path: 'trigger.case_note', type: 'TEXT', required: false, phiClass: 'NON_PHI', description: null, deprecated: true },
      { path: 'trigger.patient', type: 'STRUCTURED', required: true, phiClass: 'PHI', description: 'The patient.', deprecated: false },
      { path: 'trigger.patient.age', type: 'integer', required: true, phiClass: 'PHI', description: 'Age in years.', deprecated: false },
      { path: 'trigger.patient.anything', type: 'any', required: false, phiClass: 'PHI', description: null, deprecated: false },
      { path: 'trigger.patient.legacy_id', type: 'string', required: false, phiClass: 'PHI', description: null, deprecated: true },
      { path: 'trigger.patient.name', type: 'string|null', required: false, phiClass: 'PHI', description: null, deprecated: false },
      { path: 'trigger.patient.tags', type: 'array', required: false, phiClass: 'PHI', description: null, deprecated: false },
    ]);
  });

  it('defaults the root to `context`', () => {
    expect(schemaVariablePaths(definition).map((entry) => entry.path)[0]).toBe('context.case_note');
  });

  it('collapses the sole `context` kind under the `context` root, never under `trigger`', () => {
    const sole = {
      schemaVersion: '1.0',
      kinds: [
        {
          key: 'context',
          primitive: 'STRUCTURED',
          phiClass: 'PHI',
          fields: { type: 'object', properties: { safe_age: { type: 'string' }, visit_type: { type: 'string' } } },
        },
      ],
    };
    expect(schemaVariablePaths(sole, 'context').map((entry) => entry.path)).toEqual(['context.safe_age', 'context.visit_type']);
    expect(schemaVariablePaths(sole, 'trigger').map((entry) => entry.path)).toEqual([
      'trigger.context',
      'trigger.context.safe_age',
      'trigger.context.visit_type',
    ]);
  });

  it('does not collapse a single kind under another key', () => {
    const single = { kinds: [{ key: 'patient', primitive: 'STRUCTURED', phiClass: 'PHI', fields: { properties: { age: { type: 'integer' } } } }] };
    expect(schemaVariablePaths(single, 'context').map((entry) => entry.path)).toEqual(['context.patient', 'context.patient.age']);
  });

  it('reads an inline payload JSON Schema (a trigger authored inline) one level deep', () => {
    const inline = {
      type: 'object',
      required: ['a'],
      properties: { a: { type: 'object', properties: { b: { type: 'string' } } }, c: { type: 'number' } },
    };
    expect(schemaVariablePaths(inline, 'trigger')).toEqual([
      { path: 'trigger.a', type: 'object', required: true, phiClass: null, description: null, deprecated: false },
      { path: 'trigger.a.b', type: 'string', required: false, phiClass: null, description: null, deprecated: false },
      { path: 'trigger.c', type: 'number', required: false, phiClass: null, description: null, deprecated: false },
    ]);
  });

  it('is total: anything unreadable yields []', () => {
    expect(schemaVariablePaths(null)).toEqual([]);
    expect(schemaVariablePaths('nope')).toEqual([]);
    expect(schemaVariablePaths({ kinds: [null, { key: '' }, { primitive: 'TEXT' }] })).toEqual([]);
  });
});
