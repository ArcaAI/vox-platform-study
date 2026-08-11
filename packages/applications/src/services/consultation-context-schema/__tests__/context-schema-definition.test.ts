import { describe, it, expect } from 'vitest';
import { CONTEXT_PRIMITIVES, computeDefinitionChecksum, contextSchemaDefinitionProblems, findKind } from '../context-schema-definition';

/** Minimal valid definition — one TEXT kind, no outputs. */
function baseDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    kinds: [
      {
        key: 'case_note',
        label: 'Case Note',
        primitive: 'TEXT',
        phiClass: 'PHI',
        cardinality: 'MANY',
        lifecycle: 'ANY',
        producedBy: ['CLIENT'],
      },
    ],
    ...overrides,
  };
}

describe('contextSchemaDefinitionProblems (TASK-658 AC-3)', () => {
  it('accepts a minimal valid definition', () => {
    expect(contextSchemaDefinitionProblems(baseDefinition())).toEqual([]);
  });

  it('exposes exactly the five platform primitives', () => {
    expect([...CONTEXT_PRIMITIVES]).toEqual(['STREAM_AUDIO', 'TEXT', 'DOCUMENT', 'IMAGE', 'STRUCTURED']);
  });

  it('REJECTS a kind declaring a primitive outside the closed set', () => {
    const definition = baseDefinition({
      kinds: [{ ...(baseDefinition().kinds as Record<string, unknown>[])[0], primitive: 'VIDEO' }],
    });
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/primitive/i);
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/VIDEO/);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(contextSchemaDefinitionProblems(baseDefinition({ schemaVersion: '2.0' })).join(' ')).toMatch(/schemaVersion/);
  });

  it('rejects an empty kinds array', () => {
    expect(contextSchemaDefinitionProblems(baseDefinition({ kinds: [] })).join(' ')).toMatch(/at least one kind/i);
  });

  it('rejects a key that breaks the [a-z0-9_]{2,48} grammar', () => {
    const definition = baseDefinition({
      kinds: [{ ...(baseDefinition().kinds as Record<string, unknown>[])[0], key: 'Case-Note' }],
    });
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/key/i);
  });

  it('rejects duplicate kind keys', () => {
    const kind = (baseDefinition().kinds as Record<string, unknown>[])[0];
    expect(contextSchemaDefinitionProblems(baseDefinition({ kinds: [kind, { ...kind }] })).join(' ')).toMatch(/duplicate/i);
  });

  it('rejects an unknown key inside a kind (fail-closed, mirrors forbidNonWhitelisted)', () => {
    const definition = baseDefinition({
      kinds: [{ ...(baseDefinition().kinds as Record<string, unknown>[])[0], smuggled: true }],
    });
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/smuggled/);
  });

  it('rejects an unknown top-level key', () => {
    expect(contextSchemaDefinitionProblems(baseDefinition({ extra: 1 })).join(' ')).toMatch(/extra/);
  });

  it('requires `fields` on a STRUCTURED kind', () => {
    const definition = baseDefinition({
      kinds: [{ ...(baseDefinition().kinds as Record<string, unknown>[])[0], primitive: 'STRUCTURED' }],
    });
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/fields/i);
  });

  it('propagates authorable-subset problems from `fields`', () => {
    const definition = baseDefinition({
      kinds: [
        {
          ...(baseDefinition().kinds as Record<string, unknown>[])[0],
          primitive: 'STRUCTURED',
          fields: { type: 'object', if: { const: 1 } },
        },
      ],
    });
    expect(contextSchemaDefinitionProblems(definition).join(' ')).toMatch(/is not authorable/i);
  });

  it('validates outputs with the same grammar as kinds', () => {
    expect(
      contextSchemaDefinitionProblems(baseDefinition({ outputs: [{ key: 'soap_note', primitive: 'STRUCTURED', fields: { type: 'object' } }] })),
    ).toEqual([]);
    expect(contextSchemaDefinitionProblems(baseDefinition({ outputs: [{ key: 'soap note', primitive: 'STRUCTURED' }] })).join(' ')).toMatch(/key/i);
  });

  it('rejects a non-object definition', () => {
    expect(contextSchemaDefinitionProblems(null).join(' ')).toMatch(/object/i);
    expect(contextSchemaDefinitionProblems([]).join(' ')).toMatch(/object/i);
  });
});

describe('computeDefinitionChecksum', () => {
  it('is stable under key ORDER (canonical JSON) so a reformat is not a new version', () => {
    const a = { schemaVersion: '1.0', kinds: [{ key: 'a', label: 'A' }] };
    const b = { kinds: [{ label: 'A', key: 'a' }], schemaVersion: '1.0' };
    expect(computeDefinitionChecksum(a)).toEqual(computeDefinitionChecksum(b));
  });

  it('changes when any value changes', () => {
    expect(computeDefinitionChecksum({ a: 1 })).not.toEqual(computeDefinitionChecksum({ a: 2 }));
  });

  it('is order-SENSITIVE for arrays (kind order is meaningful)', () => {
    expect(computeDefinitionChecksum({ k: [1, 2] })).not.toEqual(computeDefinitionChecksum({ k: [2, 1] }));
  });
});

describe('findKind', () => {
  it('finds a declared kind by key and returns undefined otherwise', () => {
    expect(findKind(baseDefinition(), 'case_note')?.primitive).toBe('TEXT');
    expect(findKind(baseDefinition(), 'nope')).toBeUndefined();
  });
});
