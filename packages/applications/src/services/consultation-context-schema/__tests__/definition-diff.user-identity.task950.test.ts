/**
 * TASK-950 W0-b test 6 — editing the `userIdentity` marker is ADDITIVE, always.
 *
 * `definition-diff.ts` needs no code for this, and that is the POINT of the test rather than
 * an argument against it. The classifier asks one question — "can a client built against the
 * previous version keep working?" — and the marker changes nothing a client sends: it names
 * an already-declared property, so `payloadSchemaFromDefinition` is byte-identical with and
 * without it and every previously valid payload stays valid.
 *
 * So this file pins a NEGATIVE: adding, moving and removing the marker must never demand the
 * `allowBreakingChange` acknowledgement. Without it, a later change to the classifier could
 * quietly start blocking tenants from declaring an identity field, and nothing would say so.
 */
import { describe, expect, it } from 'vitest';
import { classifyDefinitionChange } from '../definition-diff';

function structuredKind(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: 'context',
    label: 'Consultation Context',
    primitive: 'STRUCTURED',
    phiClass: 'NON_PHI',
    cardinality: 'ONE',
    lifecycle: 'PRE',
    producedBy: ['CLIENT'],
    fields: { type: 'object', properties: { consultant_id: { type: 'string' }, nurse_id: { type: 'string' } } },
    ...overrides,
  };
}

function definition(...kinds: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: '1.0', kinds };
}

describe('classifyDefinitionChange — the userIdentity marker (test 6)', () => {
  it('ADDITIVE — ADDING the marker to a kind that had none', () => {
    const result = classifyDefinitionChange(definition(structuredKind()), definition(structuredKind({ userIdentity: { field: 'consultant_id' } })));

    expect(result.classification).toBe('ADDITIVE');
    expect(result.breakingChanges).toEqual([]);
  });

  it('ADDITIVE — MOVING the marker to another property of the same kind', () => {
    const result = classifyDefinitionChange(
      definition(structuredKind({ userIdentity: { field: 'consultant_id' } })),
      definition(structuredKind({ userIdentity: { field: 'nurse_id' } })),
    );

    expect(result.classification).toBe('ADDITIVE');
    expect(result.breakingChanges).toEqual([]);
  });

  it('ADDITIVE — MOVING the marker to a different KIND', () => {
    const other = structuredKind({ key: 'intake', label: 'Intake' });
    const result = classifyDefinitionChange(
      definition(structuredKind({ userIdentity: { field: 'consultant_id' } }), other),
      definition(structuredKind(), { ...other, userIdentity: { field: 'consultant_id' } }),
    );

    expect(result.classification).toBe('ADDITIVE');
    expect(result.breakingChanges).toEqual([]);
  });

  it('ADDITIVE — REMOVING the marker; the property itself survives, so no client breaks', () => {
    const result = classifyDefinitionChange(definition(structuredKind({ userIdentity: { field: 'consultant_id' } })), definition(structuredKind()));

    expect(result.classification).toBe('ADDITIVE');
    expect(result.breakingChanges).toEqual([]);
  });

  it('IDENTICAL — an unchanged marker is still not a new version', () => {
    const marked = () => definition(structuredKind({ userIdentity: { field: 'consultant_id' } }));

    expect(classifyDefinitionChange(marked(), marked()).classification).toBe('IDENTICAL');
  });

  it('still BREAKING when the marked PROPERTY is removed — the marker never masks a real break', () => {
    const next = structuredKind({
      fields: { type: 'object', properties: { nurse_id: { type: 'string' } } },
      userIdentity: { field: 'nurse_id' },
    });
    const result = classifyDefinitionChange(definition(structuredKind({ userIdentity: { field: 'consultant_id' } })), definition(next));

    expect(result.classification).toBe('BREAKING');
    expect(result.breakingChanges.join(' ')).toMatch(/consultant_id/);
  });
});
